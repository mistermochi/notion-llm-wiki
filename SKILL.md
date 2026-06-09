---
name: notion-llm-wiki
description: >-
  Karpathy's LLM Wiki adapted for Notion — build/query a compounding knowledge
  base via the Notion REST API
---

## Core Concept

Build and maintain a persistent, compounding knowledge base in a Notion database.
Based on Andrej Karpathy's LLM Wiki pattern.

**Why this, not RAG:** Traditional RAG rediscovers knowledge from scratch per query.
A wiki compiles knowledge once and keeps it current. Cross-references are already
there. Contradictions have already been flagged. Each ingest makes entries richer.

**Division of labor:** The human curates sources and directs analysis. The agent
summarises, cross-references, files, and maintains consistency.

## Architecture

```
🧠 Parent page
├── 📄 Raw Sources DB    Layer 1: Immutable source archive
├── 📊 Wiki Database     Layer 2: The wiki (synthesised concept entries)
├── ⚙️ Schema            Layer 3: Conventions & rules
└── 📝 Log               Action history
```

## Prerequisites

- Notion API key saved as `notion-api-key` (kv-env, `NOTION_KEY`)
- Integration shared with Wiki DB + Raw Sources DB
- Dependencies: `@notionhq/client` ^5.22.0 (`cd scripts && bun install`)

## Workspace IDs

| Component | ID |
|---|---|
| Parent page | `3743e72a1ade810794eedfb282309f38` |
| Wiki DB | `4f5243a6-654f-477d-83db-946b2fd65fe6` |
| Raw Sources DB | `3743e72a-1ade-81e9-be4f-db034b1db199` |
| Log page | `3743e72a-1ade-8176-b0b1-fce35fd9ab37` |
| Schema page | `3743e72a-1ade-81a9-84d3-ffd01f1e7dde` |

## Schema

### Tags
`clinical`, `exam`, `style`, `template`, `reference`, `meta`, `log`

### Entry Types
`entity`, `concept`, `comparison`, `query`, `summary`, `template`, `rubric`, `guide`

### Content Rules
- **Cross-references:** Every entry @-mentions ≥1 other (page UUID, not name)
- **Confidence:** high | medium | low
- **Status:** active | draft | needs-review | contested | archived
- **Provenance:** `^[source-ref]` at paragraph end. `^[inference]` for agent claims
- **Contradictions:** Both entries → Status: contested. Never silent overwrite
- **Split** entries >200 lines. **Archive** superseded (never delete)

### Log Format
`YYYY-MM-DD action | Subject`. Actions: init, ingest, update, query, lint, create, archive, consolidate. Rotate at ~500 entries.

## Operations

### 0. Orient (every session)
1. Fetch Schema page
2. Fetch Log — scan last 10-20 entries
3. Query both databases
4. Verify components nested under parent

### 1. Ingest
1. **Read & Discuss** (human). Read source. Discuss takeaways.
2. **Archive Raw Source** — `NOTION_KEY=... bun run scripts/ingest-engine.ts`
3. **Extract Key Concepts** — entities, findings
4. **Check Existing Wiki** — search by keyword/type/tags
5. **Consolidate** — update existing, create new if passes thresholds
6. **Update Log** — record created/updated + source consumed

### 2. Query
1. Search Wiki DB with filters
2. Fetch entry content
3. Synthesise answer citing entries
4. File substantial answers as Type: query
5. Log

### 3. Lint
`NOTION_KEY=... bun run scripts/vault-lint.ts`
Checks: property completeness, staleness (>6mo warned, >1yr flagged), duplicates, orphan raw sources.

Manual: cross-ref audit, tag audit, source drift, page size >200b, log rotation.

### 4. Archive / Bulk
- Confirm with user first
- Log before and after
- Run lint after

## Raw Source Workflow (v3) — Agent-Driven Document Ingest

An alternative to the entry-based ingest engine. Instead of writing curated
wiki entries by hand, this pipeline ingests an uploaded document as a complete
raw source page with full text, CDN-hosted file, and searchable metadata.

**When to use:** A user uploads a PDF/document and wants the full text stored
as a searchable raw source page, optionally with curated wiki entries derived
later.

### 5-step pipeline

```
Upload ──→ Discuss ──→ Extract ──→ Write Body ──→ Update Metadata
```

1. **Upload attachment** to a blank Raw Source DB entry using Notion's File
   Upload API (3-step: `fileUploads.create` → `fileUploads.send` → attach to
   page File property). File lands on Notion's permanent S3 CDN.
