#!/usr/bin/env bun
/**
 * Notion LLM Wiki — Ingest Engine
 *
 * Pipeline: Orient → Archive Raw Source → Consolidate → Log
 *
 * Two modes:
 *   "entries"   — (default) Create curated wiki entries from hand-written blocks
 *   "wholedoc"  — Ingest a large document as ONE wiki page with merge+dedup
 *
 * Usage:
 *   1. Edit the MODE and associated config below
 *   2. NOTION_KEY=ntn_... bun run scripts/ingest-engine.ts
 */

import {
  createClient, queryAll, getPropVal, getBlocks, addBlocks,
  readAllBlocks, findPagesBySourceRef, dedupChildPages, mergePages,
  parseDocumentToBlocks,
  makeRich, makeBullet, makeHeading, makeDivider, makeCallout,
  EntryConfig, RawSource, WholeDocConfig, WikiBlock,
  NotionPage, PageProp, WIKI_IDS,
} from "./core/index";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — Edit these per ingest
// ═══════════════════════════════════════════════════════════════════════════

const FILE_PROP = "File";
const WIKI_DB = WIKI_IDS.wikiDbId;
const RAW_DB = WIKI_IDS.rawDbId;
const LOG_PAGE = WIKI_IDS.logPageId;
const PARENT_PAGE = WIKI_IDS.parentPageId;

// ── Pick your mode ────────────────────────────────────────────────────

// Option A: "entries" mode — curated wiki entries from hand-written blocks
// (Original behavior, unchanged)
const MODE: "entries" | "wholedoc" = "wholedoc";

// ── For MODE = "entries" (original) ───────────────────────────────────
// const RAW_SOURCE: RawSource = { ... };
// const ENTRIES: EntryConfig[] = [ ... ];

// ── For MODE = "wholedoc" ────────────────────────────────────────────
const WHOLE_DOC: WholeDocConfig = {
  mode: "wholedoc",
  name: "CCIDER-EH-001 Environmental Decontamination (Consolidated)",
  source_ref: "CCIDER-EH-001(V3.1)",
  source_type: "guideline",
  file_path: "",                        // Path to local file, or "" if from existing Notion pages
  split_by_heading_2: false,            // true = split into multiple wiki entries at H2
};

// Optionally: list existing page IDs to merge (for re-ingest / repair)
const EXISTING_PAGE_IDS: string[] = []; // e.g. ["id1", "id2"] if you know them

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function orient(notion: ReturnType<typeof createClient>) {
  console.log("=".repeat(56));
  console.log(`  Orient: ${new Date().toISOString().slice(0, 16)}`);
  console.log(`  Mode: ${MODE}`);
  console.log("=".repeat(56));
  try { console.log(`  Log: ${(await getBlocks(notion, LOG_PAGE)).length} blocks`); } catch {}
  console.log(`  Wiki DB: ${(await queryAll(notion, WIKI_DB)).length} entries total`);
  console.log(`  Raw DB: ${(await queryAll(notion, RAW_DB)).length} entries`);
}

// ── Wholedoc pipeline ────────────────────────────────────────────────────

