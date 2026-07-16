import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  coarsenPublicProvenance,
  escapeHtml,
  GALLERY_DISCLAIMER,
  type GalleryIndexEntry,
  listGalleryIndexEntries,
  renderGalleryIndexHtml,
} from "./gallery-index.js";

/**
 * quick-260716-1ki Task 2: the pure gallery-index module. Safety-critical
 * assertions:
 *   - T-1ki-01: chat-derived titles are ESCAPED in the rendered page — a
 *     hostile title's raw bytes never appear in the output.
 *   - T-1ki-02: provenance is whitelist-coarsened (vote|chaos pass, EVERYTHING
 *     else → paid) and the module reads only project_repos + build_history.
 *   - listGalleryIndexEntries: closest-created_at_ms row matching (ties →
 *     lower id), slug/paid fallback when no build_history row exists.
 * The db tests run against an IN-MEMORY better-sqlite3 database with the two
 * tables created inline (schema.sql mirror) — no real fs/network.
 */

describe("escapeHtml — textContent-equivalent escaping (T-1ki-01)", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml('a"b')).toBe("a&quot;b");
    expect(escapeHtml("a'b")).toBe("a&#39;b");
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  it("escapes ampersands FIRST — no double-escaping artifacts", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("<a href=\"x\">'&'</a>")).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("make a counter app")).toBe("make a counter app");
  });
});

describe("coarsenPublicProvenance — whitelist-only public projection (T-1ki-02)", () => {
  it("passes vote and chaos through", () => {
    expect(coarsenPublicProvenance("vote")).toBe("vote");
    expect(coarsenPublicProvenance("chaos")).toBe("chaos");
  });

  it("collapses donation, channel_points, and ANY unknown value to 'paid' — never echoed raw", () => {
    expect(coarsenPublicProvenance("donation")).toBe("paid");
    expect(coarsenPublicProvenance("channel_points")).toBe("paid");
    expect(coarsenPublicProvenance("garbage")).toBe("paid");
    expect(coarsenPublicProvenance("")).toBe("paid");
  });
});

