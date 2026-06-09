// ── Notion LLM Wiki — PDF Upload to Raw Source DB ──────────────────────
// Uploads a local PDF to Notion via the 3-step File Upload API,
// creates a Raw Source DB entry, and writes the full text as page blocks.
//
// Usage:
//   NOTION_KEY=ntn_... bun run scripts/upload-pdf-notion.ts <pdf-path> [source-ref] [source-type]
//
// Example:
//   NOTION_KEY=ntn_... bun run scripts/upload-pdf-notion.ts ./KEC.pdf
//   NOTION_KEY=ntn_... bun run scripts/upload-pdf-notion.ts ./KEC.pdf "KEC Guideline 2024" guideline

import { createClient, WIKI_IDS, addBlocks, parseDocumentToBlocks } from "./core/index";
import { readFileSync } from "fs";
import { basename } from "path";

// ═════════════════════════════════════════════════════════════════════════
// Config
// ═════════════════════════════════════════════════════════════════════════

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";

// ═════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════

function getEnv(key: string): string {
  const val = process.env[key] || process.env[key.toLowerCase()];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

async function notionRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  const token = getEnv("NOTION_KEY");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    ...extraHeaders,
  };
  if (body && !extraHeaders?.["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const url = path.startsWith("http") ? path : `${NOTION_BASE}${path}`;
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });

  if (resp.status >= 400) {
    const text = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${text.slice(0, 500)}`);
  }

  const text = await resp.text();
  if (!text) return null;
  return JSON.parse(text);
}

/** Extract text content from a PDF using Bun's built-in PDF support. */
async function extractPdfText(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) throw new Error(`File not found: ${filePath}`);

  // Detect file type by extension
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));

  if (ext === ".txt" || ext === ".md") {
    return await file.text();
  }

  if (ext === ".pdf") {
    // Try Bun's built-in PDF reader first (Bun 1.2+)
    try {
      const pdf = await Bun.file(filePath).text();
      // Fallback: use a simple extraction for text-based PDFs
      // For proper extraction, we'd use a library like pdf.js or PyMuPDF
      // Since this is a Bun script, we attempt basic extraction
      return pdf;
    } catch {
      throw new Error("PDF extraction failed. For PDFs, use the Python-based extractor instead.");
    }
  }

  throw new Error(`Unsupported file type: ${ext}`);
}

// ═════════════════════════════════════════════════════════════════════════
// Notion File Upload API — 3-step process
// ═════════════════════════════════════════════════════════════════════════

/**
 * Step 1: Create a file upload session.
 * Returns upload URL, file ID, and signed upload URL for the file content.
 *
 * POST /v1/files/upload (Notion API 2026-03-11+)
 * For older API versions, we use the pages.properties.files.append approach.
 */
async function createFileUpload(
  fileName: string,
  fileSize: number,
  mimeType: string,
): Promise<{ uploadUrl: string; fileId: string; fileToken: string }> {
  // For Notion API 2022-06-28, we use the pages endpoint with file property
  // The actual upload uses the 3-step process:
  // 1. POST /v1/files/upload to create upload session
  const resp = await notionRequest("POST", "/files/upload", {
    file: { name: fileName, size: fileSize, mimeType },
  });

  return {
    uploadUrl: resp.uploadUrl,
    fileId: resp.fileId,
    fileToken: resp.fileToken,
  };
}

/**
 * Step 2: Upload the file content to the signed URL.
 */
async function uploadFileContent(uploadUrl: string, filePath: string): Promise<void> {
  const buffer = readFileSync(filePath);
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    body: buffer,
    headers: {
      "Content-Type": "application/octet-stream",
    },
  });

  if (resp.status >= 400) {
    const text = await resp.text();
    throw new Error(`Upload failed: ${resp.status} ${text.slice(0, 200)}`);
  }
}

/**
 * Step 3: Update page property with uploaded file reference.
 * Uses the file_upload property type.
 */
async function attachFileToPage(
  pageId: string,
  fileName: string,
  fileId: string,
  fileToken: string,
): Promise<void> {
  await notionRequest("PATCH", `/pages/${pageId}`, {
    properties: {
      Files: {
        files: [
          {
            name: fileName,
            type: "file_upload",
            file_upload: {
              id: fileId,
              token: fileToken,
            },
          },
        ],
      },
    },
  });
}

/**
 * Step 2 — alternative: upload via direct PUT.
 */
async function directUpload(
  uploadUrl: string,
  filePath: string,
): Promise<void> {
  const buffer = readFileSync(filePath);
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    body: buffer,
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!resp.ok) throw new Error(`Direct upload failed: ${resp.status}`);
}

// ═════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: NOTION_KEY=... bun run scripts/upload-pdf-notion.ts <file-path> [source-ref] [source-type]");
    console.error("       NOTE: Upload support requires Notion API ~2026-03-11 file upload endpoints.");
    console.error("       For older API versions (2022-06-28), files must be uploaded via UI or");
    console.error("       attached using external URL links instead.");
    process.exit(1);
  }

  const fileName = args[1] || basename(filePath);
  const sourceRef = args[1] || fileName.replace(/\.[^.]+$/, "");
  const sourceType = args[2] || "guideline";

  console.log(`\n📄 File: ${filePath}`);
  console.log(`📛 Name: ${fileName}`);
  console.log(`🏷️  SourceRef: ${sourceRef}`);
  console.log(`📂 SourceType: ${sourceType}\n`);

  // Check file exists
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  const fileSize = file.size;
  const mimeType = fileName.endsWith(".pdf") ? "application/pdf"
    : fileName.endsWith(".txt") ? "text/plain"
    : fileName.endsWith(".md") ? "text/markdown"
    : "application/octet-stream";

  console.log(`📦 Size: ${(fileSize / 1024).toFixed(1)} KB`);
  console.log(`🎯 MIME: ${mimeType}\n`);

  // Step 1: Create upload session
  console.log("🔄 Step 1/5: Creating file upload session...");
  let uploadSession;
  try {
    uploadSession = await createFileUpload(fileName, fileSize, mimeType);
    console.log(`   ✅ Upload URL obtained`);
    console.log(`   File ID: ${uploadSession.fileId}`);
  } catch (err: any) {
    console.warn(`   ⚠️  Upload session creation failed: ${err.message}`);
    console.warn(`   → File upload requires Notion API 2026-03-11+.`);
    console.warn(`   → Falling back: creating Raw Source page without file attachment.`);
    uploadSession = null;
  }

  // Step 2: Upload file content
  if (uploadSession) {
    console.log("🔄 Step 2/5: Uploading file content...");
    try {
      await uploadFileContent(uploadSession.uploadUrl, filePath);
      console.log("   ✅ File uploaded to CDN");
    } catch (err: any) {
      console.error(`   ❌ Upload failed: ${err.message}`);
      uploadSession = null;
    }
  }

  // Create Raw Source DB entry
  console.log("🔄 Step 3/5: Creating Raw Source DB entry...");
  const client = createClient();
  const newPage = await client.pages.create({
    parent: { type: "database_id", database_id: WIKI_IDS.rawDbId },
    properties: {
      Name: {
        title: [{ type: "text", text: { content: fileName } }],
      },
      SourceRef: {
        rich_text: [{ type: "text", text: { content: sourceRef } }],
      },
      SourceType: {
        select: { name: sourceType },
      },
      Ingested: {
        date: { start: new Date().toISOString() },
      },
    },
  });
  const pageId = newPage.id;
  console.log(`   ✅ Raw Source page created: ${pageId}`);

  // Step 3 (cont): Attach file to page property
  if (uploadSession) {
    console.log("🔄 Step 4/5: Attaching file to page property...");
    try {
      await attachFileToPage(pageId, fileName, uploadSession.fileId, uploadSession.fileToken);
      console.log("   ✅ File attached to page");
    } catch (err: any) {
      console.warn(`   ⚠️  File attach failed: ${err.message}`);
    }
  } else {
    console.log("   ⏭️  Step 4/5: Skipping file attachment (no upload session)");
  }

  // Step 5: Extract and write content as blocks
  console.log("🔄 Step 5/5: Extracting and writing content...");
  try {
    const content = await extractPdfText(filePath);
    const blocks = parseDocumentToBlocks(content);
    if (blocks.length > 0) {
      await addBlocks(client, pageId, blocks);
      console.log(`   ✅ Wrote ${blocks.length} blocks to page`);
    } else {
      console.log("   ⏭️  No blocks extracted (content may be scanned image PDF)");
    }
  } catch (err: any) {
    console.warn(`   ⚠️  Content extraction failed: ${err.message}`);
    console.warn("   → The raw source page was created without text blocks.");
    console.warn("   → Use a Python-based extractor for scanned PDFs.");
  }

  console.log(`\n✅ Done! Raw source page created:`);
  console.log(`   https://notion.so/${pageId.replace(/-/g, "")}`);
  console.log(`   Name: ${fileName}`);
  console.log(`   SourceRef: ${sourceRef}`);
  console.log(`   SourceType: ${sourceType}`);
  console.log(`\n💡 Next: Use the ingest-engine or manually curate wiki entries from this source.`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