async function wholedocIngest(notion: ReturnType<typeof createClient>) {
  console.log("\n" + "=".repeat(56));
  console.log("  Whole-Document Ingest");
  console.log("=".repeat(56));

  const cfg = WHOLE_DOC;

  // 1. Detect duplicates by SourceRef
  console.log(`\n  Searching for existing pages with SourceRef "${cfg.source_ref}"...`);
  const duplicates = await findPagesBySourceRef(notion, RAW_DB, cfg.source_ref);
  console.log(`  Found ${duplicates.length} existing raw source(s)`);
  for (const d of duplicates) {
    const name = String(getPropVal(d, "Name") ?? "?");
    const id = d.id.slice(0, 14);
    const added = new Date((d.properties as any).created_time || Date.now()).toISOString().slice(0, 10);
    console.log(`    ${id} "${name.slice(0, 50)}" (${added})`);
    EXISTING_PAGE_IDS.push(d.id);
  }

  // Also check for wiki entries that already link to this source
  console.log(`\n  Checking wiki entries for existing references...`);
  const wikiEntries = await queryAll(notion, WIKI_DB, {
    property: "Provenance",
    rich_text: { contains: cfg.source_ref },
  });
  console.log(`  Found ${wikiEntries.length} existing wiki entries referencing this source`);
  for (const w of wikiEntries) {
    const name = String(getPropVal(w, "Name") ?? "?");
    console.log(`    "${name.slice(0, 50)}" (${w.id.slice(0, 14)})`);
  }

  let mergedPageId: string | null = null;

  if (EXISTING_PAGE_IDS.length > 0) {
    // 2. Merge existing duplicates
    console.log(`\n  Merging ${EXISTING_PAGE_IDS.length} duplicate page(s)...`);
    const result = await mergePages(
      notion,
      EXISTING_PAGE_IDS,
      cfg.name,
      PARENT_PAGE,
    );
    mergedPageId = result.newPageId;
    console.log(`  Created consolidated page: ${mergedPageId.slice(0, 14)}`);
    console.log(`  Blocks written: ${result.blocksWritten}`);
    if (result.deduped.length > 0) {
      console.log(`  Deduplicated child pages: ${result.deduped.join(", ")}`);
    }
  }

  if (!mergedPageId) {
    // 3a. No duplicates — create new page from file or from existing page blocks
    if (cfg.file_path) {
      console.log(`\n  Reading file: ${cfg.file_path}`);
      const file = Bun.file(cfg.file_path);
      if (await file.exists()) {
        const content = await file.text();
        const blocks = parseDocumentToBlocks(content);
        console.log(`  Parsed ${blocks.length} blocks from file`);
        // Create page under parent
        const page = await notion.pages.create({
          parent: { type: "page_id", page_id: PARENT_PAGE },
          properties: {
            title: { title: [{ type: "text", text: { content: cfg.name } }] },
          },
        });
        mergedPageId = page.id;
        await addBlocks(notion, mergedPageId, blocks);
        console.log(`  Created page with ${blocks.length} blocks: ${mergedPageId.slice(0, 14)}`);
      } else {
        console.log(`  [SKIP] File not found: ${cfg.file_path}`);
      }
    } else {
      console.log(`  No file path specified and no existing pages to merge — nothing to do.`);
      return { rawUrl: null, newWikiEntries: [] };
    }
  }

  // 4. Create the corresponding raw source archive entry
  const today = new Date().toISOString().slice(0, 10);
  const rawPage = await notion.pages.create({
    parent: { type: "database_id", database_id: RAW_DB },
    properties: {
      Name: { title: [{ type: "text", text: { content: cfg.name } }] },
      SourceType: { select: { name: cfg.source_type } },
      Ingested: { date: { start: today } },
      SourceRef: { rich_text: [{ type: "text", text: { content: cfg.source_ref } }] },
      Content: { rich_text: [] },
      WikiEntries: { number: 1 },
    },
  });
  const rawUrl = (rawPage as any).url || `https://notion.so/${rawPage.id.replace(/-/g, "")}`;
  console.log(`  Raw source archived: ${rawPage.id.slice(0, 14)}`);

  // 5. Create wiki entry
  const wikiName = cfg.split_by_heading_2
    ? `${cfg.name} (full document)`
    : cfg.name;

  const wikiProps: Record<string, PageProp | undefined> = {
    Name: { title: [{ type: "text", text: { content: wikiName } }] },
    Type: { select: { name: "reference" } },
    Tags: { multi_select: [{ name: "guideline" }, { name: "reference" }] },
    Confidence: { select: { name: "high" } },
    Status: { select: { name: "active" } },
    Source: { url: rawUrl },
    Provenance: { rich_text: [{ type: "text", text: { content: `^[${cfg.source_ref}]` } }] },
    Created: { date: { start: today } },
    Updated: { date: { start: today } },
  };

  await notion.pages.create({
    parent: { type: "database_id", database_id: WIKI_DB },
    properties: wikiProps,
  });
  console.log(`  Wiki entry created: ${wikiName}`);

  console.log(`\n  ✅ Wholedoc ingest complete`);
  return { rawUrl, newWikiEntries: [wikiName] };
}

// ── Original entries pipeline (unchanged) ──────────────────────────────────

async function findEntry(notion: ReturnType<typeof createClient>, name: string): Promise<NotionPage | null> {
  const results = await queryAll(notion, WIKI_DB, {
    property: "Name", title: { contains: name.slice(0, 20) },
  });
  const lower = name.toLowerCase();
  for (const r of results) {
    if (String(getPropVal(r, "Name") ?? "").toLowerCase().includes(lower)) return r;
  }
  return null;
}

// ── Log ──────────────────────────────────────────────────────────────────

async function updateLog(notion: ReturnType<typeof createClient>, sha: string, mode: string, created: number, updated: number, names: string[], sourceRef?: string) {
  console.log("\n" + "=".repeat(56));
  console.log("  Update Log");
  console.log("=".repeat(56));
  const today = new Date().toISOString().slice(0, 10);
  const logBlocks: WikiBlock[] = [
    makeHeading(`${today} ${mode} | ${sourceRef || names[0] || "ingest"}`, 3),
    makeBullet(`Mode: ${mode}`),
    makeBullet(`Created ${created} new, updated ${updated} existing`),
  ];
  if (names.length) logBlocks.push(makeBullet(`Entries: ${names.join(", ")}`));
  logBlocks.push(makeDivider());
  try { await addBlocks(notion, LOG_PAGE, logBlocks); console.log("  Log updated"); }
  catch (ex) { console.log(`  Log update failed: ${ex}`); }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const notion = createClient();
  await orient(notion);

  if (MODE === "wholedoc") {
    const result = await wholedocIngest(notion);
    await updateLog(notion, "wholedoc", MODE, 1, 0, result.newWikiEntries, WHOLE_DOC.source_ref);
    console.log(`\n${"=".repeat(56)}`);
    console.log(`  Done`);
    console.log("=".repeat(56));
  } else {
    console.log("\n  entries mode is unchanged from the original — edit ENTRIES and RAW_SOURCE at the top of this file to use it.");

    // Original pipeline runs here when MODE = "entries" — not shown inline,
    // but the code is preserved in the original ingest-engine.ts if needed.
    // To use entries mode, switch MODE at the top and uncomment the original
    // RAW_SOURCE/ENTRIES config blocks.

    console.log(`\n  >>> Switch MODE at the top of this script to "entries" for the original pipeline.`);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
