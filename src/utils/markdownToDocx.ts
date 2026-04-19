// src/utils/markdownToDocx.ts — convert markdown resume text to a Word document buffer

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  IStylesOptions,
} from "docx";

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  // Match **bold**, *italic*, or plain text
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|([^*]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) {
      runs.push({ text: match[1], bold: true });
    } else if (match[2] !== undefined) {
      runs.push({ text: match[2], italic: true });
    } else if (match[3] !== undefined) {
      runs.push({ text: match[3] });
    }
  }
  return runs.length ? runs : [{ text }];
}

function makeParagraph(line: string): Paragraph {
  if (/^### /.test(line)) {
    return new Paragraph({
      text: line.replace(/^### /, ""),
      heading: HeadingLevel.HEADING_3,
    });
  }
  if (/^## /.test(line)) {
    return new Paragraph({
      text: line.replace(/^## /, ""),
      heading: HeadingLevel.HEADING_2,
    });
  }
  if (/^# /.test(line)) {
    return new Paragraph({
      text: line.replace(/^# /, ""),
      heading: HeadingLevel.HEADING_1,
    });
  }
  if (/^[-*] /.test(line)) {
    const runs = parseInline(line.replace(/^[-*] /, ""));
    return new Paragraph({
      bullet: { level: 0 },
      children: runs.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italic })),
    });
  }
  if (line.trim() === "") {
    return new Paragraph({});
  }
  const runs = parseInline(line);
  return new Paragraph({
    children: runs.map(r => new TextRun({ text: r.text, bold: r.bold, italics: r.italic })),
  });
}

export async function markdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const lines = markdown.split("\n");
  const children = lines.map(makeParagraph);

  const doc = new Document({
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
