/**
 * Auto-memory search — searches CLAUDE.md and MEMORY.md files for
 * persisted decisions, preferences, and context from prior sessions.
 *
 * Returns results in a format compatible with the unified search pipeline.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface AutoMemoryResult {
  title: string;
  content: string;
  source: string;
  origin: "auto-memory";
  timestamp?: string;
}

/**
 * Search auto-memory files (CLAUDE.md, MEMORY.md, user identity files)
 * for content matching any of the given queries.
 *
 * Scans:
 *   1. Project-level: <projectDir>/CLAUDE.md
 *   2. User-level: <configDir>/CLAUDE.md
 *   3. User memory: <configDir>/memory/*.md
 *
 * @param queries  Array of search terms
 * @param limit    Max results to return
 * @param projectDir  Project directory path
 * @param configDir   Config directory (e.g. ~/.claude)
 * @returns Matching auto-memory results
 */
export function searchAutoMemory(
  queries: string[],
  limit: number = 5,
  projectDir?: string,
  configDir?: string,
): AutoMemoryResult[] {
  const results: AutoMemoryResult[] = [];
  const effectiveConfigDir = configDir || join(homedir(), ".claude");

  // Collect candidate files
  const candidates: Array<{ path: string; label: string }> = [];

  // 1. Project-level CLAUDE.md
  if (projectDir) {
    const projectClaude = join(projectDir, "CLAUDE.md");
    if (existsSync(projectClaude)) {
      candidates.push({ path: projectClaude, label: "project/CLAUDE.md" });
    }
  }

  // 2. User-level CLAUDE.md
  const userClaude = join(effectiveConfigDir, "CLAUDE.md");
  if (existsSync(userClaude)) {
    candidates.push({ path: userClaude, label: "user/CLAUDE.md" });
  }

  // 3. User memory directory
  const memoryDir = join(effectiveConfigDir, "memory");
  if (existsSync(memoryDir)) {
    try {
      const files = readdirSync(memoryDir).filter(f => f.endsWith(".md"));
      for (const file of files) {
        candidates.push({
          path: join(memoryDir, file),
          label: `memory/${file}`,
        });
      }
    } catch { /* best-effort */ }
  }

  // Search each candidate file for matching queries
  for (const candidate of candidates) {
    if (results.length >= limit) break;

    try {
      const content = readFileSync(candidate.path, "utf-8");
      const contentLower = content.toLowerCase();

      for (const query of queries) {
        if (results.length >= limit) break;

        const queryLower = query.toLowerCase();
        // Split query into terms, match if any term is found
        const terms = queryLower.split(/\s+/).filter(t => t.length >= 2);
        const matched = terms.some(term => contentLower.includes(term));

        if (matched) {
          // Extract a relevant section around the first match
          const firstTermIdx = terms.reduce((best, term) => {
            const idx = contentLower.indexOf(term);
            return idx >= 0 && (best < 0 || idx < best) ? idx : best;
          }, -1);

          const snippetStart = Math.max(0, firstTermIdx - 200);
          const snippetEnd = Math.min(content.length, firstTermIdx + 500);
          const snippet = content.slice(snippetStart, snippetEnd).trim();

          results.push({
            title: `[auto-memory] ${candidate.label}`,
            content: snippet,
            source: candidate.label,
            origin: "auto-memory",
          });
          break; // one result per file per query batch
        }
      }
    } catch { /* file read error — skip */ }
  }

  return results.slice(0, limit);
}
