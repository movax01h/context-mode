/**
 * Unified multi-source search — merges ContentStore, SessionDB, and
 * auto-memory results into a single ranked or chronological result set.
 *
 * Used by ctx_search when sort="timeline" to search across all sources,
 * or sort="relevance" (default) for ContentStore-only BM25 search.
 */

import type { ContentStore, SearchResult } from "../store.js";
import type { SessionDB, StoredEvent } from "../session/db.js";
import type { SessionEvent } from "../types.js";
import { searchAutoMemory } from "./auto-memory.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface UnifiedSearchResult {
  title: string;
  content: string;
  source: string;
  origin: "current-session" | "prior-session" | "auto-memory";
  timestamp?: string;
  rank?: number;
  matchLayer?: string;
  highlighted?: string;
  contentType?: "code" | "prose";
}

export interface SearchAllSourcesOpts {
  query: string;
  limit: number;
  store: ContentStore;
  sort?: "relevance" | "timeline";
  source?: string;
  contentType?: "code" | "prose";
  sessionDB?: SessionDB | null;
  sessionId?: string;
  projectDir?: string;
  configDir?: string;
}

// ─────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────

/**
 * Search across all available sources.
 *
 * - sort="relevance" (default): BM25-ranked results from ContentStore only.
 * - sort="timeline": chronological merge of ContentStore + SessionDB + auto-memory.
 *
 * Errors in any single source are caught and logged — partial results
 * are always returned.
 */
export function searchAllSources(opts: SearchAllSourcesOpts): UnifiedSearchResult[] {
  const {
    query,
    limit,
    store,
    sort = "relevance",
    source,
    contentType,
    sessionDB,
    sessionId,
    projectDir,
    configDir,
  } = opts;

  const results: UnifiedSearchResult[] = [];

  // ── Source 1: ContentStore (always, both modes) ──
  try {
    const storeResults = store.searchWithFallback(query, limit, source, contentType);
    results.push(
      ...storeResults.map((r: SearchResult) => ({
        title: r.title,
        content: r.content,
        source: r.source,
        origin: "current-session" as const,
        rank: r.rank,
        matchLayer: r.matchLayer,
        highlighted: r.highlighted,
        contentType: r.contentType,
      })),
    );
  } catch {
    // ContentStore search failed — continue with other sources
  }

  // ── Sources 2+3: timeline mode only ──
  if (sort === "timeline") {
    // Source 2: SessionDB — prior session events
    try {
      if (sessionDB) {
        const dbResults = sessionDB.searchEvents(query, limit, projectDir || "", source);
        results.push(
          ...dbResults.map((r: Pick<StoredEvent, "id" | "session_id" | "category" | "type" | "data" | "created_at">) => ({
            title: `[${r.category}] ${r.type}`,
            content: r.data,
            source: "prior-session",
            origin: "prior-session" as const,
            timestamp: r.created_at,
          })),
        );

        // Write knowledge-reuse event — ROI metric for unified search
        if (dbResults.length > 0 && sessionId) {
          try {
            const reuseEvent: SessionEvent = {
              type: "search_hit_prior",
              category: "knowledge-reuse",
              data: `Timeline search found ${dbResults.length} results from prior sessions`,
              priority: 3,
              data_hash: "",
            };
            sessionDB.ensureSession(sessionId, projectDir || "");
            sessionDB.insertEvent(sessionId, reuseEvent, "ctx_search");
          } catch { /* best-effort — never block search results */ }
        }
      }
    } catch {
      // SessionDB search failed — continue
    }

    // Source 3: Auto-memory
    try {
      const memResults = searchAutoMemory([query], limit, projectDir, configDir);
      results.push(...memResults);
    } catch {
      // Auto-memory search failed — continue
    }
  }

  // ── Sort ──
  if (sort === "timeline") {
    results.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  }

  return results.slice(0, limit);
}
