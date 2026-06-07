#!/usr/bin/env bun
/**
 * Notion LLM Wiki — Ingest Engine
 *
 * Pipeline: Orient → Archive Raw Source → Consolidate → Log
 *
 * Usage:
 *   1. Edit RAW_SOURCE and ENTRIES below
 *   2. NOTION_KEY=ntn_... bun run scripts/ingest-engine.ts
 *
 * Features:
 *   - Uploads local files to Notion as a Files-type DB property
 *   - Links each wiki entry back to the raw source page
 *   - SHA-256 integrity check
 */

import {
  createClient, queryAll, getPropVal, getBlocks, addBlocks,
  makeRich, makeBullet, makeHeading, makeDivider, makeCallout,
  EntryConfig, RawSource, WikiBlock, NotionPage, PageProp, WIKI_IDS,
} from "./core/index";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — Edit these per ingest
// ═══════════════════════════════════════════════════════════════════════════

const FILE_PROP = "File";                     // Files-type property name in Raw DB
const WIKI_DB = WIKI_IDS.wikiDbId;
const RAW_DB = WIKI_IDS.rawDbId;
const LOG_PAGE = WIKI_IDS.logPageId;

// Example — replace with your source:
const RAW_SOURCE: RawSource = {
  name: "Example Source Document",
  source_type: "guideline",
  source_ref: "SOURCEREF-001",
  file_path: "/path/to/source.txt",
};

