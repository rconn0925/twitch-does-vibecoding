/**
 * quick-260716-1ki gallery index site — the PURE data + rendering half of the
 * public "<owner>.github.io" gallery. This module has NO Agent SDK imports and
 * does NO I/O beyond prepared read-only SELECTs against the app db: the
 * publisher (gallery-publisher.ts) owns every git/gh/fs touch-point.
 *
 * Trust boundary (T-1ki-01): build_history.title is gate-APPROVED but still
 * chat-derived — HOSTILE for HTML. Every dynamic string in the rendered page
 * flows through escapeHtml (zero raw interpolation), and repoName/owner are
 * escaped too as defense-in-depth even though they are [a-z0-9-] slugs /
 * fixed config strings by construction.
 *
 * Privacy (T-1ki-02): the index reads ONLY project_repos + build_history —
 * neither table carries donor identity or amounts. Provenance is coarsened
 * whitelist-only to the public vote|paid|chaos vocabulary (server.ts:129
 * discipline): unknown values NEVER echo raw to the public page.
 */

import type Database from "better-sqlite3";

/**
 * textContent-equivalent HTML escaping of the five metacharacters. EVERY
 * dynamic string in renderGalleryIndexHtml flows through this (T-1ki-01).
 */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The coarse 3-value public provenance vocabulary (mirrors history/server.ts PublicProvenance). */
export type GalleryProvenance = "vote" | "paid" | "chaos";

/**
 * Whitelist-only public coarsening — REPLICATES src/history/server.ts:129's
 * coarsenProvenance idiom (that function is module-private and importing the
 * express server into the orchestrator would drag a listener along): vote →
 * vote, chaos → chaos, and EVERYTHING else (donation, channel_points, any
 * unknown value) collapses to "paid" — never echoed raw (T-1ki-02).
 */
export function coarsenPublicProvenance(provenance: string): GalleryProvenance {
  if (provenance === "vote") return "vote";
  if (provenance === "chaos") return "chaos";
  return "paid";
}

/** One row of the public gallery index — display fields only. */
export interface GalleryIndexEntry {
  /** Chat-derived (gate-approved) build title — HOSTILE for HTML until escaped. */
  title: string;
  /** The [a-z0-9-] repo slug under the configured owner. */
  repoName: string;
  /** Server-formatted stream night, e.g. "Tuesday, July 8, 2026". */
  nightLabel: string;
  provenance: GalleryProvenance;
}

interface ProjectRepoDbRow {
  generation: number;
  repo_name: string;
  created_at_ms: number;
}

interface BuildHistoryDbRow {
  id: number;
  title: string;
  provenance: string;
  created_at_ms: number;
}

/** Server-formatted human night label — the history server's nightLabelOf idiom. */
function nightLabelOf(createdAtMs: number): string {
  return new Date(createdAtMs).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Read the gallery entries, newest project first (generation DESC). For each
 * project_repos row, the matching build_history row is the one whose
 * created_at_ms is CLOSEST to the repo's created_at_ms (ties → lower id):
 * recordBuildHistory fires in finalize just before publishNow scaffolds the
 * repo, so the closest row is the scaffolding build. Fallback when no
 * build_history row exists: title = repo_name (a safe slug), provenance =
 * "paid" (whitelist fallback — never guess). Prepared statements only.
 */
export function listGalleryIndexEntries(db: Database.Database): GalleryIndexEntry[] {
  const repoRows = db
    .prepare(
      "SELECT generation, repo_name, created_at_ms FROM project_repos ORDER BY generation DESC",
    )
    .all() as ProjectRepoDbRow[];
  if (repoRows.length === 0) return [];
  const historyRows = db
    .prepare("SELECT id, title, provenance, created_at_ms FROM build_history ORDER BY id ASC")
    .all() as BuildHistoryDbRow[];

  return repoRows.map((repo) => {
    let closest: BuildHistoryDbRow | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const row of historyRows) {
      const distance = Math.abs(row.created_at_ms - repo.created_at_ms);
      // Strict < keeps the LOWER id on ties (rows iterate id ASC).
      if (distance < closestDistance) {
        closest = row;
        closestDistance = distance;
      }
    }
    return {
      title: closest?.title ?? repo.repo_name,
      repoName: repo.repo_name,
      nightLabel: nightLabelOf(repo.created_at_ms),
      provenance: closest ? coarsenPublicProvenance(closest.provenance) : "paid",
    };
  });
}

/**
 * The fixed disclaimer banner copy — server-authored, zero dynamic tokens.
 * Exported so tests pin the substance without duplicating the string.
 */
export const GALLERY_DISCLAIMER =
  "Everything below was built live on stream by Twitch chat and an AI agent — unreviewed by humans. Click at your own delight.";

/**
 * Render the complete standalone gallery index page: inline CSS, ZERO JS,
 * zero external assets. Newest-first list, one card per entry with the
 * escaped title, a Play link (GitHub Pages), a Source link (github.com), the
 * stream-night date, and a provenance badge. PURE — no I/O, no clock.
 */
export function renderGalleryIndexHtml(entries: GalleryIndexEntry[], owner: string): string {
  const ownerAttr = escapeHtml(owner);
  const pagesHost = escapeHtml(owner.toLowerCase());
  const cards = entries
    .map((entry) => {
      const title = escapeHtml(entry.title);
      const repo = escapeHtml(entry.repoName);
      const night = escapeHtml(entry.nightLabel);
      const badge = escapeHtml(entry.provenance);
      const playHref = `https://${pagesHost}.github.io/${repo}/`;
      const sourceHref = `https://github.com/${ownerAttr}/${repo}`;
      return [
        '      <li class="app">',
        `        <span class="title">${title}</span>`,
        `        <span class="badge badge-${badge}">${badge}</span>`,
        `        <span class="night">${night}</span>`,
        `        <a class="play" href="${playHref}">Play</a>`,
        `        <a class="source" href="${sourceHref}">Source</a>`,
        "      </li>",
      ].join("\n");
    })
    .join("\n");
  const empty =
    '      <li class="empty">Nothing here yet — the first finished build starts the gallery.</li>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Twitch Does Vibecoding — the app gallery</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; padding: 2rem 1rem; background: #0f1220; color: #e8e9f0; font-family: system-ui, sans-serif; }
      main { max-width: 720px; margin: 0 auto; }
      h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
      .disclaimer { background: #2a2140; border: 1px solid #6b5ca5; border-radius: 8px; padding: 0.75rem 1rem; margin: 0 0 1.5rem; font-size: 0.95rem; }
      ul { list-style: none; margin: 0; padding: 0; }
      .app { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; padding: 0.8rem 1rem; margin-bottom: 0.6rem; background: #191d30; border-radius: 8px; }
      .title { font-weight: 600; flex: 1 1 100%; }
      .badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.1rem 0.5rem; border-radius: 999px; background: #33395c; }
      .badge-vote { background: #2c4a33; }
      .badge-paid { background: #4a3a2c; }
      .badge-chaos { background: #4a2c44; }
      .night { color: #9aa0b8; font-size: 0.85rem; }
      a { color: #8ab4ff; }
      .play { font-weight: 600; }
      .empty { color: #9aa0b8; padding: 0.8rem 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Twitch Does Vibecoding — the app gallery</h1>
      <p class="disclaimer">${escapeHtml(GALLERY_DISCLAIMER)}</p>
      <ul>
${cards.length > 0 ? cards : empty}
      </ul>
    </main>
  </body>
</html>
`;
}
