// src/tools/resumeTailor.ts — generate a tailored resume for a specific role

import { ask } from "../utils/claude";
import { JobResult } from "./webSearch";

export async function tailorResume(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  model: string
): Promise<string> {
  const prompt = `
You are an expert resume writer. Rewrite the candidate's resume to be tailored
specifically for the role below.

## Target Role
Title: ${job.title}
Company: ${job.company}
Description: ${job.description}
Why Candidate Fits: ${job.whyItFits}

## Original Resume
${resumeText}

## Instructions
- Keep all factual information accurate — do NOT invent experience or metrics
- Reorder and reframe existing bullets to emphasize relevance to this role
- Strengthen the professional summary to speak directly to this role
- Prioritize experiences most relevant to ${job.company}'s context
- Mirror keywords from the job description naturally (critical for ATS parsing)
- Keep total length to 1 page equivalent (~600 words max)

## ATS Compliance Rules (strictly follow)
- Use standard section headers: Summary, Experience, Education, Skills
- No tables, columns, text boxes, or graphics — plain linear structure only
- Dates must follow consistent format: "Month YYYY – Month YYYY"
- Use simple bullet points (- ) only; no nested bullets
- Bold only names, titles, and company names — no decorative bold
- No headers/footers, no page numbers
- Spell out abbreviations on first use (e.g. "Product Marketing Manager (PMM)")

Return the full tailored resume in Markdown format. Start with the candidate's name as an H1.
`;

  return ask(apiKey, prompt, "You are an expert resume writer and career coach.", 4096, model);
}
