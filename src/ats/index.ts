// src/ats/index.ts — orchestrates ATS detection + application routing

import { detectATS, getATSLabel } from "./detector.js";
import { applyLever } from "./lever.js";
import { applyGreenhouse } from "./greenhouse.js";
import { applyWorkday } from "./workday.js";
import { JobResult } from "../tools/webSearch.js";
import { UserConfig } from "../config/types.js";
import * as path from "path";
import * as fs from "fs-extra";
import { markApplied } from "../tracker/index.js";

export interface ApplyOptions {
  config: UserConfig;
  job: JobResult;
  jobId: string;
  tailoredResumePath: string;   // local path to markdown resume
  coverLetterText?: string;
  headless?: boolean;
}

export interface ApplyResult {
  jobId: string;
  company: string;
  title: string;
  atsType: string;
  success: boolean;
  url?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export async function applyToJob(options: ApplyOptions): Promise<ApplyResult> {
  const { config, job, jobId, tailoredResumePath, coverLetterText, headless = true } = options;

  const ats = detectATS(job.url);
  const base: Omit<ApplyResult, "success"> = {
    jobId,
    company: job.company,
    title: job.title,
    atsType: getATSLabel(ats.type)
  };

  if (!ats.canAutoApply) {
    return {
      ...base,
      success: false,
      skipped: true,
      skipReason: `${getATSLabel(ats.type)} — auto-apply not yet supported. Apply manually: ${job.url}`
    };
  }

  // Convert markdown resume to PDF for upload
  const pdfPath = await convertResumeToPdf(tailoredResumePath);

  const candidateName = config.resume.parsedText.split("\n")[0].trim() || "Candidate";
  const email = config.applicantInfo?.email || "";
  const phone = config.applicantInfo?.phone || "";
  const linkedin = config.applicantInfo?.linkedin || "";

  if (!email) {
    return {
      ...base,
      success: false,
      skipped: true,
      skipReason: "No email on file. Run `npm run setup` to add your contact info."
    };
  }

  const payload = {
    name: candidateName,
    email,
    phone,
    resumePath: pdfPath,
    coverLetter: coverLetterText,
    linkedinUrl: linkedin
  };

  let result;
  if (ats.type === "lever")       result = await applyLever(ats.applyUrl, payload, headless);
  else if (ats.type === "greenhouse") result = await applyGreenhouse(ats.applyUrl, payload, headless);
  else if (ats.type === "workday")    result = await applyWorkday(ats.applyUrl, payload, headless);
  else result = { success: false, url: job.url, error: "Unknown ATS" };

  // Update tracker
  if (result.success) {
    markApplied(jobId, `Auto-applied via ${getATSLabel(ats.type)}`);
  }

  return { ...base, ...result };
}

// Convert markdown to PDF using puppeteer
async function convertResumeToPdf(mdPath: string): Promise<string> {
  const { marked } = await import("marked");
  const puppeteer = await import("puppeteer");

  const md = await fs.readFile(mdPath, "utf8");
  const html = `
    <html><head><style>
      body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; font-size: 12px; line-height: 1.5; }
      h1 { font-size: 20px; } h2 { font-size: 15px; border-bottom: 1px solid #ccc; }
      h3 { font-size: 13px; } ul { margin: 4px 0; }
    </style></head><body>${marked(md)}</body></html>
  `;

  const pdfPath = mdPath.replace(".md", ".pdf");
  const browser = await puppeteer.default.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.pdf({ path: pdfPath, format: "Letter", margin: { top: "0.75in", bottom: "0.75in", left: "0.75in", right: "0.75in" } });
  await browser.close();

  return pdfPath;
}
