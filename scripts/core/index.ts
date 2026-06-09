// ── Notion LLM Wiki — Core Module ───────────────────────────────────────
// Consolidated: types + client + API ops + block mapping + rich-text.
// v2 — added wholedoc merge pipeline: readAllBlocks, findPagesBySourceRef,
// dedupChildPages, mergePages, parseDocumentToBlocks

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

/** Whole-document ingest config — ingests a large document as a single wiki entry */
export type WholeDocConfig = {
  mode: "wholedoc";
  name: string;
  source_ref: string;
  source_type: string;
  file_path?: string;
  /** Optional: split into multiple wiki entries at heading level 2 (if true) */
  split_by_heading_2?: boolean;
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
  return new Client({ auth: raw.trim(), notionVersion: "2022-06-28" });
}

// ═════════════════════════════════════════════════════════════════════════
// Notion API Operations
// ═════════════════════════════════════════════════════════════════════════

export interface NotionPage {
  id: string;
  properties: Record<string, PropVal>;
}

export interface RawNotionBlock {
  object: string;
  id: string;
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
  // Append in batches of 100 to stay within API limits
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await notion.blocks.children.append({ block_id: pageId, children: batch as any });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Wholedoc: Paginated Block Reading
// ═════════════════════════════════════════════════════════════════════════

/** Read ALL blocks from a page, following pagination. Yields up to `max` blocks. */
export async function readAllBlocks(
  notion: Client,
  pageId: string,
  max = 10_000,
): Promise<RawNotionBlock[]> {
  const all: RawNotionBlock[] = [];
  let cursor: string | null | undefined;
  while (all.length < max) {
    const resp: any = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const b of resp.results) {
      if (!(b as any).archived && !(b as any).in_trash) {
        all.push(b as RawNotionBlock);
      }
    }
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return all;
}

// ═════════════════════════════════════════════════════════════════════════
// Wholedoc: Duplicate Detection & Page Merge
// ═════════════════════════════════════════════════════════════════════════

/**
 * Find all pages in a database that have a matching SourceRef.
 * Useful for detecting duplicate ingests of the same document.
 */
export async function findPagesBySourceRef(
  notion: Client,
  dbId: string,
  sourceRef: string,
): Promise<NotionPage[]> {
  return queryAll(notion, dbId, {
    property: "SourceRef",
    rich_text: { equals: sourceRef },
  });
}

/** Dedup child_page blocks by title. Keeps the first occurrence of each unique title. */
export function dedupChildPages(
  blocks: RawNotionBlock[],
): { unique: RawNotionBlock[]; duplicates: RawNotionBlock[]; deduped: string[] } {
  const seen = new Map<string, number>();  // title -> first index
  const unique: RawNotionBlock[] = [];
  const duplicates: RawNotionBlock[] = [];
  const deduped: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === "child_page") {
      const title = (b.child_page as any)?.title ?? "";
      if (seen.has(title)) {
        duplicates.push(b);
        if (!deduped.includes(title)) deduped.push(title);
      } else {
        seen.set(title, i);
        unique.push(b);
      }
    } else {
      unique.push(b);
    }
  }
  return { unique, duplicates, deduped };
}

/**
 * Merge multiple duplicate pages into one consolidated page.
 * 1. Reads all blocks from source pages
 * 2. Dedup child_page blocks by title
 * 3. Creates a new page under parentPageId
 * 4. Writes blocks in batches of 100
 * 5. Trashes source pages
 * 6. Returns the new page ID
 */
