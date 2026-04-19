// src/tools/questionAnswers.ts — generate answers to application questions

import { ask } from "../utils/claude";
import { JobResult } from "./webSearch";

export async function generateQuestionAnswers(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  questions: string[],
  candidateName: string,
  model: string,
  onWait?: (seconds: number, attempt: number) => void
): Promise<Record<string, string>> {
  if (questions.length === 0) return {};

  const cachedPrefix = `## Candidate Resume\n${resumeText}`;

  const prompt = `
The candidate (resume above) is applying for the role below and must answer the following application questions.
Write concise, honest, compelling answers grounded in the candidate's actual experience.

## Target Role
Title: ${job.title}
Company: ${job.company}
Why candidate fits: ${job.whyItFits}

## Questions to Answer
${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

## Instructions
- Ground every answer in the resume — do not fabricate
- Keep answers under 200 words each
- Be specific and direct — no fluff
- Tone: confident and professional

Return ONLY a JSON object where keys are the questions and values are the answers:
{
  "question text": "answer text",
  ...
}
`;

  const raw = await ask(
    apiKey,
    prompt,
    `You are a career coach helping ${candidateName} write application answers.`,
    1500,
    model,
    4,
    cachedPrefix,
    onWait
  );

  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1) return {};

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return {};
  }
}