describe("renderGalleryIndexHtml — pure standalone page, everything escaped", () => {
  const entry = (over?: Partial<GalleryIndexEntry>): GalleryIndexEntry => ({
    title: "make a counter app",
    repoName: "make-a-counter-app",
    nightLabel: "Tuesday, July 8, 2026",
    provenance: "vote",
    ...over,
  });

  it("a hostile chat title renders ONLY in escaped form — raw bytes absent (T-1ki-01)", () => {
    const hostile = '<img src=x onerror=alert(document.cookie)>"; --</li>';
    const html = renderGalleryIndexHtml([entry({ title: hostile })], "TwitchVibecodes");
    expect(html).not.toContain(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(document.cookie)&gt;&quot;; --&lt;/li&gt;");
  });

  it("carries the fixed unreviewed-by-humans disclaimer banner", () => {
    const html = renderGalleryIndexHtml([entry()], "TwitchVibecodes");
    expect(html).toContain(GALLERY_DISCLAIMER);
    expect(GALLERY_DISCLAIMER).toContain("unreviewed by humans");
  });

  it("composes Play (lowercased-owner Pages) and Source (github.com) links per entry", () => {
    const html = renderGalleryIndexHtml([entry()], "TwitchVibecodes");
    expect(html).toContain('href="https://twitchvibecodes.github.io/make-a-counter-app/"');
    expect(html).toContain('href="https://github.com/TwitchVibecodes/make-a-counter-app"');
  });

  it("renders the night label and the provenance badge per entry", () => {
    const html = renderGalleryIndexHtml(
      [entry({ provenance: "chaos" }), entry({ repoName: "other", provenance: "paid" })],
      "TwitchVibecodes",
    );
    expect(html).toContain("Tuesday, July 8, 2026");
    expect(html).toContain('badge-chaos">chaos<');
    expect(html).toContain('badge-paid">paid<');
  });

  it("is a complete standalone document with zero JS and zero external assets", () => {
    const html = renderGalleryIndexHtml([entry()], "TwitchVibecodes");
    expect(html).toContain("<!doctype html>");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/src="http/);
    expect(html).not.toContain('rel="stylesheet"');
  });

  it("an empty entry list renders the fixed empty-state line", () => {
    const html = renderGalleryIndexHtml([], "TwitchVibecodes");
    expect(html).toContain("Nothing here yet");
  });
});

describe("listGalleryIndexEntries — project_repos × build_history join (in-memory db)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Inline mirrors of schema.sql's two tables (the ONLY tables this module
    // may read — neither carries donor identity or amounts, T-1ki-02).
    db.exec(`
      CREATE TABLE project_repos (
        generation    INTEGER PRIMARY KEY,
        repo_name     TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE build_history (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id       TEXT NOT NULL,
        title         TEXT NOT NULL,
        provenance    TEXT NOT NULL,
        result        TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  const addRepo = (generation: number, name: string, createdAtMs: number): void => {
    db.prepare(
      "INSERT INTO project_repos (generation, repo_name, created_at_ms) VALUES (?, ?, ?)",
    ).run(generation, name, createdAtMs);
  };
  const addBuild = (title: string, provenance: string, createdAtMs: number): void => {
    db.prepare(
      "INSERT INTO build_history (task_id, title, provenance, result, created_at_ms) VALUES ('t', ?, ?, 'built', ?)",
    ).run(title, provenance, createdAtMs);
  };

  it("returns [] on an empty project_repos table", () => {
    expect(listGalleryIndexEntries(db)).toEqual([]);
  });

  it("newest generation first; each repo takes the CLOSEST build_history row's title + coarsened provenance", () => {
    addRepo(1, "counter-app", 1_000);
    addRepo(2, "snake-game", 50_000);
    addBuild("make a counter app", "vote", 900); // closest to repo 1
    addBuild("build a snake game", "donation", 49_800); // closest to repo 2
    addBuild("later tweak", "chaos", 200_000); // closest to neither

    expect(listGalleryIndexEntries(db)).toEqual([
      {
        title: "build a snake game",
        repoName: "snake-game",
        nightLabel: expect.any(String) as unknown as string,
        provenance: "paid", // donation coarsened — never raw on the public page
      },
      {
        title: "make a counter app",
        repoName: "counter-app",
        nightLabel: expect.any(String) as unknown as string,
        provenance: "vote",
      },
    ]);
  });

  it("ties on distance resolve to the LOWER build_history id", () => {
    addRepo(1, "counter-app", 1_000);
    addBuild("first at equal distance", "vote", 900); // |Δ| = 100, id 1
    addBuild("second at equal distance", "chaos", 1_100); // |Δ| = 100, id 2

    const [entry] = listGalleryIndexEntries(db);
    expect(entry?.title).toBe("first at equal distance");
    expect(entry?.provenance).toBe("vote");
  });

  it("no build_history rows → title falls back to the safe repo slug, provenance to 'paid'", () => {
    addRepo(3, "mystery-app", 5_000);
    expect(listGalleryIndexEntries(db)).toEqual([
      {
        title: "mystery-app",
        repoName: "mystery-app",
        nightLabel: expect.any(String) as unknown as string,
        provenance: "paid",
      },
    ]);
  });

  it("nightLabel is the REPO's created_at_ms formatted as the stream night (server.ts nightLabelOf idiom)", () => {
    // 2026-07-08 12:00 local time.
    const repoMs = new Date(2026, 6, 8, 12, 0, 0).getTime();
    addRepo(1, "counter-app", repoMs);
    const [entry] = listGalleryIndexEntries(db);
    // "Wednesday, July 8, 2026" — weekday, month-name, day, year (en-US).
    expect(entry?.nightLabel).toMatch(/^[A-Z][a-z]+, July 8, 2026$/);
  });
});
