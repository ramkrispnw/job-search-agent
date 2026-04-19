// src/agent/index.ts — full agent runner

import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import * as fs from "fs-extra";
import { format } from "date-fns";
import { confirm, select } from "@inquirer/prompts";

import { loadConfig, configExists } from "../utils/config";
import { searchJobsForProfile, JobResult } from "../tools/webSearch";
import { tailorResume } from "../tools/resumeTailor";
import { generateCoverLetter } from "../tools/coverLetter";
import { researchSalary, formatSalaryRange, SalaryData } from "../tools/salaryResearch";
import { researchApplicationRequirements, AppRequirements } from "../tools/applicationResearch";
import { generateQuestionAnswers } from "../tools/questionAnswers";
import { generateJobsReport } from "../tools/reportGenerator";
import { writeDailyOutput, OutputFile } from "../tools/outputWriter";
import { sendJobReport } from "../tools/emailSender";
import { applyToJob } from "../ats/index";
import { upsertApplication, logRun, getStats, getAll } from "../tracker/index";
import { CONFIG_DIR } from "../config/types";
import { agentHeader, dashboardBox } from "../utils/ui";

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
}

async function main() {
  if (!(await configExists())) {
    console.error(chalk.red("  No config found. Run setup first:\n  npm run setup"));
    process.exit(1);
  }

  const config = (await loadConfig())!;
  const { resume, targetRoles, targetCompanyTypes, targetLocations = [], anthropicApiKey, model, output } = config;
  const preferences = config.preferences ?? { dailyRoleCount: 5, emailReport: false };
  const roleCount = preferences.dailyRoleCount ?? 5;
  const minBaseSalary = preferences.minBaseSalary;

  // ── Config dashboard ───────────────────────────────────────────────────────
  const candidateName = resume.parsedText.split("\n")[0].trim() || "Candidate";
  let lifetimeStr = "";
  try {
    const stats = getStats();
    if (stats.total > 0) {
      lifetimeStr = `${stats.total} tracked · ${stats.applied} applied · ${stats.interviewing} interviewing · ${stats.offers} offers · ${stats.responseRate} response rate`;
    }
  } catch { /* first run */ }

  dashboardBox("job-search-agent  v2.0", [
    { label: "Candidate",  value: candidateName },
    { label: "Model",      value: model },
    { label: "Roles/day",  value: String(roleCount) + (minBaseSalary ? `  ·  Min base $${(minBaseSalary/1000).toFixed(0)}k` : "") },
    { label: "Locations",  value: targetLocations.length > 0 ? targetLocations.join(", ") : "Any" },
    { label: "Output",     value: output.mode === "local" ? `Local → ${output.localPath}` : `Google Drive (${output.resumeFormat})` },
    ...(lifetimeStr ? [{ label: "Lifetime", value: lifetimeStr }] : []),
  ]);

  const dateStr = format(new Date(), "yyyy-MM-dd");
  const TOTAL_STEPS = preferences.emailReport ? 9 : 8;

  // ── Step 1: Resume ────────────────────────────────────────────────────────
  agentHeader(1, TOTAL_STEPS, "Loading Resume");
  console.log(chalk.green(`  ✓ ${candidateName} · ${resume.parsedText.split(" ").length} words`));

  // ── Step 2: Search ────────────────────────────────────────────────────────
  agentHeader(2, TOTAL_STEPS, "Searching for Matching Roles");
  const previousRoles = (() => {
    try { return getAll().map(a => ({ company: a.company, title: a.title })); } catch { return []; }
  })();
  if (previousRoles.length > 0) {
    console.log(chalk.dim(`  Excluding ${previousRoles.length} previously seen roles\n`));
  }
  const searchSpinner = ora(`Searching the web for ${roleCount} best-fit openings...`).start();
  let jobs: JobResult[];
  try {
    jobs = await searchJobsForProfile(anthropicApiKey, resume.parsedText, targetRoles, targetCompanyTypes, model, previousRoles, roleCount, targetLocations);
    searchSpinner.succeed(`Found ${jobs.length} matching roles`);
  } catch (err: any) {
    searchSpinner.fail(`Search failed: ${err.message}`);
    process.exit(1);
  }

  // Filter by location if preferences are set
  let filteredJobs = jobs;
  if (targetLocations.length > 0 && !targetLocations.includes("Anywhere")) {
    const lowerLocs = targetLocations.map(l => l.toLowerCase());
    const wantsRemote = lowerLocs.includes("remote");
    filteredJobs = jobs.filter(j => {
      const jLoc = j.location.toLowerCase();
      if (wantsRemote && (jLoc.includes("remote") || jLoc.includes("anywhere"))) return true;
      return lowerLocs.some(l => jLoc.includes(l.split(",")[0].toLowerCase()));
    });
    if (filteredJobs.length < jobs.length) {
      console.log(chalk.dim(`  Filtered to ${filteredJobs.length} role(s) matching location prefs (${targetLocations.join(", ")})\n`));
    }
    if (filteredJobs.length === 0) {
      console.log(chalk.yellow("  No roles matched your location preferences — showing all results.\n"));
      filteredJobs = jobs;
    }
  }

  const sortedJobs = filteredJobs.sort((a, b) => b.alignmentScore - a.alignmentScore);

  // ── Step 3: Shortlist ─────────────────────────────────────────────────────
  agentHeader(3, TOTAL_STEPS, `Top ${roleCount} Shortlisted Roles`);
  sortedJobs.forEach((job, i) => {
    const bar = "█".repeat(job.alignmentScore) + "░".repeat(10 - job.alignmentScore);
    console.log(chalk.bold(`  ${i + 1}. ${job.title}`));
    console.log(chalk.dim(`     ${job.company}  ·  ${job.location}`));
    console.log(chalk.yellow(`     Fit: ${bar} ${job.alignmentScore}/10`));
    console.log(chalk.dim(`     ${job.url}\n`));
  });

  // ── Step 4: Salary Research (parallel) ───────────────────────────────────
  agentHeader(4, TOTAL_STEPS, "Researching Salary Ranges");
  const salarySpinners = sortedJobs.map(job => ora(`  ${job.company}...`).start());
  const salaryResults = await Promise.allSettled(
    sortedJobs.map(job => researchSalary(anthropicApiKey, job, model))
  );
  const salaryData: SalaryData[] = salaryResults.map((result, i) => {
    const job = sortedJobs[i];
    const sp = salarySpinners[i];
    if (result.status === "fulfilled") {
      const s = result.value;
      const flag = minBaseSalary && s.baseHigh > 0 && s.baseHigh < minBaseSalary
        ? chalk.red(` ⚠ below min $${(minBaseSalary/1000).toFixed(0)}k`)
        : "";
      sp.succeed(`  ${job.company}: ${formatSalaryRange(s)}${flag}`);
      return s;
    } else {
      sp.warn(`  ${job.company}: data unavailable`);
      return { role: job.title, company: job.company, baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0, currency: "USD", sources: [], notes: "Unavailable" };
    }
  });

  // ── Step 5: Application Requirements (parallel) ──────────────────────────
  agentHeader(5, TOTAL_STEPS, "Application Requirements");
  const reqSpinners = sortedJobs.map(job => ora(`  ${job.company}: checking requirements...`).start());
  const reqResults = await Promise.allSettled(
    sortedJobs.map(job => researchApplicationRequirements(anthropicApiKey, job, model))
  );
  const clLabel: Record<string, string> = {
    required:    chalk.red("cover letter required"),
    recommended: chalk.yellow("cover letter recommended"),
    optional:    chalk.green("cover letter optional"),
    unknown:     chalk.dim("cover letter: unknown")
  };
  const appRequirements: AppRequirements[] = reqResults.map((result, i) => {
    const job = sortedJobs[i];
    const sp = reqSpinners[i];
    const reqs = result.status === "fulfilled"
      ? result.value
      : { coverLetterStatus: "unknown" as const, additionalQuestions: [], notes: "Error" };
    const qNote = reqs.additionalQuestions.length > 0
      ? chalk.cyan(` · ${reqs.additionalQuestions.length} question(s)`)
      : "";
    sp.succeed(`  ${job.company}: ${clLabel[reqs.coverLetterStatus]}${qNote}`);
    return reqs;
  });

  // ── Step 5: Jobs Report ───────────────────────────────────────────────────
  agentHeader(6, TOTAL_STEPS, "Generating Jobs Report");
  const reportSpinner = ora("Building HTML report...").start();
  const report = generateJobsReport(sortedJobs, candidateName, targetRoles, targetCompanyTypes, salaryData, appRequirements, minBaseSalary);
  reportSpinner.succeed("HTML jobs report ready");

  // ── Step 6: Resumes + Cover Letters + Question Answers ────────────────────
  agentHeader(7, TOTAL_STEPS, "Tailoring Resumes, Cover Letters & Answers");

  const outputFiles: OutputFile[] = [{ name: "jobs-report.html", content: report, type: "report" }];
  const localItems: { job: JobResult; jobId: string; resumePath: string; coverText: string }[] = [];

  for (let i = 0; i < sortedJobs.length; i++) {
    const job = sortedJobs[i];
    const reqs = appRequirements[i];
    const jobId = `${dateStr}-${slugify(job.company)}-${slugify(job.title)}`;
    const label = `[${i+1}/${roleCount}]`;

    const rSpin = ora(`  ${label} Resume → ${job.company}`).start();
    let tailored = "";
    try {
      tailored = await tailorResume(anthropicApiKey, resume.parsedText, job, model, (secs, attempt) => {
        rSpin.text = `  ${label} Resume → ${job.company}  (rate limited — retrying in ${secs}s, attempt ${attempt}/4)`;
      });
      rSpin.succeed(`  Resume done → ${job.company}`);
    } catch (err: any) { rSpin.fail(`  Failed → ${job.company}: ${err.message}`); continue; }

    // Cover letter — always generate if required/recommended; skip only if truly optional+unknown
    const needsCoverLetter = reqs.coverLetterStatus === "required" || reqs.coverLetterStatus === "recommended" || reqs.coverLetterStatus === "unknown";
    let coverText = "";
    if (needsCoverLetter) {
      const clSpin = ora(`  ${label} Cover letter → ${job.company} (${reqs.coverLetterStatus})`).start();
      try {
        coverText = await generateCoverLetter(anthropicApiKey, resume.parsedText, job, candidateName, model, (secs, attempt) => {
          clSpin.text = `  ${label} Cover letter → ${job.company}  (rate limited — retrying in ${secs}s, attempt ${attempt}/4)`;
        });
        clSpin.succeed(`  Cover letter done → ${job.company}`);
      } catch { clSpin.warn(`  Cover letter skipped → ${job.company}`); }
    } else {
      console.log(chalk.dim(`  ${label} Cover letter → ${job.company}: skipped (optional)`));
    }

    // Additional question answers
    if (reqs.additionalQuestions.length > 0) {
      const aSpin = ora(`  ${label} Answering ${reqs.additionalQuestions.length} question(s) → ${job.company}`).start();
      try {
        const answers = await generateQuestionAnswers(anthropicApiKey, resume.parsedText, job, reqs.additionalQuestions, candidateName, model, (secs, attempt) => {
          aSpin.text = `  ${label} Answers → ${job.company}  (rate limited — retrying in ${secs}s, attempt ${attempt}/4)`;
        });
        const answersContent = reqs.additionalQuestions.map(q => `## ${q}\n\n${answers[q] ?? "N/A"}\n`).join("\n---\n\n");
        outputFiles.push({ name: `answers-${i+1}-${slugify(job.company)}.md`, content: answersContent, type: "cover_letter" });
        aSpin.succeed(`  Answers done → ${job.company}`);
      } catch { aSpin.warn(`  Answers skipped → ${job.company}`); }
    }

    outputFiles.push({ name: `resume-${i+1}-${slugify(job.company)}.md`, content: tailored, type: "resume" });
    if (coverText) outputFiles.push({ name: `cover-${i+1}-${slugify(job.company)}.md`, content: coverText, type: "cover_letter" });

    // Save temp local copy for ATS upload
    const tmpPath = path.join(CONFIG_DIR, "tmp", `resume-${slugify(job.company)}.md`);
    await fs.ensureDir(path.dirname(tmpPath));
    await fs.writeFile(tmpPath, tailored, "utf8");

    localItems.push({ job, jobId, resumePath: tmpPath, coverText });
    upsertApplication({ job_id: jobId, title: job.title, company: job.company, location: job.location, url: job.url, status: "queued", alignment: job.alignmentScore });
  }

  // ── Step 7: Save Output ───────────────────────────────────────────────────
  agentHeader(8, TOTAL_STEPS, "Saving Output");
  const saveSpin = ora(`Writing ${outputFiles.length} files...`).start();
  let outputPath = "";
  try {
    outputPath = await writeDailyOutput(config, outputFiles);
    saveSpin.succeed(`Saved → ${outputPath}`);
  } catch (err: any) { saveSpin.fail(err.message); process.exit(1); }

  // ── Step 7b: Email Report ────────────────────────────────────────────────
  if (preferences.emailReport && config.emailConfig) {
    const eSpin = ora(`  Emailing report to ${config.emailConfig.toAddress}...`).start();
    try {
      await sendJobReport({
        ...config.emailConfig,
        subject: `Job Search Report — ${format(new Date(), "MMMM d, yyyy")} (${sortedJobs.length} roles)`,
        htmlContent: report
      });
      eSpin.succeed(`  Report emailed to ${config.emailConfig.toAddress}`);
    } catch (err: any) {
      eSpin.warn(`  Email failed: ${err.message}`);
    }
  }

  // ── Step 8: Apply ─────────────────────────────────────────────────────────
  const isInteractive = process.stdout.isTTY;

  if (isInteractive) {
    agentHeader(TOTAL_STEPS, TOTAL_STEPS, "Apply");

    const applyMode = await select({
      message: "How would you like to handle applications?",
      choices: [
        { name: "Auto-apply to supported ATS (Lever, Greenhouse, Workday)", value: "auto" },
        { name: "Confirm each one individually", value: "manual" },
        { name: "Skip — I'll apply manually", value: "skip" }
      ]
    });

    if (applyMode !== "skip") {
      for (const item of localItems) {
        const { job, jobId, resumePath, coverText } = item;
        let proceed = applyMode === "auto";

        if (applyMode === "manual") {
          proceed = await confirm({
            message: `  Apply to ${job.title} at ${job.company}?`,
            default: job.alignmentScore >= 8
          });
        }

        if (!proceed) { console.log(chalk.dim(`  Skipped: ${job.company}`)); continue; }

        const apSpin = ora(`  Applying → ${job.company}`).start();
        const result = await applyToJob({ config, job, jobId, tailoredResumePath: resumePath, coverLetterText: coverText, headless: true });

        if (result.skipped) apSpin.warn(`  ${job.company}: ${result.skipReason}`);
        else if (result.success) apSpin.succeed(`  ✓ Applied to ${job.company} via ${result.atsType}`);
        else { apSpin.fail(`  ✗ ${job.company}: ${result.error}`); console.log(chalk.dim(`    Manual: ${job.url}`)); }
      }
    }
  } else {
    console.log(chalk.yellow("\n  Cron mode: applications queued. Run interactively to apply.\n"));
  }

  logRun({ run_date: dateStr, jobs_found: sortedJobs.length, applied: 0, queued: localItems.length, output_dir: outputPath });

  console.log(chalk.bold.green(`
  ✅  Done!

  Output: ${outputPath}
${outputFiles.map(f => `    • ${f.name}`).join("\n")}

  Commands:
    npm run status   — view application tracker
    npm run setup    — update resume or preferences
  `));
}

main().catch((err) => {
  if (err?.name === "ExitPromptError" || err?.constructor?.name === "ExitPromptError") {
    console.log(chalk.yellow("\n\n  Interrupted. Progress saved — run again to continue.\n"));
    process.exit(0);
  }
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
