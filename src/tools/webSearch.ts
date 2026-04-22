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
  roleCount = 5,
  targetLocations: string[] = []
): Promise<JobResult[]> {
  const client = new Anthropic({ apiKey });

  // Truncate resume for the search step — we only need enough context to find matching roles.
  // The full resume is used later in the reasoning layer. Keeping this short reduces input
  // tokens and avoids TPM rate limits during the search call.
  const resumeWords = resumeText.split(/\s+/);
  const resumeForSearch = resumeWords.length > 400
    ? resumeWords.slice(0, 400).join(" ") + "\n\n[... resume continues — full version used in tailoring step]"
    : resumeText;

  const exclusionNote = excludeRoles.length > 0
    ? `\n## Already Recommended — Do NOT suggest these roles again\n${excludeRoles.map(r => `- ${r.title} at ${r.company}`).join("\n")}\n`
    : "";

  const locationNote = targetLocations.length > 0
    ? `\n## Location Requirements (IMPORTANT)\nOnly return roles that are in one of these locations:\n${targetLocations.map(l => `- ${l}`).join("\n")}\nIf "Remote" is listed, also include roles explicitly labeled as remote-first or fully-remote.\nDo NOT return roles in other locations.\n`
    : "";

  const searchPrompt = `
You are a job search specialist. Based on this candidate's resume and preferences,
search the web for the ${roleCount} most relevant current job openings.

## Candidate Resume
${resumeForSearch}

## Target Roles
${targetRoles.join(", ")}

## Target Company Types
${targetCompanyTypes.join(", ")}
${locationNote}${exclusionNote}
## Your Task
1. Search for current open positions matching the candidate's profile
2. Find roles at companies matching their target company types
3. Look for positions posted in the last 30 days where possible
4. Select the best-fit roles — never suggest a role from the exclusion list above (same company + same title)
5. Only return roles that match the Location Requirements above

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

  // Retry loop with exponential backoff for rate limit errors
  let attempt = 0;
  const maxRetries = 4;
  const backoff = [30000, 60000, 60000, 60000];

  while (true) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        tools: [{ type: "web_search_20250305", name: "web_search" } as any],
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

    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
      if (isRateLimit && attempt < maxRetries) {
        const delay = err?.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"]) * 1000
          : backoff[attempt];
        console.log(`\n  Rate limited — waiting ${Math.round(delay / 1000)}s before retry (${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
