// ── Notion LLM Wiki — Maintain Module ──────────────────────────────────

import { Client } from "@notionhq/client";
import { getBlocks, parseMarkdownToBlocks, PageProp, type NotionBlock } from "../core";
import { searchWikiDb } from "../query/query";

// ── Create ──

export type EntryCreateConfig = {
  name: string; type?: string; tags?: string[];
  confidence?: "high" | "medium" | "low"; status?: string;
  source?: string; provenance?: string;
};

export async function createWikiEntry(notion: Client, databaseId: string, config: EntryCreateConfig) {
  const props: Record<string, PageProp | undefined> = {
    Name: { title: [{ type: "text", text: { content: config.name } }] },
  };
  if (config.type)        props.Type        = { select: { name: config.type } };
  if (config.tags?.length) props.Tags       = { multi_select: config.tags.map(t => ({ name: t })) };
  if (config.confidence)  props.Confidence  = { select: { name: config.confidence } };
  if (config.status)      props.Status      = { select: { name: config.status } };
  if (config.source)      props.Source      = { url: config.source };
  if (config.provenance)  props.Provenance  = { rich_text: [{ type: "text", text: { content: config.provenance } }] };
  return notion.pages.create({ parent: { database_id: databaseId }, properties: props } as any);
}

export async function batchUpsertByName(notion: Client, databaseId: string, configs: EntryCreateConfig[]) {
  let created = 0, existing = 0; const pages: any[] = [];
  for (const cfg of configs) {
    const matches = await searchWikiDb(notion, databaseId, { name: cfg.name });
    const exact = matches.find(m => m.name.toLowerCase() === cfg.name.toLowerCase());
    if (exact) { existing++; pages.push(exact); }
    else { pages.push(await createWikiEntry(notion, databaseId, cfg) as any); created++; }
  }
  return { created, existing, pages };
}

// ── Update Properties ──

export async function setStatus(notion: Client, pageId: string, status: string) {
  return notion.pages.update({ page_id: pageId, properties: { Status: { select: { name: status } } } });
}

export async function setConfidence(notion: Client, pageId: string, confidence: "high" | "medium" | "low") {
  return notion.pages.update({ page_id: pageId, properties: { Confidence: { select: { name: confidence } } } });
}

export async function addTags(notion: Client, pageId: string, tags: string[]) {
  const page = await notion.pages.retrieve({ page_id: pageId }) as any;
  const current = page.properties?.Tags?.multi_select?.map((s: any) => s.name) ?? [];
  return notion.pages.update({ page_id: pageId, properties: { Tags: { multi_select: [...new Set([...current, ...tags])].map(t => ({ name: t })) } } });
}

export async function replaceTags(notion: Client, pageId: string, tags: string[]) {
  return notion.pages.update({ page_id: pageId, properties: { Tags: { multi_select: tags.map(t => ({ name: t })) } } });
}

export async function removeTags(notion: Client, pageId: string, tagsToRemove: string[]) {
  const page = await notion.pages.retrieve({ page_id: pageId }) as any;
  const removeSet = new Set(tagsToRemove);
  const kept = (page.properties?.Tags?.multi_select?.map((s: any) => s.name) ?? []).filter((t: string) => !removeSet.has(t));
  return notion.pages.update({ page_id: pageId, properties: { Tags: { multi_select: kept.map((t: string) => ({ name: t })) } } });
}

export async function archiveEntry(notion: Client, pageId: string, archived = true) {
  return notion.pages.update({ page_id: pageId, archived } as any);
}

export async function updateProps(notion: Client, pageId: string, props: Record<string, any>) {
  return notion.pages.update({ page_id: pageId, properties: props } as any);
}

// ── Block Operations ──

export async function appendBlocks(notion: Client, pageId: string, blocks: NotionBlock[]) {
  return notion.blocks.children.append({ block_id: pageId, children: blocks as any });
}

export async function replaceAllBlocks(notion: Client, pageId: string, blocks: NotionBlock[]) {
  const existing = await getBlocks(notion, pageId, 100);
  for (const b of existing) { try { await notion.blocks.delete({ block_id: b.id } as any); } catch {} }
  await notion.blocks.children.append({ block_id: pageId, children: blocks as any });
}

export async function appendMarkdown(notion: Client, pageId: string, markdown: string) {
  return notion.blocks.children.append({ block_id: pageId, children: parseMarkdownToBlocks(markdown) as any });
}
