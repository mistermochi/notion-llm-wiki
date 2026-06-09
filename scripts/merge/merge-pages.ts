#!/usr/bin/env bun
/**
 * Notion LLM Wiki — Merge Pages
 *
 * Merge duplicate pages (by SourceRef) into one consolidated page.
 *
 * Usage:
 *   NOTION_KEY=ntn_... bun run scripts/merge/merge-pages.ts --source-ref "CCIDER-EH-001(V3.1)"
 *   NOTION_KEY=ntn_... bun run scripts/merge/merge-pages.ts --source-ref "CCIDER-EH-001(V3.1)" --target-name "My Consolidated Doc" --dry-run
 *
 * Options:
 *   --source-ref   Required. SourceRef value to search for duplicates.
 *   --target-name  Optional. Name for the consolidated page (default: SourceRef).
 *   --dry-run      Optional. Preview without making changes.
 *   --parent-id    Optional. Parent page ID (default: PARENT_PAGE from WIKI_IDS).
 *   --db           Optional. Database to search (default: RAW_DB from WIKI_IDS).
 */

import { createClient, queryAll, getPropVal, findPagesBySourceRef, mergePages, readAllBlocks } from "../core/index";

const WIKI_DB = "4f5243a6-654f-477d-83db-946b2fd65fe6";
const RAW_DB = "3743e72a-1ade-81e9-be4f-db034b1db199";
const PARENT_PAGE = "3743e72a1ade810794eedfb282309f38";

function parseArgs(): { sourceRef: string; targetName: string; dryRun: boolean; dbId: string; parentId: string } {
  const args = process.argv.slice(2);
  const sourceRef = extractArg(args, "--source-ref");
  if (!sourceRef) {
    console.error("Usage: bun run scripts/merge/merge-pages.ts --source-ref \"SOURCEREF-001\" [--target-name \"Name\"] [--dry-run]");
    process.exit(1);
  }
  return {
    sourceRef,
    targetName: extractArg(args, "--target-name") || sourceRef,
    dryRun: args.includes("--dry-run"),
    dbId: extractArg(args, "--db") || RAW_DB,
    parentId: extractArg(args, "--parent-id") || PARENT_PAGE,
  };
}

function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  // Also support --key=val format
  for (const arg of args) {
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

async function main() {
  const opts = parseArgs();
  const notion = createClient();

  console.log("=".repeat(56));
  console.log(`  Merge Pages`);
  console.log(`  SourceRef: ${opts.sourceRef}`);
  console.log(`  Target:    ${opts.targetName}`);
  console.log(`  Database:  ${opts.dbId.slice(0, 14)}`);
  console.log(`  Dry run:   ${opts.dryRun}`);
  console.log("=".repeat(56));

  // 1. Find duplicates
  console.log(`\n  Searching for pages with SourceRef "${opts.sourceRef}"...`);
  const dupes = await findPagesBySourceRef(notion, opts.dbId, opts.sourceRef);
  console.log(`\n  Found ${dupes.length} page(s):`);

  let blockCount = 0;
  for (const d of dupes) {
    const name = String(getPropVal(d, "Name") ?? "?");
    const blocks = await readAllBlocks(notion, d.id);
    blockCount += blocks.length;
    console.log(`    ${d.id.slice(0, 14)} "${name.slice(0, 50)}" (${blocks.length} blocks)`);
  }

  if (dupes.length < 2) {
    console.log(`\n  ⚠️  Need at least 2 pages to merge. Found ${dupes.length}.`);
    if (dupes.length === 1) {
      console.log(`  Tip: If you want to consolidate a single page, use the wholedoc mode in ingest-engine.ts instead.`);
    }
    process.exit(0);
  }

  const pageIds = dupes.map(d => d.id);
  console.log(`\n  Total blocks across all pages: ${blockCount}`);

  if (opts.dryRun) {
    console.log(`\n  ✅ Dry run complete. No changes made.`);
    console.log(`  Would merge ${pageIds.length} pages into "${opts.targetName}".`);
    process.exit(0);
  }

  // 2. Merge
  console.log(`\n  Merging...`);
  const result = await mergePages(notion, pageIds, opts.targetName, opts.parentId);
  console.log(`\n  ✅ Merge complete!`);
  console.log(`  Consolidated page: ${result.newPageId.slice(0, 14)}`);
  console.log(`  Blocks written: ${result.blocksWritten}`);
  if (result.deduped.length > 0) {
    console.log(`  Deduplicated child pages: ${result.deduped.join(", ")}`);
  }
  console.log(`  Trashed ${pageIds.length} old pages.`);

  // 3. Create a wiki entry pointing to the merged page
  const rawUrl = `https://notion.so/${result.newPageId.replace(/-/g, "")}`;
  const today = new Date().toISOString().slice(0, 10);
  await notion.pages.create({
    parent: { type: "database_id", database_id: WIKI_DB },
    properties: {
      Name: { title: [{ type: "text", text: { content: `${opts.targetName} (merged)` } }] },
      Type: { select: { name: "reference" } },
      Tags: { multi_select: [{ name: "guideline" }, { name: "reference" }] },
      Confidence: { select: { name: "high" } },
      Status: { select: { name: "active" } },
      Source: { url: rawUrl },
      Provenance: { rich_text: [{ type: "text", text: { content: `^[${opts.sourceRef}]` } }] },
      Created: { date: { start: today } },
      Updated: { date: { start: today } },
    },
  });
  console.log(`  Wiki entry created.`);
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
