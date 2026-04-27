# PRD: Unified Persistent Memory & Timeline Search

## Problem

Two distinct failures after compaction:

1. **Search gap**: `ctx_search` only queries ephemeral ContentStore — never checks SessionDB (persistent) or auto-memory. "What was my first prompt?" returns nothing.

2. **Injection gap**: Skills, roles, and decisions ARE captured in SessionDB but re-injected as weak informational text after compaction. The LLM treats them as history, not active directives. Users must re-initialize skills and re-state preferences after every compaction.

## Solution

Two pillars + static reinforcement:

### Pillar 1: Unified Timeline Search

`ctx_search` gains a `sort` parameter. Default `"relevance"` preserves current behavior. New `"timeline"` mode searches 3 sources chronologically.

```
sort="relevance" (default)
    +-- ContentStore only (current behavior, BM25 ranked)

sort="timeline"
    |-- 1. ContentStore (current session)
    |-- 2. SessionDB events (prior sessions, 7d TTL)
    +-- 3. Auto-memory (~/.claude/.../memory/*.md)
    -> MERGE -> ORDER BY timestamp ASC -> return
```

### Pillar 2: Auto-Injection on Compaction

On `SessionStart(source: "compact")`, critical state is automatically injected as behavioral directives — not informational summaries.

```
SessionStart(source: "compact")
  -> buildSessionDirective()     (existing, ~275 tokens)
  -> buildAutoInjection()        (NEW, ~500 tokens)
  -> additionalContext = both    (~775 tokens total)
```

Only triggers on compaction. `--continue` loads full conversation history — no injection needed. No mid-session injection — context-mode does not pollute the context it protects.

### Static Reinforcement (~99 tokens, session start only)

One-time text in adapter configs and routing block. Never repeats, never accumulates.

| Surface | Tokens | Content |
|---------|--------|---------|
| Adapter .md files (12) | ~40 | "Session Continuity" section — skills, roles, decisions persist for entire session |
| Routing block | ~30 | `<session_continuity>` tag — do not drop behavioral directives as context grows |
| ctx_search tool description | ~29 | "SESSION STATE: skills, roles, decisions set earlier are still active" |

---

## Bug Fixes (immediate, pre-Phase 1)

Three bugs discovered by Round 4 review that cause current data loss:

### Bug 1 (Critical): `role` missing from snapshot builder

**File**: `src/session/snapshot.ts:412`
**Problem**: Switch statement handles 11 categories but `case "role"` is absent. Role events (persona directives like "act as senior engineer") are captured in SessionDB but silently dropped during snapshot building. The word "role" appears zero times in snapshot.ts.
**Fix**:
```typescript
// snapshot.ts switch statement, add:
case "role": roleEvents.push(ev); break;

// Add buildRolesSection() function
```

### Bug 2 (High): Skill extractor captures name only

**File**: `src/session/extract.ts:399-406`
**Problem**: `extractSkill()` captures `input.tool_input["skill"]` (just the name string, e.g., `"cloudflare"`). The `tool_response` containing the actual skill instructions (often 1000+ tokens) is never stored. After compaction, the system knows "cloudflare was invoked" but cannot reconstruct what the skill does.
**Fix**:
```typescript
function extractSkill(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Skill") return [];
  const skillName = String(input.tool_input["skill"] ?? "");
  // Capture skill name for re-invocation instruction
  // tool_response is too large to store — name is sufficient for re-load directive
  return [{ type: "skill", category: "skill", data: safeString(skillName), priority: 2 }];
  //                                                                        ^^^ P2 (was P3)
}
```
Note: Storing full skill content is impractical (1000+ tokens per skill). The fix is to promote skills to P2 priority AND use auto-injection to tell the LLM to re-invoke the Skill tool.

### Bug 3 (Medium): Pi extension drops P3 events

**File**: `src/pi-extension.ts:287`
**Problem**: `minPriority: 2` filter excludes all P3 events (skills, roles, git, errors, MCP, cwd) from active memory injection.
**Fix**: Promote critical P3 categories to P2 (skill, role) or lower the threshold to `minPriority: 3`.