2. **Discuss with user** — SourceRef, SourceType, format preferences.
3. **Extract contents** — PyMuPDF for PDFs, Bun.file.text() for plain text,
   python-docx for .docx, etc.
4. **Write full content into body** — heading-detection heuristic converts
   text to Notion heading_2/heading_3/paragraph blocks, chunked into batches
   of 100.
5. **Update metadata** — Name, SourceRef, SourceType, Ingested, Content
   (rich_text for vector search).

Full reference: `references/raw-source-workflow.md`.

## Wholedoc Mode (v2)

Large guideline PDFs should NOT be split into separate wiki entries manually.
Use `wholedoc` mode for documents likely to exceed 200 lines.

### How it works

1. Set `MODE = "wholedoc"` at the top of `scripts/ingest-engine.ts`
2. Edit the `WHOLE_DOC` config with your source name and SourceRef
3. If the document was already uploaded to Notion (e.g. as duplicate pages),
   set `EXISTING_PAGE_IDS` to merge them automatically
4. The engine will: find duplicates by SourceRef → merge child-page blocks
   (deduping duplicates) → archive raw source → create one wiki entry

### Standalone merge: `scripts/merge/merge-pages.ts`

For ad-hoc merging of already-uploaded duplicates:

```shellscript
NOTION_KEY=ntn_... bun run scripts/merge/merge-pages.ts --source-ref "CCIDER-EH-001(V3.1)"
NOTION_KEY=ntn_... bun run scripts/merge/merge-pages.ts --source-ref "CCIDER-EH-001(V3.1)" --dry-run
```

Options: `--target-name` `--dry-run` `--parent-id` `--db`

### Key functions added to core

| Function | Purpose |
|---|---|
| `readAllBlocks(notion, pageId)` | Paginated reads ALL blocks from a page |
| `findPagesBySourceRef(notion, dbId, sourceRef)` | Find duplicates by SourceRef property |
| `dedupChildPages(blocks)` | Dedup child_page blocks by title, keep first |
| `mergePages(notion, pageIds, title, parentId)` | Full merge: read → dedup → create → trash |
| `parseDocumentToBlocks(text)` | Plain text → Notion blocks (handles 2000-char limit) |

## Scripts Index

| File | Purpose | Usage |
|---|---|---|
| `scripts/core/index.ts` | Shared types, client, API ops, block builders | Imported by others |
| `scripts/query/query.ts` | Search, agent query parsing, proximity recall | `import { searchWikiDb } from "./query/query"` |
| `scripts/maintain/maintain.ts` | Create/update entries, manage blocks | `import { createWikiEntry } from "./maintain/maintain"` |
| `scripts/bulk/bulkOps.ts` | Batch archive, status update, dry-run | `import { archiveByCriteria } from "./bulk/bulkOps"` |
| `scripts/export/exportWiki.ts` | Full workspace export to MD | `import { fullExport } from "./export/exportWiki"` |
| `scripts/ingest-engine.ts` | Orient→Archive→Consolidate→Log pipeline | `bun run scripts/ingest-engine.ts` |
| `scripts/vault-lint.ts` | Property completeness + staleness checks | `bun run scripts/vault-lint.ts` |
| `scripts/merge/merge-pages.ts` | Duplicate page merge & consolidation (ad-hoc) | `bun run scripts/merge/merge-pages.ts --source-ref ...` |
| `scripts/upload-pdf-notion.ts` | Upload file to Notion CDN via 3-step File Upload API | `NOTION_KEY=... bun run scripts/upload-pdf-notion.ts` |

**Reference docs** in `references/` folder — use `readReference` to load on demand.


## Pitfalls
- Integration must be shared with **both** databases (404 = missing share)
- MCP replace_content stores plain text — use direct API for blocks
- DB properties are typed — `{"select": {"name": "value"}}`, not strings
- @-mentions need page UUIDs — query DB first
- Raw sources are immutable — corrections go in wiki entries
- No 1:1 source-to-entry copies — consolidate
- 2000-char limit per rich_text segment (handled by `makeRich()`)
- No deletion API — use `Status: archived`
- executeCode() misses injected env vars — use runCommand with `bash -c "source ~/.creds.env && bun run script.ts"`
- Always update Log — skipping degrades the wiki
- Always orient first — prevents dupes and missed cross-refs
