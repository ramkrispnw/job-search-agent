// src/tools/reportGenerator.ts — generate the daily jobs report as HTML

import { format } from "date-fns";
import { JobResult } from "./webSearch";
import { SalaryData, formatSalaryRange } from "./salaryResearch";
import { AppRequirements } from "./applicationResearch";

function scoreBar(score: number): string {
  const filled = Math.round(score);
  return `<span class="bar">${"█".repeat(filled)}${"░".repeat(10 - filled)}</span> ${score}/10`;
}

function coverLetterBadge(status?: AppRequirements["coverLetterStatus"]): string {
  if (!status || status === "unknown") return "";
  const colors: Record<string, string> = {
    required:    "#dc2626",
    recommended: "#d97706",
    optional:    "#16a34a"
  };
  const labels: Record<string, string> = {
    required:    "Cover Letter Required",
    recommended: "Cover Letter Recommended",
    optional:    "Cover Letter Optional"
  };
  return `<span class="badge" style="background:${colors[status]}">${labels[status]}</span>`;
}

function salaryFlag(salary: SalaryData | undefined, minBase?: number): string {
  if (!salary || !minBase || salary.baseLow === 0) return "";
  if (salary.baseHigh < minBase) {
    return `<span class="badge" style="background:#dc2626">Below Min ($${(minBase/1000).toFixed(0)}k)</span>`;
  }
  return "";
}

export function generateJobsReport(
  jobs: JobResult[],
  candidateName: string,
  targetRoles: string[],
  targetCompanyTypes: string[],
  salaryData?: SalaryData[],
  appRequirements?: AppRequirements[],
  minBaseSalary?: number
): string {
  const today = format(new Date(), "MMMM d, yyyy");
  const sorted = [...jobs].sort((a, b) => b.alignmentScore - a.alignmentScore);

  const jobCards = sorted.map((job, i) => {
    const salary = salaryData?.[i];
    const reqs = appRequirements?.[i];

    const questionRows = reqs?.additionalQuestions?.length
      ? `<div class="questions">
          <strong>Application Questions:</strong>
          <ol>${reqs.additionalQuestions.map(q => `<li>${q}</li>`).join("")}</ol>
         </div>`
      : "";

    const salaryRow = salary && salary.baseLow > 0
      ? `<tr><td>Compensation</td><td>${formatSalaryRange(salary)} <span class="muted">(${salary.sources.join(", ") || "estimated"})</span></td></tr>`
      : "";

    const compNote = salary?.notes
      ? `<div class="comp-note">💰 ${salary.notes}</div>`
      : "";

    const reqsNote = reqs?.notes
      ? `<div class="muted small">${reqs.notes}</div>`
      : "";

    return `
<div class="job-card">
  <div class="job-header">
    <div>
      <h2>${i + 1}. ${job.title}</h2>
      <div class="company">${job.company} &mdash; ${job.location}</div>
    </div>
    <div class="badges">
      ${coverLetterBadge(reqs?.coverLetterStatus)}
      ${salaryFlag(salary, minBaseSalary)}
    </div>
  </div>

  <table class="details">
    <tr><td>Alignment</td><td>${scoreBar(job.alignmentScore)}</td></tr>
    ${salaryRow}
    <tr><td>Apply</td><td><a href="${job.url}" target="_blank">View Posting →</a></td></tr>
  </table>

  <div class="section">
    <strong>Role Overview</strong>
    <p>${job.description}</p>
  </div>

  <div class="section">
    <strong>Why You're a Strong Fit</strong>
    <p>${job.whyItFits}</p>
  </div>

  ${compNote}
  ${questionRows}
  ${reqsNote}
</div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Job Search Report — ${today}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #1e293b; font-size: 15px; line-height: 1.6; }
  .container { max-width: 860px; margin: 0 auto; padding: 40px 24px; }
  header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); color: white; padding: 32px 40px; border-radius: 12px; margin-bottom: 32px; }
  header h1 { font-size: 26px; font-weight: 700; margin-bottom: 8px; }
  header .meta { opacity: 0.75; font-size: 14px; }
  .job-card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 28px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .job-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
  h2 { font-size: 20px; font-weight: 700; color: #0f172a; }
  .company { color: #64748b; font-size: 14px; margin-top: 4px; }
  .badges { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; color: white; white-space: nowrap; }
  .details { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 14px; }
  .details td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; }
  .details td:first-child { font-weight: 600; color: #475569; width: 140px; }
  .bar { font-family: monospace; color: #3b82f6; }
  .section { margin-bottom: 16px; }
  .section strong { display: block; color: #334155; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .section p { color: #475569; font-size: 14px; }
  .comp-note { background: #fef9c3; border: 1px solid #fde047; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #713f12; margin-top: 12px; }
  .questions { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 13px; color: #1e40af; }
  .questions ol { margin-top: 6px; padding-left: 18px; }
  .questions li { margin-bottom: 4px; }
  .muted { color: #94a3b8; }
  .small { font-size: 12px; margin-top: 8px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .next-steps { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px 28px; margin-top: 8px; }
  .next-steps h3 { font-size: 16px; margin-bottom: 12px; }
  .next-steps ol { padding-left: 20px; color: #475569; font-size: 14px; }
  .next-steps li { margin-bottom: 6px; }
  footer { text-align: center; margin-top: 40px; font-size: 12px; color: #94a3b8; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Job Search Report</h1>
    <div class="meta">
      <strong>${candidateName}</strong> &nbsp;·&nbsp; ${today}<br>
      Targeting: ${targetRoles.slice(0, 3).join(", ")}${targetRoles.length > 3 ? " &amp; more" : ""}<br>
      Companies: ${targetCompanyTypes.slice(0, 2).join(", ")}${targetCompanyTypes.length > 2 ? " &amp; more" : ""}
      ${minBaseSalary ? `&nbsp;·&nbsp; Min base: $${(minBaseSalary/1000).toFixed(0)}k` : ""}
    </div>
  </header>

  ${jobCards}

  <div class="next-steps">
    <h3>Next Steps</h3>
    <ol>
      <li>Review each role and click the posting link</li>
      <li>Tailored resumes are in this folder: <code>resume-N-company</code></li>
      <li>Cover letters (where applicable) are in: <code>cover-N-company</code></li>
      <li>Application question answers are in: <code>answers-N-company.md</code></li>
      <li>Apply within 48 hours for best response rates</li>
      <li>Track your applications: <code>npm run status</code></li>
    </ol>
  </div>

  <footer>Generated by <a href="https://github.com/ramkrispnw/job-search-agent">job-search-agent</a></footer>
</div>
</body>
</html>`;
}
