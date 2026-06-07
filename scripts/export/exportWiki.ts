// ── Notion LLM Wiki — Export Module ─────────────────────────────────────

import { Client, collectPaginatedAPI } from "@notionhq/client";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { blockToLine, PropVal, DbQueryResp } from "../core";

export type ExportStats = { files: number; bytes: number; errors: number };

interface SearchItem {
  id: string; object: "page" | "database";
  title?: Array<{ plain_text: string }>;
  properties: Record<string, unknown>;
}

export async function fullExport(notion: Client, outputDir = "./notion-export"): Promise<ExportStats> {
  const stats: ExportStats = { files: 0, bytes: 0, errors: 0 };
  if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
  const items = await collectPaginatedAPI(
    (args: Record<string, unknown>) => notion.search({ ...args, page_size: 100 }), {}
  ) as SearchItem[];
  for (const item of items) {
    try {
      if (item.object === "database") {
        const name = item.title?.[0]?.plain_text || item.id.slice(0, 12);
        const md = await exportDatabase(notion, item.id);
        const fp = path.join(outputDir, `DB__${sanitize(name)}.md`);
        await writeFile(fp, md, "utf-8"); stats.files++; stats.bytes += md.length;
      } else {
        const props = item.properties as Record<string, PropVal>;
        const name = props.title?.title?.[0]?.plain_text || props.Name?.title?.[0]?.plain_text || item.id.slice(0, 12);
        const md = await exportPage(notion, item.id);
        const fp = path.join(outputDir, `${sanitize(name)}.md`);
        await writeFile(fp, md, "utf-8"); stats.files++; stats.bytes += md.length;
      }
    } catch { stats.errors++; }
  }
  return stats;
}

async function exportDatabase(notion: Client, dbId: string): Promise<string> {
  const lines = [`# Database Export`, `Source: ${dbId}\n`];
  const pages = await collectPaginatedAPI(
    (args: Record<string, unknown>) => notion.request<DbQueryResp>({
      path: `databases/${dbId}/query`, method: "post",
      body: { ...(args.start_cursor ? { start_cursor: args.start_cursor } : {}) },
    }), {}
  );
  let count = 0;
  for (const page of pages) {
    count++; lines.push(`## Entry ${count}`, `ID: ${page.id}`);
    for (const [key, val] of Object.entries(page.properties)) {
      const v = val as PropVal;
      let text = "";
      switch (v.type) {
        case "title": text = v.title?.map(t => t.plain_text).join("") || ""; break;
        case "rich_text": text = v.rich_text?.map(t => t.plain_text).join("") || ""; break;
        case "select": text = v.select?.name || ""; break;
        case "multi_select": text = v.multi_select?.map(s => s.name).join(", ") || ""; break;
        case "number": text = String(v.number ?? ""); break;
        case "date": text = v.date?.start || ""; break;
        case "url": text = v.url || ""; break;
        default: text = "?";
      }
      if (text) lines.push(`- **${key}**: ${text}`);
    }
    const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 50 });
    lines.push("");
    for (const block of blocks.results) { const line = blockToLine(block as any); if (line) lines.push(line); }
    lines.push("\n---\n");
  }
  return lines.join("\n");
}

async function exportPage(notion: Client, pageId: string): Promise<string> {
  const { properties } = await notion.pages.retrieve({ page_id: pageId }) as unknown as { properties: Record<string, PropVal> };
  const title = properties.title?.title?.[0]?.plain_text || properties.Name?.title?.[0]?.plain_text || "Untitled";
  const lines = [`# ${title}`, `ID: ${pageId}\n`];
  const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  for (const block of blocks.results) { const line = blockToLine(block as any); if (line) lines.push(line); }
  return lines.join("\n");
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim().replace(/\s+/g, "_").slice(0, 100);
}
