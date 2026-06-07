// ── Notion LLM Wiki — Core Module ───────────────────────────────────────
// Consolidated: types + client + API ops + block mapping + rich-text.

import { Client, collectPaginatedAPI } from "@notionhq/client";

// ═════════════════════════════════════════════════════════════════════════
// Types
// ═════════════════════════════════════════════════════════════════════════

export type RichTextSegment = { type: "text"; text: { content: string } };

export type WikiBlock =
  | { heading_2: { rich_text: RichTextSegment[] } }
  | { heading_3: { rich_text: RichTextSegment[] } }
  | { bulleted_list_item: { rich_text: RichTextSegment[] } }
  | { numbered_list_item: { rich_text: RichTextSegment[] } }
  | { paragraph: { rich_text: RichTextSegment[] } }
  | { quote: { rich_text: RichTextSegment[] } }
  | { callout: { rich_text: RichTextSegment[]; icon?: { emoji: string } } }
  | { divider: Record<string, never> }
  | { to_do: { rich_text: RichTextSegment[]; checked: boolean } };

export interface PropVal {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string };
  multi_select?: Array<{ name: string }>;
  number?: number | null;
  date?: { start?: string };
  url?: string;
  files?: Array<{ name: string; type: string; external?: { url: string } }>;
}

export interface DbQueryResp {
  results: Array<{ id: string; properties: Record<string, PropVal> }>;
  has_more: boolean;
  next_cursor: string | null;
  object: "list";
}

export type EntryConfig = {
  name: string;
  type: string;
  tags: string[];
  confidence: "high" | "medium" | "low";
  status: "active" | "draft" | "needs-review" | "contested" | "archived";
  blocks: WikiBlock[];
};

export type RawSource = {
  name: string;
  source_type: string;
  source_ref: string;
  file_path: string;
};

export type LintEntry = {
  id: string;
  name: string;
  type: string;
  status: string;
  tags: string[];
  confidence: string;
  source: string;
  provenance: string;
  updated: string;
};

export type LintCounts = {
  concept: number;
  reference: number;
  comparison: number;
  other: number;
  noType: number;
};

export type WikiIds = {
  wikiDbId: string;
  rawDbId: string;
  schemaPageId: string;
  logPageId: string;
  parentPageId: string;
};

export type PageProp =
  | { title: Array<{ type: "text"; text: { content: string } }> }
  | { rich_text: Array<{ type: "text"; text: { content: string } }> }
  | { number: number }
  | { select: { name: string } }
  | { multi_select: Array<{ name: string }> }
  | { date: { start: string } }
  | { url: string }
  | { files: Array<{ name: string; type: string; file_upload?: { id: string }; external?: { url: string } }> };

export const WIKI_IDS: WikiIds = {
  wikiDbId: "4f5243a6-654f-477d-83db-946b2fd65fe6",
  rawDbId: "3743e72a-1ade-81e9-be4f-db034b1db199",
  schemaPageId: "3743e72a-1ade-81a9-84d3-ffd01f1e7dde",
  logPageId: "3743e72a-1ade-8176-b0b1-fce35fd9ab37",
  parentPageId: "3743e72a1ade810794eedfb282309f38",
};

// ═════════════════════════════════════════════════════════════════════════
// Client Factory
// ═════════════════════════════════════════════════════════════════════════

export function createClient(): Client {
  const raw = process.env.NOTION_KEY || process.env.NOTION_TOKEN;
  if (!raw) throw new Error("NOTION_KEY not set");
  const key = raw.trim();
  return new Client({ auth: key, notionVersion: "2022-06-28" });
}

// ═════════════════════════════════════════════════════════════════════════
// Notion API Operations
// ═════════════════════════════════════════════════════════════════════════

export interface NotionPage {
  id: string;
  properties: Record<string, PropVal>;
}

interface RawNotionBlock {
  type: string;
  [key: string]: unknown;
}

export async function queryAll(
  notion: Client,
  databaseId: string,
  filter?: Record<string, unknown>,
): Promise<NotionPage[]> {
  const results = await collectPaginatedAPI(
    (args: Record<string, unknown>) =>
      notion.request({
        path: `databases/${databaseId}/query`,
        method: "post",
        body: {
          ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}),
          ...(filter ? { filter } : {}),
        },
      }),
    {},
  );
  return results as NotionPage[];
}

export function getPropVal(
  page: NotionPage,
  field: string,
): string | string[] | number | null {
  const p = page.properties?.[field];
  if (!p) return null;
  switch (p.type) {
    case "title":        return p.title?.map(t => t.plain_text).join("") ?? null;
    case "rich_text":    return p.rich_text?.map(t => t.plain_text).join("") ?? null;
    case "select":       return p.select?.name ?? null;
    case "multi_select": return p.multi_select?.map(s => s.name) ?? null;
    case "number":       return p.number ?? null;
    case "date":         return p.date?.start ?? null;
    case "url":          return p.url ?? null;
    case "files":        return p.files?.[0]?.external?.url ?? null;
    default:             return "?";
  }
}

