// src/utils/resumeParser.ts — extract plain text from PDF, DOCX, .txt, or Google Doc

import * as fs from "fs-extra";
import * as path from "path";
import * as https from "https";

export function extractGoogleDocId(input: string): string | null {
  // Full URL: https://docs.google.com/document/d/DOC_ID/edit
  const urlMatch = input.match(/\/document\/d\/([a-zA-Z0-9_-]{20,})/);
  if (urlMatch) return urlMatch[1];
  // Bare ID (20+ alphanumeric chars)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  return null;
}

export async function fetchGoogleDoc(docId: string): Promise<string> {
  const url = `https://docs.google.com/document/d/${docId}/export?format=txt`;

  return new Promise((resolve, reject) => {
    const request = (targetUrl: string) => {
      https.get(targetUrl, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode!) && res.headers.location) {
          return request(res.headers.location);
        }
        if (res.statusCode === 403 || res.statusCode === 401) {
          return reject(new Error(
            "Google Doc is private. Share it with \"Anyone with the link can view\" and try again."
          ));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to fetch Google Doc (HTTP ${res.statusCode})`));
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
        res.on("error", reject);
      }).on("error", reject);
    };
    request(url);
  });
}

export async function parseResume(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === ".pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return data.text.trim();
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  if (ext === ".txt" || ext === ".md") {
    return buffer.toString("utf8").trim();
  }

  throw new Error(
    `Unsupported file type: ${ext}. Please upload a PDF, DOCX, TXT, or MD file.`
  );
}
