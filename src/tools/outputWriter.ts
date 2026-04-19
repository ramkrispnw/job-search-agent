// src/tools/outputWriter.ts — write daily output to local or Google Drive

import * as fs from "fs-extra";
import * as path from "path";
import { format } from "date-fns";
import { UserConfig } from "../config/types.js";
import { getAuthClient, createFolder, uploadFile, uploadAsGoogleDoc, uploadDocxBuffer } from "./googleDrive.js";
import { markdownToDocxBuffer } from "../utils/markdownToDocx.js";

export interface OutputFile {
  name: string;
  content: string;
  type?: "resume" | "report" | "cover_letter";
}

export async function writeDailyOutput(
  config: UserConfig,
  files: OutputFile[]
): Promise<string> {
  const dateStr = format(new Date(), "yyyy-MM-dd");
  const folderName = `job-search-${dateStr}`;
  const resumeFormat = config.output.resumeFormat ?? "markdown";

  if (config.output.mode === "local") {
    const baseDir = config.output.localPath!.replace("~", process.env.HOME!);
    const dayDir = path.join(baseDir, folderName);
    await fs.ensureDir(dayDir);

    for (const file of files) {
      if (file.type === "resume" && resumeFormat === "word_doc") {
        const docxBuffer = await markdownToDocxBuffer(file.content);
        const docxName = file.name.replace(/\.md$/, ".docx");
        await fs.writeFile(path.join(dayDir, docxName), docxBuffer);
      } else {
        await fs.writeFile(path.join(dayDir, file.name), file.content, "utf8");
      }
    }

    return dayDir;
  }

  // Google Drive
  const gd = config.output.googleDrive!;
  const auth = getAuthClient(gd.clientId, gd.clientSecret, gd.refreshToken);
  const dayFolderId = await createFolder(auth, folderName, gd.folderId);

  const links: string[] = [];
  for (const file of files) {
    let link: string;

    if (file.type === "resume") {
      if (resumeFormat === "google_doc") {
        const docName = file.name.replace(/\.md$/, "");
        link = await uploadAsGoogleDoc(auth, dayFolderId, docName, file.content);
      } else if (resumeFormat === "word_doc") {
        const docxBuffer = await markdownToDocxBuffer(file.content);
        const docxName = file.name.replace(/\.md$/, ".docx");
        link = await uploadDocxBuffer(auth, dayFolderId, docxName, docxBuffer);
      } else {
        link = await uploadFile(auth, dayFolderId, file.name, file.content);
      }
    } else {
      link = await uploadFile(auth, dayFolderId, file.name, file.content);
    }

    links.push(link);
  }

  return `Google Drive folder: ${folderName} (${links.length} files uploaded)`;
}
