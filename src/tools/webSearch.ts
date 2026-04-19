// src/tools/webSearch.ts — search for job roles using Claude's web search tool

import Anthropic from "@anthropic-ai/sdk";

export interface JobResult {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  whyItFits: string;
  alignmentScore: number; // 0-10
}

export async function searchJobsForProfile(
  apiKey: string,
  resumeText: string,
  targetRoles: string[],
  targetCompanyTypes: string[],
  model: string,
  excludeRoles: Array<{ company: string; title: string }> = [],
  roleCount = 5
): Promise<JobResult[]> {
  const client = new Anthropic({ apiKey });

  const exclusionNote = excludeRoles.length > 0
    ? `\n## Already Recommended — Do NOT suggest these roles again\n${excludeRoles.map(r => `- ${r.title} at ${r.company}`).join("\n")}\n`
    : "";

  const searchPrompt = `
You are a job search specialist. Based on this candidate's resume and preferences,
search the web for the ${roleCount} most relevant current job openings.

## Candidate Resume
${resumeText}

## Target Roles
${targetRoles.join(", ")}

## Target Company Types
${targetCompanyTypes.join(", ")}
${exclusionNote}
## Your Task
1. Search for current open positions matching the candidate's profile
2. Find roles at companies matching their target company types
3. Look for positions posted in the last 30 days where possible
4. Select the best-fit roles — never suggest a role from the exclusion list above (same company + same title)

## URL Requirements (IMPORTANT)
For the job URL, always prefer the direct ATS application link in this priority order:
1. Greenhouse: boards.greenhouse.io or job-boards.greenhouse.io link
2. Lever: jobs.lever.co link
3. Workday: myworkdayjobs.com link
4. Ashby: jobs.ashbyhq.com link
5. Company career page (only if no ATS link found)
6. Job board URL (last resort only)

Search specifically for the ATS-hosted URL, not a job board aggregator link.

For each role, return a JSON array with this exact structure:
[
  {
    "title": "exact job title",
    "company": "company name",
    "location": "city, state or Remote",
    "url": "direct ATS or career page URL (not a job board)",
    "description": "2-3 sentence summary of the role and what makes it interesting",
    "whyItFits": "2-3 sentences on why this specific candidate is a strong fit, referencing their actual experience",
    "alignmentScore": 8
  }
]

Return ONLY the JSON array, no other text.
`;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search"
      } as any
    ],
    messages: [{ role: "user", content: searchPrompt }]
  });

  // Extract text from final response (after tool use)
  let rawText = "";
  for (const block of response.content) {
    if (block.type === "text") rawText += block.text;
  }

  // Parse JSON — strip any markdown fences
  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const startIdx = cleaned.indexOf("[");
  const endIdx = cleaned.lastIndexOf("]");
  if (startIdx === -1 || endIdx === -1) {
    throw new Error("Could not parse job results from Claude response");
  }

  return JSON.parse(cleaned.slice(startIdx, endIdx + 1)) as JobResult[];
}
