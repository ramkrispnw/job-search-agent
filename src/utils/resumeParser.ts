// src/utils/resumeParser.ts — extract plain text from PDF, DOCX, or .txt

import * as fs from "fs-extra";
import * as path from "path";

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