export async function mergePages(
  notion: Client,
  pageIds: string[],
  targetTitle: string,
  parentPageId: string,
): Promise<{ newPageId: string; blocksWritten: number; deduped: string[] }> {
  // 1. Read all blocks from all source pages
  const allBlocks: RawNotionBlock[] = [];
  for (const pid of pageIds) {
    const blocks = await readAllBlocks(notion, pid);
    allBlocks.push(...blocks);
  }

  // 2. Dedup child_page blocks
  const { unique, duplicates, deduped } = dedupChildPages(allBlocks);

  // 3. Convert to WikiBlocks (preserve block types)
  const wikiBlocks: WikiBlock[] = [];
  for (const b of unique) {
    const bt = b.type as string;
    const inner = (b as any)[bt];
    if (!inner) continue;
    switch (bt) {
      case "paragraph":
      case "heading_1":
      case "heading_2":
      case "heading_3":
        wikiBlocks.push({ [bt]: { rich_text: inner.rich_text ?? [] } } as any);
        break;
      case "bulleted_list_item":
      case "numbered_list_item":
        wikiBlocks.push({ [bt]: { rich_text: inner.rich_text ?? [] } } as any);
        break;
      case "to_do":
        wikiBlocks.push({ to_do: { rich_text: inner.rich_text ?? [], checked: inner.checked ?? false } } as any);
        break;
      case "callout":
        wikiBlocks.push({ callout: { rich_text: inner.rich_text ?? [], icon: inner.icon } } as any);
        break;
      case "divider":
        wikiBlocks.push({ divider: {} });
        break;
      case "quote":
        wikiBlocks.push({ quote: { rich_text: inner.rich_text ?? [] } } as any);
        break;
      case "code":
        wikiBlocks.push({ code: { rich_text: inner.rich_text ?? [], language: inner.language ?? "plain text" } } as any);
        break;
      case "child_page":
        // child_page blocks reference other pages; we preserve them
        wikiBlocks.push({ child_page: { title: inner.title ?? "Untitled" } } as any);
        break;
      default:
        // Unsupported block type — skip silently
        break;
    }
  }

  // 4. Create new page
  const newPage = await notion.pages.create({
    parent: { type: "page_id", page_id: parentPageId },
    properties: {
      title: { title: [{ type: "text", text: { content: targetTitle } }] },
    },
  });

  const newPageId = newPage.id;

  // 5. Write blocks in batches of 100
  for (let i = 0; i < wikiBlocks.length; i += 100) {
    const batch = wikiBlocks.slice(i, i + 100);
    await notion.blocks.children.append({ block_id: newPageId, children: batch as any });
  }

  // 6. Trash source pages
  for (const pid of pageIds) {
    try {
      await notion.pages.update({ page_id: pid, archived: true });
    } catch {
      // Some pages may already be trashed
    }
  }

  return { newPageId, blocksWritten: wikiBlocks.length, deduped };
}

// ═════════════════════════════════════════════════════════════════════════
// Wholedoc: Text-to-Blocks (for file upload)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Parse plain text content into paragraph blocks.
 * Handles 2000-char rich text limit per segment.
 * Detects lines that look like headings (## ... or 1. Introduction) and
 * converts them to heading blocks.
 */
export function parseDocumentToBlocks(text: string): WikiBlock[] {
  const lines = text.split("\n");
  const blocks: WikiBlock[] = [];
  let paraLines: string[] = [];

  function flushPara() {
    if (paraLines.length === 0) return;
    const joined = paraLines.join(" ").trim();
    if (joined) {
      // Handle long paragraphs by splitting at 2000-char boundaries
      let remaining = joined;
      while (remaining) {
        const chunk = remaining.slice(0, 2000);
        remaining = remaining.slice(2000);
        blocks.push({ paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] } });
      }
    }
    paraLines = [];
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); continue; }

    // Detect headings: "## ..." or "# ..." or "1. Introduction" pattern
    const h2Match = line.match(/^##\s+(.+)/);
    const h3Match = line.match(/^###\s+(.+)/);
    const h1Match = line.match(/^#\s+(.+)/);
    const numberedHeading = line.match(/^(\d+)\.\s+(.+)/);

    if (h1Match) {
      flushPara();
      blocks.push({ heading_1: { rich_text: [{ type: "text", text: { content: h1Match[1] } }] } });
    } else if (h2Match) {
      flushPara();
      blocks.push({ heading_2: { rich_text: [{ type: "text", text: { content: h2Match[1] } }] } });
    } else if (h3Match) {
      flushPara();
      blocks.push({ heading_3: { rich_text: [{ type: "text", text: { content: h3Match[1] } }] } });
    } else if (/^---/.test(line)) {
      flushPara();
      blocks.push({ divider: {} });
    } else if (/^-\s/.test(line)) {
      flushPara();
      const text = line.replace(/^-\s+/, "");
      blocks.push({ bulleted_list_item: { rich_text: [{ type: "text", text: { content: text } }] } });
    } else if (/^>\s/.test(line)) {
      flushPara();
      const text = line.replace(/^>\s+/, "");
      blocks.push({ quote: { rich_text: [{ type: "text", text: { content: text } }] } });
    } else {
      paraLines.push(line);
    }
  }
  flushPara();
  return blocks;
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
