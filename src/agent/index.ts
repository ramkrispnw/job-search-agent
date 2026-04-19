// src/agent/index.ts — full agent runner

import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import * as fs from "fs-extra";
import { format } from "date-fns";
import { confirm, select } from "@inquirer/prompts";

import { loadConfig, configExists } from "../utils/config.js";
import { searchJobsForProfile, JobResult } from "../tools/webSearch.js";
import { tailorResume } from "../tools/resumeTailor.js";
import { generateCoverLetter } from "../tools/coverLetter.js";
import { researchSalary, formatSalaryRange, SalaryData } from "../tools/salaryResearch.js";
import { generateJobsReport } from "../tools/reportGenerator.js";
import { writeDailyOutput, OutputFile } from "../tools/outputWriter.js";
import { applyToJob } from "../ats/index.js";
import { upsertApplication, logRun, getStats } from "../tracker/index.js";
import { CONFIG_DIR } from "../config/types.js";

function header(text: string) {
  console.log("\n" + chalk.bold.cyan("━".repeat(60)));
  console.log(chalk.bold.white(` ${text}`));
  console.log(chalk.bold.cyan("━".repeat(60)) + "\n");
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
}

async function main() {
  console.log(chalk.bold.cyan(`
  ╔══════════════════════════════════════════╗
  ║        job-search-agent  v2.0            ║
  ║  search · score · tailor · apply         ║
  ╚══════════════════════════════════════════╝
  `));

  if (!(await configExists())) {
    console.error(chalk.red("  No config found. Run setup first:\n  npm run setup"));
    process.exit(1);
  }

  const config = (await loadConfig())!;
  const { resume, targetRoles, targetCompanyTypes, anthropicApiKey, model, output } = config;

  // Show lifetime stats if available
  try {
    const stats = getStats();
    if (stats.total > 0) {
      console.log(chalk.dim(
        `  Lifetime: ${stats.total} tracked · ${stats.applied} applied · ` +
        `${stats.interviewing} interviewing · ${stats.offers} offers · ` +
        `${stats.responseRate} response rate\n`
      ));
    }
  } catch { /* first run */ }

  const dateStr = format(new Date(), "yyyy-MM-dd");

  // ── Step 1: Resume ────────────────────────────────────────────────────────
  header("Step 1 — Loading Resume");
  const candidateName = resume.parsedText.split("\n")[0].trim() || "Candidate";
  console.log(chalk.green(`  ✓ ${candidateName} · ${resume.parsedText.split(" ").length} words`));
  console.log(chalk.dim(`  Model: ${model}`));

  // ── Step 2: Search ────────────────────────────────────────────────────────
  header("Step 2 — Searching for Matching Roles");
  const searchSpinner = ora("Searching the web for best-fit openings...").start();
  let jobs: JobResult[];
  try {
    jobs = await searchJobsForProfile(anthropicApiKey, resume.parsedText, targetRoles, targetCompanyTypes, model);
    searchSpinner.succeed(`Found ${jobs.length} matching roles`);
  } catch (err: any) {
    searchSpinner.fail(`Search failed: ${err.message}`);
    process.exit(1);
  }

  const sortedJobs = jobs.sort((a, b) => b.alignmentScore - a.alignmentScore);

  // ── Step 3: Shortlist ─────────────────────────────────────────────────────
  header("Step 3 — Top 5 Shortlisted Roles");
  sortedJobs.forEach((job, i) => {
    const bar = "█".repeat(job.alignmentScore) + "░".repeat(10 - job.alignmentScore);
    console.log(chalk.bold(`  ${i + 1}. ${job.title}`));
    console.log(chalk.dim(`     ${job.company}  ·  ${job.location}`));
    console.log(chalk.yellow(`     Fit: ${bar} ${job.alignmentScore}/10`));
    console.log(chalk.dim(`     ${job.url}\n`));
  });

  // ── Step 4: Salary Research ───────────────────────────────────────────────
  header("Step 4 — Researching Salary Ranges");
  const salaryData: SalaryData[] = [];
  for (const job of sortedJobs) {
    const sp = ora(`  ${job.company}...`).start();
    try {
      const s = await researchSalary(anthropicApiKey, job, model);
      salaryData.push(s);
      sp.succeed(`  ${job.company}: ${formatSalaryRange(s)}`);
    } catch {
      salaryData.push({ role: job.title, company: job.company, baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0, currency: "USD", sources: [], notes: "Unavailable" });
      sp.warn(`  ${job.company}: data unavailable`);
    }
  }

  // ── Step 5: Jobs Report ───────────────────────────────────────────────────
  header("Step 5 — Generating Jobs Report");
  const reportSpinner = ora("Building report...").start();
  const report = generateJobsReport(sortedJobs, candidateName, targetRoles, targetCompanyTypes, salaryData);
  reportSpinner.succeed("Jobs report ready");

  // ── Step 6: Resumes + Cover Letters ───────────────────────────────────────
  header("Step 6 — Tailoring Resumes & Cover Letters");

  const outputFiles: OutputFile[] = [{ name: "jobs-report.md", content: report, type: "report" }];
  const localItems: { job: JobResult; jobId: string; resumePath: string; coverText: string }[] = [];

  for (let i = 0; i < sortedJobs.length; i++) {
    const job = sortedJobs[i];
    const jobId = `${dateStr}-${slugify(job.company)}-${slugify(job.title)}`;

    const rSpin = ora(`  [${i+1}/5] Resume → ${job.company}`).start();
    let tailored = "";
    try {
      tailored = await tailorResume(anthropicApiKey, resume.parsedText, job, model);
      rSpin.succeed(`  Resume done → ${job.company}`);
    } catch (err: any) { rSpin.fail(`  Failed → ${job.company}: ${err.message}`); continue; }

    const clSpin = ora(`  [${i+1}/5] Cover letter → ${job.company}`).start();
    let coverText = "";
    try {
      coverText = await generateCoverLetter(anthropicApiKey, resume.parsedText, job, candidateName, model);
      clSpin.succeed(`  Cover letter done → ${job.company}`);
    } catch { clSpin.warn(`  Cover letter skipped → ${job.company}`); }

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
  header("Step 7 — Saving Output");
  const saveSpin = ora(`Writing ${outputFiles.length} files...`).start();
  let outputPath = "";
  try {
    outputPath = await writeDailyOutput(config, outputFiles);
    saveSpin.succeed(`Saved → ${outputPath}`);
  } catch (err: any) { saveSpin.fail(err.message); process.exit(1); }

  // ── Step 8: Apply ─────────────────────────────────────────────────────────
  const isInteractive = process.stdout.isTTY;

  if (isInteractive) {
    header("Step 8 — Apply");

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
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