export async function getBlocks(
  notion: Client,
  pageId: string,
  limit = 100,
): Promise<RawNotionBlock[]> {
  const resp = await notion.blocks.children.list({
    block_id: pageId,
    page_size: limit,
  });
  return resp.results as RawNotionBlock[];
}

export async function addBlocks(
  notion: Client,
  pageId: string,
  blocks: WikiBlock[],
): Promise<void> {
  await notion.blocks.children.append({ block_id: pageId, children: blocks as any });
}

// ═════════════════════════════════════════════════════════════════════════
// Rich-Text / WikiBlock Builders
// ═════════════════════════════════════════════════════════════════════════

export function makeRich(text: string): RichTextSegment[] {
  const segments: RichTextSegment[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    segments.push({ type: "text", text: { content: text.slice(i, i + 2000) } });
  }
  return segments;
}

export function makeBullet(text: string): WikiBlock {
  return { bulleted_list_item: { rich_text: makeRich(text) } };
}

export function makeHeading(text: string, level: 2 | 3 = 2): WikiBlock {
  const key = `heading_${level}` as const;
  return { [key]: { rich_text: [{ type: "text", text: { content: text } }] } } as WikiBlock;
}

export function makeDivider(): WikiBlock {
  return { divider: {} };
}

export function makeCallout(text: string, emoji = "\u{1F4A1}"): WikiBlock {
  return { callout: { rich_text: makeRich(text), icon: { emoji } } };
}

// ═════════════════════════════════════════════════════════════════════════
// Block-to-Markdown & Inverse
// ═════════════════════════════════════════════════════════════════════════

interface BlockShape {
  type: string;
  [key: string]: unknown;
}

function plainText(segments?: Array<{ plain_text?: string }>): string {
  return segments?.map(s => s.plain_text ?? "").join("") ?? "";
}

export function blockToLine(block: BlockShape): string | null {
  const { type } = block;
  const b = block as Record<string, any>;
  const segments: Array<{ plain_text?: string }> = b[type]?.rich_text ?? [];
  switch (type) {
    case "paragraph":          return plainText(segments) || null;
    case "heading_1":          return "# " + plainText(segments);
    case "heading_2":          return "## " + plainText(segments);
    case "heading_3":          return "### " + plainText(segments);
    case "bulleted_list_item": return "- " + plainText(segments);
    case "numbered_list_item": return "1. " + plainText(segments);
    case "to_do":              return "- [" + (b.to_do?.checked ? "x" : " ") + "] " + plainText(segments);
    case "callout":            return "> " + (b.callout?.icon?.emoji ?? "\u{1F4A1}") + " " + plainText(segments);
    case "quote":              return "> " + plainText(segments);
    case "divider":            return "---";
    case "code":               return "```" + (b.code?.language ?? "") + "\n" + (b.code?.rich_text?.map((s: { plain_text?: string }) => s.plain_text).join("") ?? "") + "\n```";
    case "image": {
      const src = b.image?.type === "external" ? b.image.external.url : b.image?.file?.url ?? "";
      return src ? "![" + plainText(segments) + "](" + src + ")" : null;
    }
    default:                   return null;
  }
}

export function blocksToMarkdown(blocks: BlockShape[]): string {
  return blocks.map(b => blockToLine(b)).filter((l): l is string => l !== null).join("\n");
}

export type NotionBlock = Record<string, any>;

export function parseMarkdownToBlocks(md: string): NotionBlock[] {
  const lines = md.split("\n");
  const blocks: NotionBlock[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;
    const text = line.replace(/^#{1,3} /, "").replace(/^- /, "").replace(/^> /, "");
    const rt = [{ type: "text" as const, text: { content: text } }];
    if (/^## /.test(line))          blocks.push({ heading_2: { rich_text: rt } });
    else if (/^### /.test(line))    blocks.push({ heading_3: { rich_text: rt } });
    else if (/^- /.test(line))      blocks.push({ bulleted_list_item: { rich_text: rt } });
    else if (/^\d+\. /.test(line))  blocks.push({ numbered_list_item: { rich_text: rt } });
    else if (/^> /.test(line))      blocks.push({ quote: { rich_text: rt } });
    else if (/^---/.test(line))     blocks.push({ divider: {} });
    else                            blocks.push({ paragraph: { rich_text: rt } });
  }
  return blocks;
}