// Example — replace with your entries:
const ENTRIES: EntryConfig[] = [
  {
    name: "Example Entry — Overview",
    type: "concept",
    tags: ["reference"],
    confidence: "high",
    status: "active",
    blocks: [
      makeHeading("Summary"),
      makeBullet("Key point from source. ^[SOURCEREF-001]"),
      makeHeading("Details"),
      makeBullet("Supporting finding."),
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// ENGINE
// ═══════════════════════════════════════════════════════════════════════════

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

async function orient(notion: ReturnType<typeof createClient>) {
  console.log("=".repeat(56));
  console.log(`  Orient: ${new Date().toISOString().slice(0, 16)}`);
  console.log("=".repeat(56));
  try { console.log(`  Log: ${(await getBlocks(notion, LOG_PAGE)).length} blocks`); } catch {}
  const existing = await findEntry(notion, RAW_SOURCE.name.slice(0, 20));
  if (existing) console.log(`  Found existing entry for this source: ${existing.id.slice(0, 12)}`);
  console.log(`  Wiki DB: ${(await queryAll(notion, WIKI_DB)).length} entries total`);
  console.log(`  Raw DB: ${(await queryAll(notion, RAW_DB)).length} entries`);
}

async function archiveRaw(notion: ReturnType<typeof createClient>) {
  console.log("\n" + "=".repeat(56));
  console.log("  Archive Raw Source");
  console.log("=".repeat(56));
  const file = Bun.file(RAW_SOURCE.file_path);
  const exists = await file.exists();
  const content = exists ? await file.text() : "";
  const sha = exists
    ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).map(b => b.toString(16).padStart(2, "0")).join("")
    : "no-file";
  console.log(`  SHA256: ${sha}`);
  const today = new Date().toISOString().slice(0, 10);
  let uploadedFileProp: { name: string; type: string; file_upload: { id: string } } | null = null;
  if (exists) {
    try {
      const fileName = RAW_SOURCE.file_path.split("/").pop() || "file";
      const upload = await notion.fileUploads.create({ mode: "single_part", filename: fileName, content_type: file.type || "application/octet-stream" });
      await notion.fileUploads.send({ file_upload_id: upload.id, file: { data: new Uint8Array(await file.arrayBuffer()), filename: fileName } });
      uploadedFileProp = { name: fileName, type: "file_upload", file_upload: { id: upload.id } };
      console.log(`  File uploaded (${upload.id})`);
    } catch (e) { console.log(`  \u26A0\uFE0F  File upload failed: ${e}`); }
  } else { console.log(`  [SKIP] File not found`); }
  const properties: Record<string, PageProp | undefined> = {
    Name: { title: [{ type: "text", text: { content: RAW_SOURCE.name } }] },
    SourceType: { select: { name: RAW_SOURCE.source_type } },
    Ingested: { date: { start: today } },
    sha256: { rich_text: [{ type: "text", text: { content: sha } }] },
    SourceRef: { rich_text: [{ type: "text", text: { content: RAW_SOURCE.source_ref } }] },
    Content: { rich_text: makeRich(content.slice(0, 200000)) },
    WikiEntries: { number: 0 },
  };
  if (uploadedFileProp) properties[FILE_PROP] = { files: [uploadedFileProp] };
  const result = await notion.pages.create({ parent: { type: "database_id", database_id: RAW_DB }, properties });
  const rawUrl = result.url || `https://notion.so/${result.id.replace(/-/g, "")}`;
  console.log(`  Created raw source: ${result.id.slice(0, 12)}`);
  return { rawId: result.id, sha, rawUrl };
}

async function consolidate(notion: ReturnType<typeof createClient>, rawUrl: string) {
  console.log("\n" + "=".repeat(56));
  console.log("  Consolidate into Wiki");
  console.log("=".repeat(56));
  let created = 0, updated = 0; const namesCreated: string[] = [];
  for (const entry of ENTRIES) {
    console.log(`\n  Processing: ${entry.name}`);
    namesCreated.push(entry.name);
    const today = new Date().toISOString().slice(0, 10);
    const properties: Record<string, PageProp | undefined> = {
      Name: { title: [{ type: "text", text: { content: entry.name } }] },
      Type: { select: { name: entry.type } },
      Tags: { multi_select: entry.tags.map(t => ({ name: t })) },
      Confidence: { select: { name: entry.confidence } },
      Status: { select: { name: entry.status } },
      Source: { url: rawUrl },
      Provenance: { rich_text: [{ type: "text", text: { content: `^[${RAW_SOURCE.source_ref}]` } }] },
      Created: { date: { start: today } },
      Updated: { date: { start: today } },
    };
    const existing = await findEntry(notion, entry.name);
    if (existing) {
      await notion.pages.update({ page_id: existing.id, properties: { Updated: { date: { start: today } }, Source: { url: rawUrl } } });
      await addBlocks(notion, existing.id, entry.blocks);
      console.log(`  Updated ${existing.id.slice(0, 12)} (+${entry.blocks.length} blocks)`);
      updated++;
    } else {
      await notion.pages.create({ parent: { type: "database_id", database_id: WIKI_DB }, properties, children: entry.blocks });
      console.log(`  Created: ${entry.name}`);
      created++;
    }
  }
  return { created, updated, namesCreated };
}

async function updateLog(notion: ReturnType<typeof createClient>, sha: string, created: number, updated: number, names: string[]) {
  console.log("\n" + "=".repeat(56));
  console.log("  Update Log");
  console.log("=".repeat(56));
  const today = new Date().toISOString().slice(0, 10);
  const logBlocks: WikiBlock[] = [
    makeHeading(`${today} ingest | ${RAW_SOURCE.name}`, 3),
    makeBullet(`Raw source archived ${RAW_SOURCE.source_ref} (${sha.slice(0, 12)}...)`),
    makeBullet(`Created ${created} new, updated ${updated} existing`),
  ];
  if (names.length) logBlocks.push(makeBullet(`Entries: ${names.join(", ")}`));
  logBlocks.push(makeDivider());
  try { await addBlocks(notion, LOG_PAGE, logBlocks); console.log("  Log updated"); }
  catch (ex) { console.log(`  Log update failed: ${ex}`); }
}

async function main() {
  console.log(`\n  Ingest: ${RAW_SOURCE.name}`);
  console.log(`  Ref: ${RAW_SOURCE.source_ref}`);
  const notion = createClient();
  await orient(notion);
  const { rawId, sha, rawUrl } = await archiveRaw(notion);
  const { created, updated, namesCreated } = await consolidate(notion, rawUrl);
  try { await notion.pages.update({ page_id: rawId, properties: { WikiEntries: { number: ENTRIES.length } } }); } catch {}
  await updateLog(notion, sha, created, updated, namesCreated);
  console.log(`\n${"=".repeat(56)}`);
  console.log(`  Done: ${created} created, ${updated} updated`);
  console.log("=".repeat(56));
}
main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
