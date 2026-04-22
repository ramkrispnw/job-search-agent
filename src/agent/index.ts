// src/agent/index.ts — full agent runner

import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import * as fs from "fs-extra";
import { format } from "date-fns";
import { confirm, select, checkbox } from "@inquirer/prompts";

import { loadConfig, configExists } from "../utils/config";
import { searchJobsForProfile, JobResult } from "../tools/webSearch";
import { tailorResume } from "../tools/resumeTailor";
import { generateCoverLetter } from "../tools/coverLetter";
import { researchSalary, formatSalaryRange, SalaryData } from "../tools/salaryResearch";
import { researchApplicationRequirements, estimateRequirementsQuick, AppRequirements } from "../tools/applicationResearch";
import { researchCompany, CompanyBrief } from "../tools/companyResearch";
import { buildPositioningStrategy, PositioningStrategy } from "../tools/positioningStrategy";
import { generateQuestionAnswers } from "../tools/questionAnswers";
import { generateJobsReport } from "../tools/reportGenerator";
import { writeDailyOutput, OutputFile } from "../tools/outputWriter";
import { sendJobReport } from "../tools/emailSender";
import { applyToJob } from "../ats/index";
import { upsertApplication, logRun, getStats, getAll } from "../tracker/index";
import { CONFIG_DIR } from "../config/types";
import { agentHeader, dashboardBox } from "../utils/ui";
import { markRoleStart, roleDelta, formatUsage, printTotalSummary } from "../utils/tokenUsage";
import pLimit from "p-limit";

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
  const isInteractive = process.stdout.isTTY;
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

  // Filter by location
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
      console.log(chalk.dim(`  Filtered to ${filteredJobs.length} role(s) matching location prefs\n`));
    }
    if (filteredJobs.length === 0) {
      console.log(chalk.yellow("  No roles matched your location preferences — showing all results.\n"));
      filteredJobs = jobs;
    }
  }

  const sortedJobs = filteredJobs.sort((a, b) => b.alignmentScore - a.alignmentScore);

  // ── Step 3: Shortlist + Salary + Requirements (parallel) ──────────────────
  agentHeader(3, TOTAL_STEPS, `Shortlisted Roles — Salary & Requirements`);

  const clLabel: Record<string, string> = {
    required:    chalk.red("CL required"),
    recommended: chalk.yellow("CL recommended"),
    optional:    chalk.green("CL optional"),
    unknown:     chalk.dim("CL unknown")
  };

  // Stage 3: salary + quick Claude requirements estimate (no Puppeteer — fast)
  // Full Puppeteer form scrape runs later in the reasoning layer for selected roles only
  const salaryData: SalaryData[] = new Array(sortedJobs.length);
  const appRequirements: AppRequirements[] = new Array(sortedJobs.length);

  await Promise.all(sortedJobs.map(async (job, i) => {
    const sp = ora(`  ${job.company}: salary & requirements...`).start();
    const [salaryResult, reqResult] = await Promise.allSettled([
      researchSalary(anthropicApiKey, job, model),
      estimateRequirementsQuick(anthropicApiKey, job, model)
    ]);

    const sal = salaryResult.status === "fulfilled"
      ? salaryResult.value
      : { role: job.title, company: job.company, baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0, currency: "USD", sources: [], notes: "Unavailable" };
    salaryData[i] = sal;

    const reqs = reqResult.status === "fulfilled"
      ? reqResult.value
      : { coverLetterStatus: "unknown" as const, additionalQuestions: [], notes: "Error" };
    appRequirements[i] = reqs;

    const salStr = sal.baseHigh > 0 ? formatSalaryRange(sal) : "salary N/A";
    const flag = minBaseSalary && sal.baseHigh > 0 && sal.baseHigh < minBaseSalary
      ? chalk.red(` ⚠ below min $${(minBaseSalary/1000).toFixed(0)}k`) : "";
    const clNote = ` · ${clLabel[reqs.coverLetterStatus]}`;
    const qNote = reqs.additionalQuestions.length > 0 ? chalk.cyan(` · ${reqs.additionalQuestions.length}Q`) : "";

    sp.succeed(`  ${job.company}: ${salStr}${flag}${clNote}${qNote}`);
  }));

  // ── Checkpoint 1: Role selection ──────────────────────────────────────────
  agentHeader(4, TOTAL_STEPS, "Select Roles to Pursue");

  console.log(chalk.dim("  The reasoning layer (research + strategy) only runs for roles you select.\n"));
  sortedJobs.forEach((job, i) => {
    const bar = "█".repeat(job.alignmentScore) + "░".repeat(10 - job.alignmentScore);
    const sal = salaryData[i];
    const salStr = sal.baseHigh > 0 ? ` · $${(sal.baseLow/1000).toFixed(0)}–${(sal.baseHigh/1000).toFixed(0)}k` : "";
    const qStr = appRequirements[i].additionalQuestions.length > 0
      ? ` · ${appRequirements[i].additionalQuestions.length} extra Q` : "";
    console.log(chalk.bold(`  ${i + 1}. ${job.title} — ${job.company}`));
    console.log(chalk.dim(`     ${job.location}${salStr}  Fit: ${bar} ${job.alignmentScore}/10${qStr}\n`));
  });

  let selectedJobs = sortedJobs;
  if (isInteractive) {
    const chosen = await checkbox({
      message: "Which roles should I prepare applications for?",
      choices: sortedJobs.map((job, i) => ({
        name: `${job.title} — ${job.company}  (${job.location}, fit ${job.alignmentScore}/10)`,
        value: i,
        checked: true
      }))
    });
    if (chosen.length === 0) {
      console.log(chalk.yellow("\n  No roles selected. Run again to start a new search.\n"));
      process.exit(0);
    }
    selectedJobs = chosen.map((i: number) => sortedJobs[i]);
    const selectedRequirements = chosen.map((i: number) => appRequirements[i]);
    const selectedSalary = chosen.map((i: number) => salaryData[i]);

    // Rebuild aligned arrays for selected roles only
    sortedJobs.splice(0, sortedJobs.length, ...selectedJobs);
    appRequirements.splice(0, appRequirements.length, ...selectedRequirements);
    salaryData.splice(0, salaryData.length, ...selectedSalary);
  }

  // ── Step 5: Jobs Report ───────────────────────────────────────────────────
  agentHeader(5, TOTAL_STEPS, "Generating Jobs Report");
  const reportSpinner = ora("Building HTML report...").start();
  const report = generateJobsReport(sortedJobs, candidateName, targetRoles, targetCompanyTypes, salaryData, appRequirements, minBaseSalary);
  reportSpinner.succeed("HTML jobs report ready");

  // ── Step 6: Reasoning Layer + Writing (per selected role, up to 2 concurrent) ──
  agentHeader(6, TOTAL_STEPS, "Research · Strategy · Tailor");

  const outputFiles: OutputFile[] = [{ name: "jobs-report.html", content: report, type: "report" }];
  const localItems: { job: JobResult; jobId: string; resumePath: string; coverText: string }[] = [];

  // Cap at 2 concurrent roles — Anthropic rate limits make >2 counterproductive
  const limit = pLimit(2);

  // Collect results in order (index-stable)
  const roleResults = await Promise.all(sortedJobs.map((job, i) => limit(async () => {
    const reqs = appRequirements[i];
    const jobId = `${dateStr}-${slugify(job.company)}-${slugify(job.title)}`;
    const label = `[${i+1}/${sortedJobs.length}]`;

    console.log(chalk.bold.cyan(`\n  ${label} ${job.company} — ${job.title}`));
    markRoleStart(); // snapshot before this role's API calls

    // ── A + B: Form scrape AND company research in parallel (no dependency) ──
    const fReqSpin = ora(`  ${label} Checking application form...`).start();
    const resSpin  = ora(`  ${label} Researching ${job.company}...`).start();

    const [scrapeResult, researchResult] = await Promise.allSettled([
      researchApplicationRequirements(anthropicApiKey, job, model),
      researchCompany(anthropicApiKey, job, model)
    ]);

    // Handle form scrape result
    let mergedReqs = reqs;
    if (scrapeResult.status === "fulfilled") {
      mergedReqs = scrapeResult.value;
      appRequirements[i] = mergedReqs;
      const qNote = mergedReqs.additionalQuestions.length > 0
        ? chalk.cyan(` · ${mergedReqs.additionalQuestions.length} question(s) found`)
        : " · no extra questions";
      fReqSpin.succeed(`  ${label} Form: ${clLabel[mergedReqs.coverLetterStatus]}${qNote}`);
    } else {
      fReqSpin.warn(`  ${label} Form check failed — using estimate`);
    }

    // Handle company research result
    let companyBrief: CompanyBrief | undefined;
    if (researchResult.status === "fulfilled") {
      companyBrief = researchResult.value;
      resSpin.succeed(`  ${label} ${job.company}: research complete`);
      if (companyBrief.talkingPoints.length > 0) {
        companyBrief.talkingPoints.forEach(tp => console.log(chalk.dim(`    → ${tp}`)));
      }
    } else {
      resSpin.warn(`  ${label} ${job.company}: research unavailable`);
    }

    // ── C: Positioning strategy (needs A + B results) ────────────────────────
    const strSpin = ora(`  ${label} Building positioning strategy...`).start();
    let strategy: PositioningStrategy | undefined;
    try {
      strategy = await buildPositioningStrategy(
        anthropicApiKey, resume.parsedText, job,
        companyBrief ?? { recentNews: "", productDirection: job.description, cultureSignals: "", whyHiringNow: job.whyItFits, talkingPoints: [] },
        mergedReqs, model
      );
      strSpin.succeed(`  ${label} Strategy: ${strategy.narrativeAngle.slice(0, 80)}${strategy.narrativeAngle.length > 80 ? "..." : ""}`);
    } catch { strSpin.warn(`  ${label} Strategy unavailable — using standard tailoring`); }

    // ── D: Resume ────────────────────────────────────────────────────────────
    const rSpin = ora(`  ${label} Tailoring resume...`).start();
    let tailored = "";
    try {
      tailored = await tailorResume(anthropicApiKey, resume.parsedText, job, model,
        (secs, attempt) => { rSpin.text = `  ${label} Resume (rate limited — retrying in ${secs}s, attempt ${attempt}/4)`; },
        strategy
      );
      rSpin.succeed(`  ${label} Resume done`);
    } catch (err: any) {
      rSpin.fail(`  ${label} Resume failed: ${err.message}`);
      return null; // skip this role
    }

    // ── E: Cover letter ──────────────────────────────────────────────────────
    const needsCoverLetter = mergedReqs.coverLetterStatus !== "optional";
    let coverText = "";
    if (needsCoverLetter) {
      const clSpin = ora(`  ${label} Cover letter (${mergedReqs.coverLetterStatus})...`).start();
      try {
        coverText = await generateCoverLetter(anthropicApiKey, resume.parsedText, job, candidateName, model,
          (secs, attempt) => { clSpin.text = `  ${label} Cover letter (rate limited — retrying in ${secs}s, attempt ${attempt}/4)`; },
          companyBrief, strategy
        );
        clSpin.succeed(`  ${label} Cover letter done`);
      } catch { clSpin.warn(`  ${label} Cover letter skipped`); }
    } else {
      console.log(chalk.dim(`  ${label} Cover letter: skipped (optional)`));
    }

    // ── F: Additional question answers ───────────────────────────────────────
    let answersEntry: OutputFile | null = null;
    if (mergedReqs.additionalQuestions.length > 0) {
      const aSpin = ora(`  ${label} Answering ${mergedReqs.additionalQuestions.length} question(s)...`).start();
      try {
        const coverSummary = coverText ? `Cover letter used: ${coverText.slice(0, 300)}...` : undefined;
        const answers = await generateQuestionAnswers(
          anthropicApiKey, resume.parsedText, job, mergedReqs.additionalQuestions,
          candidateName, model,
          (secs, attempt) => { aSpin.text = `  ${label} Answers (rate limited — retrying in ${secs}s, attempt ${attempt}/4)`; },
          companyBrief, strategy, coverSummary
        );
        const answersContent = mergedReqs.additionalQuestions.map(q => `## ${q}\n\n${answers[q] ?? "N/A"}\n`).join("\n---\n\n");
        answersEntry = { name: `answers-${i+1}-${slugify(job.company)}.md`, content: answersContent, type: "cover_letter" };
        aSpin.succeed(`  ${label} Answers done`);
      } catch { aSpin.warn(`  ${label} Answers skipped`); }
    }

    // ── Token usage for this role ─────────────────────────────────────────────
    console.log(chalk.dim(`  ${label} `) + formatUsage(roleDelta(), "tokens:"));

    return { i, job, jobId, tailored, coverText, strategy, answersEntry };
  })));

  // Reassemble output in original order (parallel results arrive out of order)
  for (const result of roleResults) {
    if (!result) continue;
    const { i, job, jobId, tailored, coverText, strategy, answersEntry } = result;

    if (answersEntry) outputFiles.push(answersEntry);
    outputFiles.push({ name: `resume-${i+1}-${slugify(job.company)}.md`, content: tailored, type: "resume" });
    if (coverText) outputFiles.push({ name: `cover-${i+1}-${slugify(job.company)}.md`, content: coverText, type: "cover_letter" });

    if (strategy) {
      const strategyContent = [
        `# Positioning Strategy — ${job.title} at ${job.company}`,
        ``,
        `**Narrative angle:** ${strategy.narrativeAngle}`,
        ``,
        `**Top matches:**`,
        strategy.topMatches.map(m => `- ${m}`).join("\n"),
        ``,
        `**Keywords:** ${strategy.keywordsToHit.join(", ")}`,
        ``,
        `**Gaps to minimize:**`,
        strategy.gapsToMinimize.map(g => `- ${g}`).join("\n"),
        ``,
        `**Story allocation:**`,
        strategy.storyAllocation.map(s => `- **${s.slot}**: ${s.story} — ${s.angle}`).join("\n"),
      ].join("\n");
      outputFiles.push({ name: `strategy-${i+1}-${slugify(job.company)}.md`, content: strategyContent, type: "cover_letter" });
    }

    const tmpPath = path.join(CONFIG_DIR, "tmp", `resume-${slugify(job.company)}.md`);
    await fs.ensureDir(path.dirname(tmpPath));
    await fs.writeFile(tmpPath, tailored, "utf8");

    localItems.push({ job, jobId, resumePath: tmpPath, coverText });
    upsertApplication({ job_id: jobId, title: job.title, company: job.company, location: job.location, url: job.url, status: "queued", alignment: job.alignmentScore });
  }

  // ── Step 7: Save Output ───────────────────────────────────────────────────
  agentHeader(7, TOTAL_STEPS, "Saving Output");
  const saveSpin = ora(`Writing ${outputFiles.length} files...`).start();
  let outputPath = "";
  try {
    outputPath = await writeDailyOutput(config, outputFiles);
    saveSpin.succeed(`Saved → ${outputPath}`);
  } catch (err: any) { saveSpin.fail(err.message); process.exit(1); }

  // ── Step 7b: Email Report ─────────────────────────────────────────────────
  if (preferences.emailReport && config.emailConfig) {
    const eSpin = ora(`  Emailing report to ${config.emailConfig.toAddress}...`).start();
    try {
      await sendJobReport({
        ...config.emailConfig,
        subject: `Job Search Report — ${format(new Date(), "MMMM d, yyyy")} (${sortedJobs.length} roles)`,
        htmlContent: report
      });
      eSpin.succeed(`  Report emailed to ${config.emailConfig.toAddress}`);
    } catch (err: any) { eSpin.warn(`  Email failed: ${err.message}`); }
  }

  // ── Step 8: Apply ─────────────────────────────────────────────────────────
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
        else if ((result as any).needsEmailVerification) {
          apSpin.warn(`  ${job.company}: Greenhouse sent a security code to your email`);
          console.log(chalk.yellow(`    ↳ Check your inbox, enter the code, and resubmit at:`));
          console.log(chalk.cyan(`      ${job.url}`));
        } else {
          apSpin.fail(`  ✗ ${job.company}: ${result.error}`);
          console.log(chalk.dim(`    Manual: ${job.url}`));
        }
      }
    }
  } else {
    console.log(chalk.yellow("\n  Cron mode: applications queued. Run interactively to apply.\n"));
  }

  logRun({ run_date: dateStr, jobs_found: sortedJobs.length, applied: 0, queued: localItems.length, output_dir: outputPath });

  printTotalSummary();

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
