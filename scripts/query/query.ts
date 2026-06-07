// ── Notion LLM Wiki — Query Module ─────────────────────────────────────

import { Client } from "@notionhq/client";
import { queryAll, getPropVal, getBlocks, blocksToMarkdown, PropVal, NotionPage } from "../core";

export type SearchOptions = {
  name?: string; type?: string; tags?: string[]; status?: string;
  confidence?: string; updatedAfter?: string; limit?: number;
};

export type SearchResult = {
  id: string; name: string; type: string; status: string; tags: string[];
  confidence: string | null; source: string | null; provenance: string | null;
  updated: string | null; url: string;
};

export async function searchWikiDb(
  notion: Client, databaseId: string, options: SearchOptions = {},
): Promise<SearchResult[]> {
  const filters: Record<string, unknown>[] = [];
  if (options.type) filters.push({ property: "Type", select: { equals: options.type } });
  if (options.status) filters.push({ property: "Status", status: { equals: options.status } });
  if (options.tags?.length) filters.push({ property: "Tags", multi_select: { contains: options.tags[0] } });
  if (options.confidence) filters.push({ property: "Confidence", select: { equals: options.confidence } });
  const filter = filters.length > 1 ? { and: filters } : filters.length === 1 ? filters[0] : undefined;
  const pages = await queryAll(notion, databaseId, filter);
  let results: SearchResult[] = pages.map(pageToResult);
  if (options.name) { const kw = options.name.toLowerCase(); results = results.filter(r => r.name.toLowerCase().includes(kw)); }
  if (options.updatedAfter) { const cutoff = new Date(options.updatedAfter); results = results.filter(r => r.updated && new Date(r.updated) >= cutoff); }
  if (options.limit) results = results.slice(0, options.limit);
  return results;
}

export async function searchByTags(notion: Client, databaseId: string, tags: string[], options?: Partial<SearchOptions>) {
  return searchWikiDb(notion, databaseId, { ...options, tags });
}

export async function searchByType(notion: Client, databaseId: string, type: string, options?: Partial<SearchOptions>) {
  return searchWikiDb(notion, databaseId, { ...options, type });
}

export function groupByType(results: SearchResult[]): Record<string, SearchResult[]> {
  const grouped: Record<string, SearchResult[]> = {};
  for (const entry of results) { const t = entry.type || "unknown"; if (!grouped[t]) grouped[t] = []; grouped[t].push(entry); }
  return grouped;
}

export async function getEntry(notion: Client, pageId: string): Promise<SearchResult | null> {
  try { return pageToResult(await notion.pages.retrieve({ page_id: pageId }) as unknown as NotionPage); }
  catch { return null; }
}

export async function fetchEntryContent(notion: Client, entryId: string): Promise<string> {
  return blocksToMarkdown(await getBlocks(notion, entryId, 100));
}

function pageToResult(page: NotionPage): SearchResult {
  return {
    id: page.id,
    name: (getPropVal(page, "Name") || "Untitled") as string,
    type: (getPropVal(page, "Type") || "") as string,
    status: (getPropVal(page, "Status") || "") as string,
    tags: (getPropVal(page, "Tags") || []) as string[],
    confidence: getPropVal(page, "Confidence") as string | null,
    source: getPropVal(page, "Source") as string | null,
    provenance: getPropVal(page, "Provenance") as string | null,
    updated: getPropVal(page, "Updated") as string | null,
    url: page.url || `https://notion.so/${page.id.replace(/-/g, "")}`,
  };
}

// Proximity & Related

export type RelatedEntry = SearchResult & { sharedTags: string[]; overlapScore: number };
export type ProximityGraph = { center: SearchResult; bySharedTags: RelatedEntry[]; bySameType: SearchResult[]; bySameSource: SearchResult[] };

export async function findBySharedTags(notion: Client, databaseId: string, entryId: string, minOverlap = 1): Promise<RelatedEntry[]> {
  const center = await getEntry(notion, entryId);
  if (!center || !center.tags.length) return [];
  const centerSet = new Set(center.tags);
  const all = await searchWikiDb(notion, databaseId);
  return all.filter(e => e.id !== entryId && e.tags.length)
    .map(e => ({ ...e, sharedTags: e.tags.filter((t: string) => centerSet.has(t)), overlapScore: e.tags.filter((t: string) => centerSet.has(t)).length / Math.max(center.tags.length, e.tags.length) }))
    .filter(e => e.sharedTags.length >= minOverlap)
    .sort((a, b) => b.overlapScore - a.overlapScore);
}

export async function findBySource(notion: Client, databaseId: string, sourceUrl: string): Promise<SearchResult[]> {
  const url = sourceUrl.toLowerCase();
  return (await searchWikiDb(notion, databaseId)).filter(e => e.source?.toLowerCase() === url);
}

export async function proximityGraph(notion: Client, databaseId: string, entryId: string): Promise<ProximityGraph | null> {
  const center = await getEntry(notion, entryId);
  if (!center) return null;
  const all = await searchWikiDb(notion, databaseId);
  return {
    center,
    bySharedTags: await findBySharedTags(notion, databaseId, entryId),
    bySameType: all.filter(e => e.id !== entryId && e.type && e.type === center.type),
    bySameSource: all.filter(e => e.id !== entryId && e.source && center.source && e.source === center.source),
  };
}
