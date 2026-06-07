// ── Notion LLM Wiki — Bulk Operations ───────────────────────────────────

import { Client } from "@notionhq/client";
import { searchWikiDb, SearchResult, SearchOptions } from "../query/query";

export type BulkCriteria = {
  type?: string; status?: string; tags?: string[];
  namePattern?: string; updatedBefore?: string;
};

export type BulkSummary = { attempted: number; succeeded: number; failed: number; names: string[] };

export async function archiveEntries(notion: Client, entries: { id: string; name: string }[]): Promise<BulkSummary> {
  let succeeded = 0, failed = 0; const names: string[] = [];
  for (const e of entries) {
    try { await notion.pages.update({ page_id: e.id, archived: true }); names.push(e.name); succeeded++; }
    catch { failed++; }
  }
  return { attempted: entries.length, succeeded, failed, names };
}

export async function archiveByCriteria(notion: Client, databaseId: string, criteria: BulkCriteria): Promise<{ matched: SearchResult[]; archived: BulkSummary }> {
  const options: SearchOptions = {};
  if (criteria.type) options.type = criteria.type;
  if (criteria.status) options.status = criteria.status;
  if (criteria.tags?.length) options.tags = [criteria.tags[0]];
  let matched = await searchWikiDb(notion, databaseId, options);
  if (criteria.namePattern) { const re = new RegExp(criteria.namePattern, "i"); matched = matched.filter(e => re.test(e.name)); }
  if (criteria.updatedBefore) { const cutoff = new Date(criteria.updatedBefore); matched = matched.filter(e => e.updated && new Date(e.updated) < cutoff); }
  return { matched, archived: await archiveEntries(notion, matched.map(e => ({ id: e.id, name: e.name }))) };
}

export async function batchUpdateStatus(notion: Client, entries: { id: string; name: string }[], newStatus: string): Promise<BulkSummary> {
  let succeeded = 0, failed = 0; const names: string[] = [];
  for (const e of entries) {
    try { await notion.pages.update({ page_id: e.id, properties: { Status: { select: { name: newStatus } } } }); names.push(e.name); succeeded++; }
    catch { failed++; }
  }
  return { attempted: entries.length, succeeded, failed, names };
}

export async function dryRun(notion: Client, databaseId: string, criteria: BulkCriteria): Promise<SearchResult[]> {
  return (await archiveByCriteria(notion, databaseId, criteria)).matched;
}