### Dead Code: Snapshot XML built but discarded

**Files**: `hooks/precompact.mjs` (builds snapshot), `hooks/sessionstart.mjs:47-51` (fetches, marks consumed, discards)
**Problem**: `precompact.mjs` builds a detailed XML snapshot with skills, decisions, search queries. `sessionstart.mjs` fetches it, marks it consumed, then throws it away — never injects it.
**Fix**: Either use the snapshot in auto-injection, or remove the dead code to avoid confusion.

---

## Auto-Injection Design

### Trigger

Only on `SessionStart(source: "compact")` — context was compacted, LLM lost memory.

NOT on:
- `source: "init"` — fresh session, no prior state
- `source: "continue"` — full conversation history loaded, no loss

### What Gets Auto-Injected

| Category | Token Budget | Max Items | Format | Priority |
|----------|-------------|-----------|--------|----------|
| `role` | 150 tokens | 1 (latest) | `<behavioral_directive>` | P1 — must be first |
| `decision` | 200 tokens | 5 (latest) | `<rules>` — "YOU MUST follow:" | P2 |
| `skill` | 50 tokens | 10 names | "Active skills — re-invoke if relevant: X, Y, Z" | P3 |
| `intent` | 20 tokens | 1 (latest) | "Session mode: implement" | P4 |
| **Total** | **~420 tokens** | | | Hard cap: 500 tokens |

### Injection Format

```xml
<session_state source="compaction">

<behavioral_directive>
You are acting as a senior engineer. Apply staff-level code review standards.
</behavioral_directive>

<rules>
Follow these decisions from the current session:
- DO NOT use mocks in integration tests
- Always push to next branch, never feature branches
- Use ctx_search instead of bare search()
</rules>

<active_skills>
Re-invoke if relevant: cloudflare, hono, tdd
To reload: call the Skill tool with the skill name.
</active_skills>

<session_mode>implement</session_mode>

</session_state>
```

### Why Directive Format, Not Narrative

| Format | LLM Compliance |
|--------|----------------|
| "Last time you acted as a senior engineer" (narrative) | Low — LLM treats as history |
| `<behavioral_directive>You ARE a senior engineer</behavioral_directive>` | High — LLM treats as active instruction |
| "User said don't use mocks" (history) | Low — LLM may or may not follow |
| `<rules>DO NOT use mocks</rules>` | High — rule format triggers compliance |

### Overflow Strategy

If total exceeds 500 tokens:
1. Truncate oldest decisions (keep latest 3 instead of 5)
2. Truncate skill list (keep latest 5 instead of 10)
3. Drop intent (20 tokens, lowest value)
4. Never truncate role (always injected in full, max 150 tokens)

### Implementation

```typescript
// hooks/sessionstart.mjs — add to compact branch
function buildAutoInjection(db, sessionId) {
  const events = db.getEvents(sessionId);
  const parts = [];
  let budget = 500;

  // P1: Role (always first)
  const roleEvent = events.filter(e => e.category === "role").pop(); // latest
  if (roleEvent) {
    const roleText = `<behavioral_directive>\n${roleEvent.data.slice(0, 400)}\n</behavioral_directive>`;
    parts.push(roleText);
    budget -= estimateTokens(roleText);
  }

  // P2: Decisions
  const decisions = events.filter(e => e.category === "decision").slice(-5);
  if (decisions.length > 0) {
    const lines = decisions.map(d => `- ${d.data.slice(0, 100)}`).join("\n");
    const decText = `<rules>\nFollow these decisions:\n${lines}\n</rules>`;
    if (estimateTokens(decText) <= budget) {
      parts.push(decText);
      budget -= estimateTokens(decText);
    }
  }

  // P3: Skills
  const skills = [...new Set(events.filter(e => e.category === "skill").map(e => e.data))];
  if (skills.length > 0) {
    const skillText = `<active_skills>\nRe-invoke if relevant: ${skills.slice(-10).join(", ")}\nTo reload: call the Skill tool.\n</active_skills>`;
    if (estimateTokens(skillText) <= budget) {
      parts.push(skillText);
      budget -= estimateTokens(skillText);
    }
  }

  // P4: Intent
  const intentEvent = events.filter(e => e.category === "intent").pop();
  if (intentEvent && budget > 20) {
    parts.push(`<session_mode>${intentEvent.data}</session_mode>`);
  }

  return parts.length > 0
    ? `<session_state source="compaction">\n${parts.join("\n\n")}\n</session_state>`
    : "";
}
```

