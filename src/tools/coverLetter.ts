// src/tools/coverLetter.ts — generate a tailored cover letter per role

import { ask } from "../utils/claude.js";
import { JobResult } from "./webSearch.js";

export async function generateCoverLetter(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  candidateName: string,
  model: string
): Promise<string> {
  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });

  const prompt = `
Write a concise, compelling cover letter for this candidate applying to the role below.

## Candidate Resume
${resumeText}

## Target Role
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Why candidate fits: ${job.whyItFits}
Role description: ${job.description}

## Instructions
- 3 paragraphs max, ~250 words total
- Opening: hook with a specific insight about ${job.company} or the role — not generic
- Middle: 2-3 concrete achievements from resume most relevant to this role, with metrics where available
- Closing: clear call to action, no cringe ("I look forward to...")
- Tone: confident, direct, human — not corporate fluff
- Do NOT fabricate achievements or metrics not in the resume
- Format in Markdown with the date and header

Start with:
${today}

${candidateName}
[email] | [phone] | [LinkedIn]

Hiring Team, ${job.company}

Re: ${job.title}
`;

  return ask(apiKey, prompt, "You are an expert cover letter writer. Be direct, specific, human.", 4096, model);
}
