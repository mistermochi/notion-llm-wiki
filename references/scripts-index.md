# Scripts Index

## Core (`scripts/core/index.ts`)

Shared types, client factory, Notion API operations, block builders, block↔markdown.

| Export | Purpose |
|--------|---------|
| `createClient()` | Create Notion client from NOTION_KEY env |
| `queryAll(notion, dbId, filter?)` | Paginated DB query |
| `getPropVal(page, field)` | Extract typed property value |
| `getBlocks(notion, pageId, limit?)` | Fetch page blocks |
| `readAllBlocks(notion, pageId, max?)` | Paginated: read ALL blocks from a page |
| `findPagesBySourceRef(notion, dbId, sourceRef)` | Find duplicates by SourceRef property |
| `dedupChildPages(blocks)` | Dedup child_page blocks by title, keep first |
| `mergePages(notion, pageIds, title, parentId)` | Full merge: read → dedup → create → trash |
| `parseDocumentToBlocks(text)` | Plain text to Notion blocks (handles 2000-char limit) |
| `addBlocks(notion, pageId, blocks)` | Append blocks (auto-batches 100) |
| `makeRich(text)` | Split text into 2000-char rich-text segments |
| `makeBullet(text)` | Create bullet block |
| `makeHeading(text, level?)` | Create heading block |
| `makeDivider()` / `makeCallout(text, emoji?)` | Divider / callout blocks |
| `blockToLine(block)` → markdown line | Block to markdown |
| `blocksToMarkdown(blocks)` | Blocks to markdown string |
| `parseMarkdownToBlocks(md)` | Markdown to Notion blocks |
| `WIKI_IDS` | Workspace IDs constant |

## Query (`scripts/query/query.ts`)

| Export | Purpose |
|--------|---------|
| `searchWikiDb(notion, dbId, opts?)` | Filter by type/status/tags/name/confidence |
| `searchByTags(notion, dbId, tags, opts?)` | Tag-filtered search |
| `searchByType(notion, dbId, type, opts?)` | Type-filtered search |
| `groupByType(results)` | Group search results by type |
| `getEntry(notion, pageId)` | Single entry by ID |
| `findBySharedTags(notion, dbId, entryId, minOverlap?)` | Tag-based proximity |
| `findBySource(notion, dbId, sourceUrl)` | Entries from one source |
| `proximityGraph(notion, dbId, entryId)` | Tag + type + source proximity |

## Maintain (`scripts/maintain/maintain.ts`)

| Export | Purpose |
|--------|---------|
| `createWikiEntry(notion, dbId, config)` | Single entry |
| `batchUpsertByName(notion, dbId, configs)` | Idempotent batch upsert |
| `setStatus(notion, pageId, status)` | Update status |
| `setConfidence(notion, pageId, confidence)` | Update confidence |
| `addTags/replaceTags/removeTags(notion, pageId, tags[])` | Tag management |
| `archiveEntry(notion, pageId, archived?)` | Archive/restore |
| `updateProps(notion, pageId, props)` | Raw property update |
| `appendBlocks(notion, pageId, blocks)` | Append blocks |
| `replaceAllBlocks(notion, pageId, blocks)` | Full block replace |
| `appendMarkdown(notion, pageId, md)` | Parse MD → append |

## Bulk (`scripts/bulk/bulkOps.ts`)

| Export | Purpose |
|--------|---------|
| `archiveEntries(notion, entries[])` | Archive by IDs |
| `archiveByCriteria(notion, dbId, criteria)` | Archive by type/status/tags/age |
| `batchUpdateStatus(notion, entries[], status)` | Status batch |
| `dryRun(notion, dbId, criteria)` | Preview without mutating |

## Export (`scripts/export/exportWiki.ts`)

| Export | Purpose |
|--------|---------|
| `fullExport(notion, outputDir?)` | Export all DBs/pages to MD files |

## CLI Scripts

| Script | Purpose |
|--------|---------|
| `scripts/ingest-engine.ts` | Orient → Archive → Consolidate → Log (supports entries + wholedoc) |
| `scripts/vault-lint.ts` | Property completeness + staleness checks |
| `scripts/merge/merge-pages.ts` | Ad-hoc duplicate page merge by SourceRef |