---

## Pillar 1: Unified Timeline Search

### Result Format

```
-- Current Session ------------------------------------
[19:00 | #42] user-prompt: "launch context-mode-ops agent army"
[18:30 | #38] decision: "process.cwd() fallback matches codebase convention"

-- Prior Session (2026-04-27 14:00) -------------------
[14:02 | #3]  compaction: "platform dashboard built, RBAC fixed, seed data created"
[14:00 | #1]  user-prompt: "read all files and index everything"

-- Auto Memory ----------------------------------------
[2026-04-25]  project: "analytics must be separate project, Datadog model"
[2026-04-20]  feedback: "always push to next branch, never feature branches"
```

### Data Sources

| # | Source | Location | TTL | Searched in |
|---|--------|----------|-----|-------------|
| 1 | **ContentStore** | `/tmp/context-mode-<PID>.db` | Process (ephemeral) | relevance + timeline |
| 2 | **SessionDB** | `~/<configDir>/context-mode/sessions/<hash>.db` | 7 days | timeline only |
| 3 | **Auto-memory** | `~/<configDir>/projects/<dashPath>/memory/*.md` | Permanent | timeline only |

### Search Implementation

```typescript
function searchAllSources(query, limit, source, contentType, sort) {
  const results = [];

  // Source 1: ContentStore (always)
  try {
    results.push(...store.searchWithFallback(query, limit, source, contentType)
      .map(r => ({ ...r, origin: "current-session" })));
  } catch { /* log, continue */ }

  // Sources 2+3: timeline mode only
  if (sort === "timeline") {
    // Source 2: SessionDB (scoped to project)
    try {
      const db = getSessionDB();
      if (db) {
        results.push(...db.searchEvents(query, limit, getProjectDir(), source)
          .map(r => ({ ...r, origin: "prior-session", timestamp: r.created_at })));
      }
    } catch { /* log, continue */ }

    // Source 3: Auto-memory (adapter-aware path)
    try {
      results.push(...searchAutoMemory(query, limit)
        .map(r => ({ ...r, origin: "auto-memory" })));
    } catch { /* log, continue */ }
  }

  if (sort === "timeline") {
    results.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  return results.slice(0, limit);
}
```

### SessionDB.searchEvents

```sql
SELECT id, session_id, category, type, data, created_at
FROM session_events
WHERE project_dir = ?
  AND (data LIKE '%' || ? || '%' OR category LIKE '%' || ? || '%')
  AND (? IS NULL OR category = ?)
ORDER BY id ASC
LIMIT ?
```

### Auto-memory Search

```typescript
const MAX_MEMORY_FILES = 50;

function getAutoMemoryDir(): string | null {
  const projectDir = getProjectDir();
  if (!projectDir) return null;
  // Claude path format: /Users/foo/project -> -Users-foo-project
  const dashPath = "-" + projectDir.replace(/^\//, "").replace(/\//g, "-");
  const configDir = resolveConfigDir(adapterOpts);
  const memDir = path.join(os.homedir(), configDir, "projects", dashPath, "memory");
  if (!fs.existsSync(memDir)) return null;
  return memDir;
}
```

### Schema Changes

**SessionDB**: NO CHANGES. Only new category values.

**ContentStore FTS5** (ephemeral): DROP + CREATE with 4 new UNINDEXED columns:

```sql
CREATE VIRTUAL TABLE chunks USING fts5(
  title, content,
  source_id UNINDEXED, content_type UNINDEXED,
  source_category UNINDEXED, session_id UNINDEXED,
  event_id UNINDEXED, timestamp UNINDEXED,
  tokenize='porter unicode61'
);
```

---

## Categories

### Existing — 15 (unchanged)

