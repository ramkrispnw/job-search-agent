// src/tools/applicationResearch.ts — research application requirements for each role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";

export interface AppRequirements {
  coverLetterStatus: "required" | "recommended" | "optional" | "unknown";
  additionalQuestions: string[];
  notes: string;
}

const FALLBACK: AppRequirements = {
  coverLetterStatus: "unknown",
  additionalQuestions: [],
  notes: "Could not retrieve requirements"
};

// Standard fields to ignore — these are always on application forms
const STANDARD_FIELDS = new Set([
  "first name", "last name", "full name", "name",
  "email", "email address", "phone", "phone number", "mobile",
  "resume", "cv", "cover letter", "linkedin", "linkedin url", "linkedin profile",
  "website", "portfolio", "github", "twitter",
  "address", "city", "state", "zip", "country", "location",
  "how did you hear about us", "how did you find this job", "referral",
  "are you authorized to work", "work authorization", "visa", "sponsorship",
  "salary", "salary expectations", "desired salary", "compensation"
]);

function isStandardField(label: string): boolean {
  const lower = label.toLowerCase().trim();
  for (const std of STANDARD_FIELDS) {
    if (lower.includes(std)) return true;
  }
  return false;
}

// ─── Puppeteer form scraper ───────────────────────────────────────────────────

async function scrapeApplicationForm(url: string): Promise<{
  coverLetterStatus: AppRequirements["coverLetterStatus"];
  questions: string[];
  notes: string;
}> {
  let browser: any;
  try {
    const puppeteer = await import("puppeteer");
    browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36");

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    await new Promise(r => setTimeout(r, 800));

    // Try to click an Apply button to reveal the form
    const applySelectors = [
      "a[href*='apply']", "button[data-qa='btn-apply']",
      "a[data-qa='btn-apply']", "button::-p-text(Apply)",
      "a::-p-text(Apply Now)", "button::-p-text(Apply Now)",
      ".apply-button", "#apply-button", "[class*='apply']"
    ];
    for (const sel of applySelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await new Promise(r => setTimeout(r, 1000));
          break;
        }
      } catch { /* selector not found */ }
    }

    // Extract all visible form labels and inputs
    const formData: { coverLetterStatus: string; questions: string[] } = await page.evaluate(() => {
      const questions: string[] = [];
      let coverLetterStatus = "unknown";

      // Collect labels from all form elements
      const labelEls = Array.from(document.querySelectorAll("label"));
      for (const label of labelEls) {
        const text = label.textContent?.trim().replace(/\s+/g, " ").replace(/\*$/, "").trim() ?? "";
        if (!text || text.length < 3 || text.length > 300) continue;

        // Check for cover letter field
        if (/cover letter/i.test(text)) {
          const required = label.querySelector("[required]") ||
            label.closest(".field")?.querySelector("[required]") ||
            text.includes("*");
          coverLetterStatus = required ? "required" : "recommended";
          continue;
        }

        questions.push(text);
      }

      // Also look for textarea labels and fieldset legends (common for custom questions)
      const fieldsets = Array.from(document.querySelectorAll("fieldset legend, [data-qa*='question'] label, .custom-question label"));
      for (const el of fieldsets) {
        const text = el.textContent?.trim().replace(/\s+/g, " ") ?? "";
        if (text && text.length > 5 && text.length < 300 && !questions.includes(text)) {
          questions.push(text);
        }
      }

      return { coverLetterStatus, questions };
    });

    // Filter out standard fields, duplicates, and short non-questions
    const filtered = [...new Set(formData.questions)]
      .filter(q => !isStandardField(q))
      .filter(q => q.length > 10);

    return {
      coverLetterStatus: formData.coverLetterStatus as AppRequirements["coverLetterStatus"],
      questions: filtered,
      notes: `Scraped form at ${new URL(url).hostname}`
    };

  } catch (err: any) {
    return { coverLetterStatus: "unknown", questions: [], notes: `Could not load form: ${err.message?.slice(0, 80)}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Claude fallback for unknown questions ────────────────────────────────────

async function estimateRequirementsFromKnowledge(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<AppRequirements> {
  const client = new Anthropic({ apiKey });
  const prompt = `
Based on your knowledge, what are the typical application requirements for this role?

Role: ${job.title}
Company: ${job.company}
ATS URL: ${job.url}

Answer:
1. Is a cover letter typically required, recommended, or optional for this type of role/company?
2. What additional questions do companies like this commonly ask beyond name/email/resume?
   (e.g. work authorization, "why this company", portfolio links, specific skills)

Return ONLY this JSON:
{
  "coverLetterStatus": "required" | "recommended" | "optional" | "unknown",
  "additionalQuestions": ["question 1", "question 2"],
  "notes": "estimated from company/role knowledge"
}`;

  try {
    const response = await client.messages.create({
      model, max_tokens: 400,
      messages: [{ role: "user", content: prompt }]
    });

    const rawText = response.content.filter(b => b.type === "text").map((b: any) => b.text).join("");
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1) return FALLBACK;
    return JSON.parse(cleaned.slice(start, end + 1)) as AppRequirements;
  } catch {
    return FALLBACK;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function researchApplicationRequirements(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<AppRequirements> {
  // 1. Scrape the actual application form — hard 12s timeout so it never hangs
  const scrapeWithTimeout = Promise.race([
    scrapeApplicationForm(job.url),
    new Promise<{ coverLetterStatus: AppRequirements["coverLetterStatus"]; questions: string[]; notes: string }>(
      resolve => setTimeout(() => resolve({ coverLetterStatus: "unknown", questions: [], notes: "Timed out" }), 12000)
    )
  ]);
  const scraped = await scrapeWithTimeout;

  // If we got useful data from the form, return it
  if (scraped.coverLetterStatus !== "unknown" || scraped.questions.length > 0) {
    return {
      coverLetterStatus: scraped.coverLetterStatus,
      additionalQuestions: scraped.questions,
      notes: scraped.notes
    };
  }

  // 2. Fall back to Claude's knowledge if scraping found nothing
  return estimateRequirementsFromKnowledge(apiKey, job, model);
}
