# Raw Source Workflow (v3)

A 5-step pipeline for taking an uploaded document from a blank Raw Source DB entry to a fully populated, searchable, CDN-hosted page.

```
Upload ──→ Discuss ──→ Extract ──→ Write Body ──→ Update Metadata
```

## Prerequisites

| Item | Detail |
|------|--------|
| **Raw Sources DB** | `3743e72a-1ade-81e9-be4f-db034b1db199` |
| **File property** | Raw DB `File` (Files-type) for CDN-hosted attachment |
| **Content property** | `Content` (rich_text) for LLM vector search |
| **Notion API version** | `2026-03-11` (supports `fileUploads.*`) |
| **Notion key** | `NOTION_KEY` env var with integration token |

## Step 1 — Upload Attachment to Blank Raw Source Entry

### 3-step File Upload API

| Step | API | What it does |
|------|-----|-------------|
| 1 | `POST /v1/file_uploads` | Create upload session → `file_upload_id` |
| 2 | `POST /v1/file_uploads/{id}/send` | Send binary as multipart → lands on Notion S3 |
| 3 | `PATCH /v1/pages/{id}` | Set File property → Notion resolves to permanent CDN URL |

### TypeScript

```typescript
// Step 1
const upload = await notion.fileUploads.create({
  mode: "single_part",
  filename: "document.pdf",
  content_type: "application/pdf"
});

// Step 2
const fileBinary = await Bun.file("/path/to/document.pdf").arrayBuffer();
await notion.fileUploads.send({
  file_upload_id: upload.id,
  file: { data: new Uint8Array(fileBinary), filename: "document.pdf" }
});

// Step 3
await notion.pages.update({
  page_id: rawPageId,
  properties: {
    File: {
      files: [{
        name: "document.pdf",
        type: "file_upload",
        file_upload: { id: upload.id }
      }]
    }
  }
});
```

**Result:** File stored on Notion CDN at `https://prod-files-secure.s3.us-west-2.amazonaws.com/...` — permanent, no expiry.

## Step 2 — Discuss with User

Key questions before processing:

1. **SourceRef** — unique reference code (e.g. `KEC-GL-001`, `HAHO-OPS-9/2015`)
2. **SourceType** — `guideline`, `policy`, `newsletter`, `reference`, etc.
3. **Body format** — full text or summary? Headings preserved?
4. **Wiki entries** — create curated entries from this source, or just raw source?
5. **Special handling** — sections to keep/skip, formatting preferences

### Typical response

```
SourceRef: "KEC-GL-MGMT-OCC-BBF-032024"
SourceType: "guideline"
Format: full body with headings preserved
```

## Step 3 — Extract Contents

### PDFs (PyMuPDF)

```python
import fitz
doc = fitz.open("/path/to/document.pdf")
text = "\n\n".join(page.get_text() for page in doc)
```

Preserves paragraph structure and headings as plain text.

**Limitations:** Tables flatten to space-separated text; columns may interleave; headers/footers may repeat.

### Other formats

| Format | Tool | Notes |
|--------|------|-------|
| `.txt` | `Bun.file(path).text()` | Direct read |
| `.docx` | `python-docx` | Paragraphs + tables |
| `.html` | Cheerio / regex | Strip tags, keep headings |
| `.md` | Direct read | Already markdown |

## Step 4 — Write Full Content Into Body

### Headline detection

```typescript
function detectLevel(line: string): 2 | 3 | null {
  // Heading 2: short uppercase / numbered
  if (/^[A-Z][A-Z\s\/,.-]+$/.test(line.trim()) && line.trim().length < 80) return 2;
  // Heading 3: numbered pattern (e.g. "1.1", "2.3.4")
  if (/^\d+\.\d/.test(line.trim()) && line.trim().length < 100) return 3;
  // "##" prefix
  if (/^[#]+\s/.test(line)) return line.startsWith("## ") ? 2 : 3;
  return null;
}
```

### Block generation

```typescript
function extractTextToBlocks(text: string): WikiBlock[] {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const blocks: WikiBlock[] = [];
  let buffer: string[] = [];

  function flushBuffer() {
    if (buffer.length > 0) {
      blocks.push({ paragraph: { rich_text: makeRich(buffer.join(" ")) } });
      buffer = [];
    }
  }

  for (const line of lines) {
    const headingLevel = detectLevel(line);
    if (headingLevel) { flushBuffer(); blocks.push(makeHeading(line, headingLevel)); }
    else { buffer.push(line); }
  }
  flushBuffer();
  return blocks;
}
```

### Write to page

```typescript
// Remove existing blocks
const existing = await notion.blocks.children.list({ block_id: rawPageId });
for (const block of existing.results) {
  await notion.blocks.delete({ block_id: block.id });
}

// Append — chunk into batches of 100 (Notion limit)
for (let i = 0; i < blocks.length; i += 100) {
  await notion.blocks.children.append({
    block_id: rawPageId,
    children: blocks.slice(i, i + 100)
  });
}
```

## Step 5 — Update Metadata

```typescript
await notion.pages.update({
  page_id: rawPageId,
  properties: {
    Name:       { title: [{ type: "text", text: { content: "Document Name" } }] },
    SourceRef:  { rich_text: [{ type: "text", text: { content: "KEC-GL-001" } }] },
    SourceType: { select: { name: "guideline" } },
    Ingested:   { date: { start: "2026-06-09" } },
    Content:    { rich_text: makeRich(extractedText.slice(0, 200000)) },
  }
});
```

### Metadata fields

| Field | Type | Purpose |
|-------|------|---------|
| `Name` | **title** | Human-readable name |
| `SourceRef` | rich_text | Unique code (dedup key) |
| `SourceType` | select | `guideline` / `policy` / `reference` / `newsletter` |
| `Ingested` | date | Ingest date |
| `Content` | rich_text | Full text for vector search |
| `File` | files | CDN-hosted attachment |
| `sha256` | rich_text | Integrity hash (optional) |
| `WikiEntries` | number | Count of derived wiki entries |

## Edge Cases

| Case | Handling |
|------|----------|
| **Hundreds of pages** | Chunk block writes into batches of 100 |
| **Duplicate document** | Check `SourceRef` first → skip or merge |
| **File > 10MB** | File Upload API handles it; text extraction may need streaming |
| **No detectable headings** | All paragraphs — acceptable |
| **Special characters** | Unicode fine in rich_text |

## Script

`scripts/upload-pdf-notion.ts` — standalone upload-to-CDN script.