| # | Category | Hook | Description |
|---|----------|------|-------------|
| 1-15 | file, rule, cwd, error, git, task, plan, env, skill, subagent, mcp, decision, role, intent, data | Various | See existing extract.ts |

### New — Phase 1 (6 categories)

| # | Category | Hook | Description |
|---|----------|------|-------------|
| 16 | `user-prompt` | UserPromptSubmit | Every user message, ordered |
| 17 | `compaction` | PreCompact | Summary + handoff + overflow (3 types) |
| 18 | `rejected-approach` | PreToolUse | Denied/modified approaches |
| 19 | `session-resume` | SessionStart | Resume proof |
| 20 | `constraint` | PostToolUse | Discovered limitations |
| 21 | `knowledge-reuse` | MCP server | Prior session search hit (ROI metric) |

### New — Phase 2 (7 categories)

| # | Category | Hook | Description |
|---|----------|------|-------------|
| 22-28 | agent-finding, error-resolution, external-ref, blocked-on, iteration-loop, latency, permission | Various | Correlation logic required |

### Merged: 5 into existing. Dropped: 14 (see prior sections).

---

## Adapter Configs

### MEMORY Section — 4 Tiers

**Tier 1** (Claude Code, Qwen Code, OpenClaw — all hooks):
```markdown
## Memory
Session history is persistent and searchable. On resume, search BEFORE asking the user:
| Need | Command |
|------|---------|
| What were we working on? | `ctx_search(queries: ["summary"], source: "compaction", sort: "timeline")` |
| What was the first request? | `ctx_search(queries: ["prompt"], source: "user-prompt", sort: "timeline")` |
| What did we decide? | `ctx_search(queries: ["decision"], source: "decision", sort: "timeline")` |
| What NOT to repeat? | `ctx_search(queries: ["rejected"], source: "rejected-approach")` |
| What constraints exist? | `ctx_search(queries: ["constraint"], source: "constraint")` |
DO NOT ask "what were we working on?" — SEARCH FIRST.
If search returns 0 results, proceed as a fresh session.
```

**Tier 2** (Gemini, VS Code, JetBrains — no UserPromptSubmit): Same without user-prompt row.
**Tier 3** (Cursor, OpenCode/Kilo, Kiro — PostToolUse only): decision + constraint only.
**Tier 4** (Zed, Antigravity — no hooks): No MEMORY section.

### Tool Hierarchy

```
0. MEMORY: ctx_search(sort: "timeline") — after resume, check prior context
1. GATHER: ctx_batch_execute
2. FOLLOW-UP: ctx_search (default relevance mode)
3. PROCESSING: ctx_execute
4. WEB: ctx_fetch_and_index
```

---

## File Changes

### Immediate — Bug Fixes

| File | Change |
|------|--------|
| `src/session/snapshot.ts` | Add `case "role"` to switch + `buildRolesSection()` |
| `src/session/extract.ts` | Promote skill priority P3 -> P2 |
| `src/pi-extension.ts` | Lower minPriority filter or promote critical P3s |
| `hooks/sessionstart.mjs` | Remove dead snapshot fetch-and-discard code, or use the snapshot |

### Phase 1 — Unified Search + Auto-Injection

| File | Change |
|------|--------|
| `src/server.ts` | ctx_search: add `sort` param, `searchAllSources()`, auto-memory search, empty-index guard |
| `src/store.ts` | FTS5 chunks: 3-state schema detection + DROP+CREATE |
| `src/session/db.ts` | Add `searchEvents()` with project_dir filter + LIKE escaping |
| `src/session/extract.ts` | 5 new extractors (user-prompt, compaction, rejected-approach, session-resume, constraint) |
| `hooks/sessionstart.mjs` | Add `buildAutoInjection()` for compact source. Inject MEMORY directive. |
| `hooks/precompact.mjs` | Write `compaction` events |
| `hooks/pretooluse.mjs` | Write `rejected-approach` events |
| `hooks/userpromptsubmit.mjs` | Write `user-prompt` events |
| `hooks/routing-block.mjs` | Add `0. MEMORY` to hierarchy. Tier-aware MEMORY section. |
| `configs/*` (12 files) | +MEMORY section per tier |

