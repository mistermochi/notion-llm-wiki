#!/usr/bin/env bun
// ── Notion LLM Wiki — Vault Lint ───────────────────────────────────────

import { createClient, queryAll, getPropVal, NotionPage, LintEntry, LintCounts, WIKI_IDS } from "./core/index";

const WIKI_DB = WIKI_IDS.wikiDbId;
const RAW_DB = WIKI_IDS.rawDbId;

function pv(val: string | string[] | number | null): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  return val[0] ?? "";
}

function extractEntry(page: NotionPage): LintEntry {
  const tags = getPropVal(page, "Tags");
  return {
    id: page.id.slice(0, 12),
    name: pv(getPropVal(page, "Name")) || "(unnamed)",
    type: pv(getPropVal(page, "Type")),
    status: pv(getPropVal(page, "Status")),
    tags: Array.isArray(tags) ? (tags as string[]) : (typeof tags === "string" ? [tags] : []),
    confidence: pv(getPropVal(page, "Confidence")),
    source: page.properties?.Source?.url || "",
    provenance: pv(getPropVal(page, "Provenance")),
    updated: pv(getPropVal(page, "Updated")),
  };
}

function lintEntry(e: LintEntry, issues: string[], warns: string[], nameMap: Map<string, string[]>) {
  if (!e.type) issues.push(`[TYPE] Missing: ${e.name} (${e.id})`);
  if (!e.status) issues.push(`[STATUS] Missing: ${e.name} (${e.id})`);
  if (!e.tags.length) warns.push(`[TAGS] None: ${e.name} (${e.id})`);
  if (e.type === "concept" && !e.confidence) warns.push(`[CONF] Missing: ${e.name} (${e.id})`);
  if (["concept", "reference"].includes(e.type) && !e.source) warns.push(`[SRC] No URL: ${e.name} (${e.id})`);
  if (!e.provenance) warns.push(`[PROV] Missing: ${e.name} (${e.id})`);
  if (e.updated) {
    const d = new Date(e.updated.slice(0, 10));
    if (!isNaN(d.getTime())) {
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      if (days > 365) issues.push(`[STALE] >1yr: ${e.name} (${e.id}) [${e.updated.slice(0, 10)}]`);
      else if (days > 180) warns.push(`[AGE] >6mo: ${e.name} (${e.id}) [${e.updated.slice(0, 10)}]`);
    }
  }
  const existing = nameMap.get(e.name) ?? [];
  existing.push(e.id); nameMap.set(e.name, existing);
}

function hasFileAttached(raw: NotionPage): boolean {
  const prop = raw.properties?.["File"];
  if (!prop || prop.type !== "files") return false;
  const files = (prop as any).files;
  if (!files || !Array.isArray(files) || files.length === 0) return false;
  return files.some((f: any) => {
    if (f.type === "file") return f.file?.url?.length > 0;
    if (f.type === "external") return f.external?.url?.length > 0;
    return true;
  });
}

async function lintRawSources(notion: ReturnType<typeof createClient>, warns: string[], issues: string[]) {
  try {
    const raws = await queryAll(notion, RAW_DB);
    let orphaned = 0, missingFile = 0;
    for (const r of raws) {
      const name = pv(getPropVal(r, "Name")) || "(unnamed)";
      const wikiEntries = getPropVal(r, "WikiEntries");
      if (wikiEntries === null || wikiEntries === 0 || wikiEntries === "?") {
        orphaned++; issues.push(`[ORPHAN] 0 entries: ${name} (${r.id.slice(0, 12)})`);
      }
      if (!hasFileAttached(r)) {
        missingFile++; issues.push(`[FILE] No file attached: ${name} (${r.id.slice(0, 12)})`);
      }
    }
    console.log(`  Raw sources: ${raws.length} (${orphaned} orphaned, ${missingFile} missing file)`);
  } catch (ex) { console.log(`  Raw sources SKIP: ${ex}`); }
}

async function main() {
  const notion = createClient();
  console.log("\u2500".repeat(56));
  console.log(`  Notion Wiki Lint — ${new Date().toISOString().slice(0, 16)}`);
  console.log("\u2500".repeat(56));
  const entries = await queryAll(notion, WIKI_DB);
  console.log(`\n  Total entries: ${entries.length}`);
  const issues: string[] = []; const warns: string[] = [];
  const stats: LintCounts = { concept: 0, reference: 0, comparison: 0, other: 0, noType: 0 };
  const nameMap = new Map<string, string[]>();
  for (const page of entries) {
    const e = extractEntry(page);
    const t = { concept: "concept" as const, reference: "reference" as const, comparison: "comparison" as const }[e.type] || (e.type && e.type !== "?" ? "other" as const : "noType" as const);
    stats[t]++;
    lintEntry(e, issues, warns, nameMap);
  }
  for (const [name, ids] of nameMap) { if (ids.length > 1) issues.push(`[DUP] '${name}' -> ${ids.join(", ")}`); }
  await lintRawSources(notion, warns, issues);
  console.log(`\n  STATS: C=${stats.concept} R=${stats.reference} Comp=${stats.comparison} Other=${stats.other} NoType=${stats.noType}`);
  console.log(`  ISSUES: ${issues.length} | WARNINGS: ${warns.length}\n`);
  for (const i of issues) console.log(`  \uD83D\uDD34 ${i}`);
  for (const w of warns) console.log(`  \uD83D\uDFE1 ${w}`);
  console.log(`\n${"\u2500".repeat(56)}`);
  console.log(`  ${issues.length > 0 ? `\uD83D\uDD34 ${issues.length} issue(s)` : ""}${issues.length > 0 && warns.length > 0 ? " \u00B7 " : ""}${warns.length > 0 ? `\uD83D\uDFE1 ${warns.length} warning(s)` : ""}`);
  console.log("\u2500".repeat(56));
}
main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