---

## Numbers

| Metric | Value |
|--------|-------|
| Total categories | **28** (15 existing + 13 new) |
| Bug fixes | 3 (immediate) |
| Auto-injection token budget | ~500 tokens (on compact only) |
| Total injected on compact | ~775 tokens (directive + auto-injection) |
| Context overhead | <0.4% of 200K window |
| SessionDB changes | 0 new columns |
| Adapter config updates | 12 files |

---

## P0 Requirements (all resolved)

| # | Requirement | Solution |
|---|-------------|----------|
| 1 | Tool param sanitization | Tool name + param keys only |
| 2 | Timeline ordering | `session_events.id ASC` (monotonic) |
| 3 | Score normalization | `relevance` = single source, `timeline` = timestamp sort |
| 4 | Cross-project leak | `project_dir = ?` filter in searchEvents |
| 5 | Auto-memory path | Dash-separated, adapter-aware, existsSync guard |
| 6 | SEARCH FIRST fallback | "0 results -> fresh session" |
| 7 | Hookless adapter | 4-tier MEMORY sections |
| 8 | Error isolation | try/catch per source |
| 9 | Role event survival | Bug fix: add to snapshot.ts switch |
| 10 | Skill re-activation | Auto-injection: "re-invoke if relevant" directive |
| 11 | Decision enforcement | Auto-injection: `<rules>` format, not bullet list |

---

## Phase Plan

| Phase | Scope | Duration |
|-------|-------|----------|
| **Bug Fixes** | snapshot.ts role, skill priority, pi-extension filter, dead code | 2 days |
| **Phase 1** | Pillar 1 (unified search) + Pillar 2 (auto-injection) + static reinforcement + 6 categories + 12 adapter configs + MEMORY directive | 2 weeks |
| **Phase 2** | 7 categories: agent-finding, error-resolution, external-ref, blocked-on, iteration-loop, latency (cross-hook), permission | 2 weeks |
| **Total** | | ~5 weeks |

---

## Test Plan (TDD — mandatory)

All implementation MUST use the /tdd skill with red-green-refactor.

### Pillar 1: Unified Search

| Test | File | Description |
|------|------|-------------|
| searchAllSources returns ContentStore only in relevance mode | tests/search/unified.test.ts | Default sort="relevance" must NOT query SessionDB or auto-memory |
| searchAllSources merges 3 sources in timeline mode | tests/search/unified.test.ts | sort="timeline" returns tagged results from all 3 sources, chronological |
| SessionDB.searchEvents scopes by project_dir | tests/session/search-events.test.ts | Results from other projects never returned |
| SessionDB.searchEvents escapes LIKE wildcards | tests/session/search-events.test.ts | Query containing `%` or `_` doesn't break |
| Auto-memory search returns empty for non-existent dir | tests/search/auto-memory.test.ts | existsSync guard works |
| Auto-memory path uses adapter-aware configDir | tests/search/auto-memory.test.ts | Different adapters resolve different paths |
| Timeline results sorted chronologically | tests/search/unified.test.ts | Oldest first, across all sources |
| Error in one source doesn't break others | tests/search/unified.test.ts | SessionDB throws -> ContentStore results still returned |
| Empty index guard skipped in timeline mode | tests/search/unified.test.ts | sort="timeline" works even with 0 ContentStore chunks |

### Pillar 2: Auto-Injection

| Test | File | Description |
|------|------|-------------|
| buildAutoInjection returns empty for non-compact | tests/hooks/auto-injection.test.ts | Only fires on source="compact" |
| buildAutoInjection includes role as behavioral_directive | tests/hooks/auto-injection.test.ts | `<behavioral_directive>` tag wraps role text |
| buildAutoInjection includes decisions as rules | tests/hooks/auto-injection.test.ts | `<rules>` tag wraps decision list |
| buildAutoInjection includes skill names | tests/hooks/auto-injection.test.ts | `<active_skills>` with re-invoke instruction |
| Token budget hard cap at 500 | tests/hooks/auto-injection.test.ts | Overflow: truncate decisions first, never truncate role |
| Multi-compaction: events between compactions captured | tests/hooks/auto-injection.test.ts | Second compact includes events from after first compact |

### Bug Fixes

| Test | File | Description |
|------|------|-------------|
| Role events survive snapshot building | tests/session/snapshot.test.ts | `case "role"` in switch, buildRolesSection() works |
| Skill priority promoted to P2 | tests/session/extract.test.ts | Skill events have priority 2, not 3 |

---

## Success Metrics

| Metric | Baseline | Target | Measurement |
|--------|----------|--------|-------------|
| Skill compliance after compaction | ~0% (skills die) | >80% | Count skill-consistent tool calls post-compact vs pre-compact |
| Decision adherence post-compact | Unknown | >90% | Track rule violations (e.g., user said "no mocks" but mocks appear) |
| Resume-to-productive latency | ~5 exchanges (user re-explains) | <2 exchanges | Count exchanges between session-resume and first productive tool call |
| knowledge-reuse hit rate | 0 | >60% of resumed sessions | Percentage of resumes with at least 1 knowledge-reuse event |
| Auto-injection latency | N/A | <50ms | Measure buildAutoInjection() execution time |
| Timeline search precision | N/A | >70% | Manual evaluation of top-5 results relevance |

---

## Rollback Plan

| Pillar | Rollback | Trigger |
|--------|----------|---------|
| Pillar 1 (search) | Remove `sort: "timeline"` from inputSchema. ctx_search falls back to relevance-only. | Search latency >500ms or cross-project data leaks |
| Pillar 2 (auto-injection) | `buildAutoInjection()` returns empty string. | Stale/wrong directives injected post-compaction |
| Both | `CTX_MEMORY_VERSION=0` env var disables all new behavior. | Any pillar causes regression |

ContentStore is ephemeral — rollback = restart process. SessionDB has no schema changes — inherently safe.

---

## Deprecated Documents

The following files were created during review rounds and are SUPERSEDED by this PRD:

| File | Status | Action |
|------|--------|--------|
| `PRD-skill-reinforcement.md` | **DEPRECATED** — breadcrumb removed after Round 8 review (14/16 AGREE) | Delete after merge |
| `design/in-session-reinforcement.md` | **DEPRECATED** — breadcrumb removed | Delete after merge |
| `REVIEW-knowledge-categories.md` | **DEPRECATED** — review findings absorbed into PRD | Delete after merge |
| `questions-knowledge-categories.md` | **DEPRECATED** — junior questions answered in review rounds | Delete after merge |

**This file (`PRD-knowledge-categories.md`) is the SINGLE SOURCE OF TRUTH.**

---

## Review History

| Round | Participants | Key Changes |
|-------|-------------|-------------|
| Round 1 | 3 architects | Initial 10 categories proposed |
| Round 2 | 6 teams (16 engineers) | 45 -> 28 categories. Unified search added. Timeline designed. 14 dropped, 5 merged. |
| Round 3 | 4 teams (16 engineers) | latency blocked (no hook timing). Score normalization resolved. Auto-memory path fixed. project_dir filter added. MEMORY tiers. |
| Round 4 | 4 teams (16 engineers) | 3 bugs found. Auto-injection designed. Dead code identified. Injection format: informational -> directive. |
| Round 5 | 4 teams (16 engineers) | Root cause: skills have ZERO reinforcement (6 gaps). Pillar 3 (breadcrumb) proposed. |
| Round 6 | 4 teams (16 engineers) | Code review. 3 PRD files consolidated. Test plan added. Rollback + success metrics added. |
| Round 8 | 3 teams (16 engineers) | **Pillar 3 (breadcrumb) REMOVED.** 14/16 voted AGREE. Reason: context-mode should not pollute the context it protects. additionalContext accumulates in conversation — 200 breadcrumbs = 4K identical tokens. Auto-injection on compact + static reinforcement is sufficient. |
### Design Constraints

- Auto-injection fires ONLY on `SessionStart(source: "compact")` — never mid-session
- NO continuous injection of any kind — context-mode does not pollute the context it protects
- Timeline freshness: old decisions must NOT be presented as new — timestamps required
- TDD skill must be used for all implementation in this PRD
