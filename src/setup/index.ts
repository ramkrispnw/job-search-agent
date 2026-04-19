// src/setup/index.ts — interactive setup wizard

import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import * as fs from "fs-extra";
import { input, confirm, select, checkbox, editor } from "@inquirer/prompts";
import { UserConfig, CONFIG_PATH, CONFIG_DIR } from "../config/types";
import { parseResume, extractGoogleDocId, fetchGoogleDoc } from "../utils/resumeParser";
import { ask } from "../utils/claude";
import { saveConfig, loadConfig } from "../utils/config";
import { getAuthClient, verifyFolderAccess } from "../tools/googleDrive";
import { setupStepHeader, reviewBox, successBox, infoBox } from "../utils/ui";
import { installCronJob, hasExistingCronJob, removeCronJob, describeSchedule, WEEKDAYS, CronSchedule, LOG_FILE } from "../utils/cronManager";

const TOTAL_STEPS = 8;

function success(text: string) {
  console.log(chalk.green("  ✓ ") + text);
}

function info(text: string) {
  console.log(chalk.dim("  ℹ ") + text);
}

// ─── Step 0: API Key ─────────────────────────────────────────────────────────

async function setupApiKey(existing?: string): Promise<string> {
  setupStepHeader(1, TOTAL_STEPS, "Anthropic API Key");
  info("Your API key is stored locally in ~/.job-search-agent/config.json");
  info("Get one at: https://console.anthropic.com/settings/keys\n");

  while (true) {
    const apiKey = await input({
      message: "Enter your Anthropic API key:",
      default: existing,
      validate: (val) => val.startsWith("sk-") ? true : "Key must start with sk-"
    });

    const spinner = ora("Verifying API key... (up to 10s)").start();
    try {
      // Race the API call against a 10s timeout — retries=0 so it fails fast
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), 10000)
      );
      await Promise.race([
        ask(apiKey, "Say OK", undefined, 10, undefined, 0),
        timeout
      ]);
      spinner.succeed("API key verified ✓");
      return apiKey;
    } catch (err: any) {
      const msg = err?.status === 401 ? "Invalid API key — check it and try again"
        : err?.status === 429       ? "Rate limited — wait a moment and try again"
        : err?.message?.includes("timed out") ? "Request timed out — check your internet connection"
        : `Could not verify: ${err?.message ?? "unknown error"}`;
      spinner.fail(msg);
    }
  }
}

// ─── Step 0b: Model Selection ────────────────────────────────────────────────

const MODELS = [
  {
    value: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6  — Recommended · best balance of quality and cost"
  },
  {
    value: "claude-opus-4-7",
    name: "Claude Opus 4.7    — Most capable · highest quality · higher cost"
  },
  {
    value: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5   — Fastest · lowest cost · good for high-volume use"
  }
];

async function setupModel(existing?: string): Promise<string> {
  setupStepHeader(2, TOTAL_STEPS, "Claude Model");
  info("Choose which Claude model powers the agent. This affects quality and API cost.\n");

  return select({
    message: "Claude model:",
    choices: MODELS,
    default: existing ?? "claude-sonnet-4-6"
  });
}

// ─── Step 1: Resume Upload ───────────────────────────────────────────────────

async function setupResume(apiKey: string, existing?: UserConfig["resume"]): Promise<UserConfig["resume"]> {
  setupStepHeader(3, TOTAL_STEPS, "Resume");

  if (existing) {
    const reuse = await confirm({
      message: `Resume already on file (updated ${existing.lastUpdated}). Use existing?`,
      default: true
    });
    if (reuse) return existing;
  }

  const resumeSource = await select({
    message: "Where is your resume?",
    choices: [
      { name: "Local file (PDF, DOCX, TXT, or MD)", value: "file" },
      { name: "Google Doc (share link or doc ID)", value: "google_doc" }
    ]
  });

  let parsedText: string;
  let originalPath: string;

  if (resumeSource === "google_doc") {
    info("Make sure the doc is shared with \"Anyone with the link can view\"\n");

    while (true) {
      const docInput = await input({
        message: "Google Doc URL or document ID:",
        validate: (val) => extractGoogleDocId(val) ? true : "Could not find a Google Doc ID in that input"
      });

      const docId = extractGoogleDocId(docInput)!;
      const spinner = ora("Fetching your Google Doc...").start();
      try {
        parsedText = await fetchGoogleDoc(docId);
        spinner.succeed(`Fetched ${parsedText.split(" ").length} words from Google Doc`);
        break;
      } catch (err: any) {
        spinner.fail(err.message + " — please try again");
      }
    }

    // Save a plain-text copy locally for offline use
    await fs.ensureDir(CONFIG_DIR);
    originalPath = path.join(CONFIG_DIR, "resume.txt");
    await fs.writeFile(originalPath, parsedText, "utf8");
    success(`Local copy saved to ${originalPath}`);
  } else {
    let filePath = await input({
      message: "Path to your resume file:",
      validate: async (val) => {
        const expanded = val.replace("~", process.env.HOME!);
        if (!(await fs.pathExists(expanded))) return "File not found";
        const ext = path.extname(expanded).toLowerCase();
        if (![".pdf", ".docx", ".txt", ".md"].includes(ext)) {
          return "Unsupported format. Please use PDF, DOCX, TXT, or MD";
        }
        return true;
      }
    });

    while (true) {
      const expanded = filePath.replace("~", process.env.HOME!);
      const spinner = ora("Reading and parsing your resume...").start();
      try {
        parsedText = await parseResume(expanded);
        spinner.succeed(`Parsed ${parsedText.split(" ").length} words from your resume`);
        await fs.ensureDir(CONFIG_DIR);
        originalPath = path.join(CONFIG_DIR, "resume" + path.extname(expanded));
        await fs.copyFile(expanded, originalPath);
        success(`Resume saved to ${originalPath}`);
        break;
      } catch (err: any) {
        spinner.fail(err.message + " — please try again");
        const retry = await input({
          message: "Path to your resume file:",
          validate: async (val) => {
            const exp = val.replace("~", process.env.HOME!);
            if (!(await fs.pathExists(exp))) return "File not found";
            const ext = path.extname(exp).toLowerCase();
            if (![".pdf", ".docx", ".txt", ".md"].includes(ext)) return "Unsupported format";
            return true;
          }
        });
        filePath = retry;
      }
    }
  }

  return {
    originalPath,
    parsedText,
    lastUpdated: new Date().toISOString()
  };
}

// ─── Step 2: Target Roles ────────────────────────────────────────────────────

async function setupTargetRoles(
  apiKey: string,
  resumeText: string,
  existing?: string[]
): Promise<string[]> {
  setupStepHeader(4, TOTAL_STEPS, "Target Roles");

  let roles: string[] = existing ?? [];

  if (roles.length === 0) {
    const spinner = ora("Analyzing your resume to suggest target roles...").start();
    const raw = await ask(
      apiKey,
      `Based on this resume, suggest 8 specific job titles this person should target. 
Return ONLY a JSON array of strings. No explanation.

Resume:
${resumeText}`,
      "You are a career coach expert."
    );
    spinner.stop();

    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      roles = JSON.parse(cleaned);
      console.log(chalk.bold("\n  Suggested roles based on your resume:\n"));
      roles.forEach((r, i) => console.log(chalk.dim(`  ${i + 1}.`) + " " + r));
    } catch {
      roles = ["Senior Product Marketing Manager", "Director of PMM", "Head of Product Marketing"];
    }
  }

  console.log("\n");
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Accept all suggested roles", value: "accept" },
      { name: "Add more roles", value: "add" },
      { name: "Edit the list manually", value: "edit" },
      { name: "Start fresh", value: "fresh" }
    ]
  });

  if (action === "accept") return roles;

  if (action === "add") {
    const extras = await input({ message: "Add roles (comma-separated):" });
    const newRoles = extras.split(",").map(r => r.trim()).filter(Boolean);
    roles = [...roles, ...newRoles];
  }

  if (action === "fresh" || action === "edit") {
    const current = action === "edit" ? roles.join("\n") : "";
    console.log(info("Enter one role per line:"));
    const raw = await editor({
      message: "Edit your target roles (one per line):",
      default: current
    });
    roles = raw.split("\n").map(r => r.trim()).filter(Boolean);
  }

  success(`${roles.length} target roles configured`);
  return roles;
}

// ─── Step 3: Target Company Types ───────────────────────────────────────────

async function setupCompanyTypes(
  apiKey: string,
  resumeText: string,
  existing?: string[]
): Promise<string[]> {
  setupStepHeader(5, TOTAL_STEPS, "Company Types");

  let types: string[] = existing ?? [];

  if (types.length === 0) {
    const spinner = ora("Suggesting company types based on your background...").start();
    const raw = await ask(
      apiKey,
      `Based on this resume, suggest 6 specific types of companies this person should target.
Be specific — e.g. "AI-native startups Series B-D" not just "startups".
Return ONLY a JSON array of strings.

Resume:
${resumeText}`,
      "You are a career coach expert."
    );
    spinner.stop();

    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      types = JSON.parse(cleaned);
      console.log(chalk.bold("\n  Suggested company types:\n"));
      types.forEach((t, i) => console.log(chalk.dim(`  ${i + 1}.`) + " " + t));
    } catch {
      types = ["AI-native startups Series B-D", "FAANG AI teams", "Developer tool companies"];
    }
  }

  console.log("\n");
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Accept all suggestions", value: "accept" },
      { name: "Add more types", value: "add" },
      { name: "Edit the list manually", value: "edit" }
    ]
  });

  if (action === "accept") return types;

  if (action === "add") {
    const extras = await input({ message: "Add company types (comma-separated):" });
    types = [...types, ...extras.split(",").map(t => t.trim()).filter(Boolean)];
  }

  if (action === "edit") {
    const raw = await editor({
      message: "Edit company types (one per line):",
      default: types.join("\n")
    });
    types = raw.split("\n").map(t => t.trim()).filter(Boolean);
  }

  success(`${types.length} company types configured`);
  return types;
}

// ─── Step 4: Preferences ─────────────────────────────────────────────────────

async function setupPreferences(
  existing?: UserConfig["preferences"]
): Promise<UserConfig["preferences"]> {
  setupStepHeader(6, TOTAL_STEPS, "Preferences");

  const { input: numberInput } = await import("@inquirer/prompts");

  const dailyRoleCount = parseInt(await numberInput({
    message: "How many roles should the agent find per daily run? (1–10):",
    default: String(existing?.dailyRoleCount ?? 5),
    validate: (v) => {
      const n = parseInt(v);
      if (isNaN(n) || n < 1 || n > 10) return "Enter a number between 1 and 10";
      return true;
    }
  }), 10);

  const minSalaryStr = await input({
    message: "Minimum base salary expectation in USD (press Enter to skip, e.g. 150000):",
    default: existing?.minBaseSalary ? String(existing.minBaseSalary) : "",
    validate: (v) => {
      if (!v.trim()) return true;
      const n = parseInt(v.replace(/[,$]/g, ""));
      if (isNaN(n) || n < 0) return "Enter a number like 150000, or leave blank";
      return true;
    }
  });
  const minBaseSalary = minSalaryStr.trim()
    ? parseInt(minSalaryStr.replace(/[,$]/g, ""))
    : undefined;

  const emailReport = await confirm({
    message: "Send an HTML job report to your email after each run?",
    default: existing?.emailReport ?? false
  });

  if (minBaseSalary) success(`Min base salary: $${(minBaseSalary / 1000).toFixed(0)}k`);
  success(`${dailyRoleCount} roles per run · email report ${emailReport ? "enabled" : "disabled"}`);
  return { dailyRoleCount, minBaseSalary, emailReport };
}

// ─── Step 4b: Email Config ────────────────────────────────────────────────────

async function setupEmailConfig(
  applicantEmail: string,
  existing?: UserConfig["emailConfig"]
): Promise<UserConfig["emailConfig"]> {
  setupStepHeader(6, TOTAL_STEPS, "Email Configuration (Gmail)");
  info("Reports will be sent from your Gmail account using an App Password.");
  info("Generate one at: myaccount.google.com → Security → App Passwords\n");

  while (true) {
    const smtpUser = await input({
      message: "Gmail address to send FROM (e.g. you@gmail.com):",
      default: existing?.smtpUser ?? applicantEmail,
      validate: (v) => v.includes("@") && v.includes(".") ? true : "Enter a valid email address"
    });

    const smtpPass = await input({
      message: "Gmail App Password (16-char, no spaces — NOT your regular password):",
      default: existing?.smtpPass ?? "",
      validate: (v) => {
        const clean = v.replace(/\s/g, "");
        if (clean.length !== 16) return "App Password should be 16 characters (spaces are OK, they'll be stripped)";
        return true;
      }
    });

    const toAddress = await input({
      message: "Send reports TO this address:",
      default: existing?.toAddress ?? applicantEmail,
      validate: (v) => v.includes("@") ? true : "Enter a valid email address"
    });

    const testSpin = ora("Sending a test email...").start();
    try {
      const nodemailer = require("nodemailer");
      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com", port: 587, secure: false,
        auth: { user: smtpUser, pass: smtpPass.replace(/\s/g, "") }
      });
      await transporter.sendMail({
        from: `"Job Search Agent" <${smtpUser}>`,
        to: toAddress,
        subject: "Job Search Agent — Email configured ✓",
        html: "<p>Your email report delivery is set up. You'll receive your daily job report here.</p>"
      });
      testSpin.succeed(`Test email sent to ${toAddress}`);
      return { smtpUser, smtpPass: smtpPass.replace(/\s/g, ""), toAddress };
    } catch (err: any) {
      testSpin.fail(`Could not send test email: ${err.message}`);
      info("Common fixes: make sure 2FA is enabled, and use an App Password not your login password.\n");
    }
  }
}

async function setupApplicantInfo(
  existing?: UserConfig["applicantInfo"]
): Promise<UserConfig["applicantInfo"]> {
  setupStepHeader(7, TOTAL_STEPS, "Contact Info");
  info("Used to fill application forms when auto-applying. Stored locally, never shared.\n");

  const email = await input({
    message: "Your email address:",
    default: existing?.email,
    validate: (v) => v.includes("@") ? true : "Please enter a valid email address"
  });

  const phone = await input({
    message: "Your phone number (optional, press Enter to skip):",
    default: existing?.phone ?? ""
  });

  const linkedin = await input({
    message: "Your LinkedIn URL (optional, press Enter to skip):",
    default: existing?.linkedin ?? ""
  });

  success("Contact info saved");
  return {
    email,
    phone: phone.trim() || undefined,
    linkedin: linkedin.trim() || undefined
  };
}

// ─── Step 6: Output Configuration ───────────────────────────────────────────

async function setupOutput(existing?: UserConfig["output"]): Promise<UserConfig["output"]> {
  setupStepHeader(8, TOTAL_STEPS, "Output");
  info("Where should the agent save your daily job reports and tailored resumes?\n");

  const mode = await select({
    message: "Output destination:",
    choices: [
      { name: "Local folder on this machine", value: "local" },
      { name: "Google Drive folder", value: "google_drive" }
    ],
    default: existing?.mode ?? "local"
  }) as "local" | "google_drive";

  const resumeFormatChoices = mode === "google_drive"
    ? [
        { name: "Google Doc (opens directly in Google Docs)", value: "google_doc" },
        { name: "Word Document (.docx)", value: "word_doc" },
        { name: "Markdown (.md)", value: "markdown" }
      ]
    : [
        { name: "Word Document (.docx)", value: "word_doc" },
        { name: "Markdown (.md)", value: "markdown" }
      ];

  const resumeFormat = await select({
    message: "Tailored resume format:",
    choices: resumeFormatChoices,
    default: existing?.resumeFormat ?? (mode === "google_drive" ? "google_doc" : "word_doc")
  }) as "google_doc" | "word_doc" | "markdown";

  if (mode === "local") {
    const localPath = await input({
      message: "Local folder path:",
      default: existing?.localPath ?? "~/job-search-output",
      validate: async (val) => {
        const expanded = val.replace("~", process.env.HOME!);
        await fs.ensureDir(expanded);
        return true;
      }
    });

    const expanded = localPath.replace("~", process.env.HOME!);
    await fs.ensureDir(expanded);
    success(`Output will be saved to: ${expanded}`);
    return { mode: "local", resumeFormat, localPath };
  }

  // ── Google Drive setup ──────────────────────────────────────────────────

  console.log(chalk.bold.yellow("\n  Google Drive OAuth Setup\n"));
  console.log(`  To connect Google Drive, you need OAuth credentials.
  Follow these steps:\n
  1. Go to: https://console.cloud.google.com/
  2. Create a new project (or select existing)
  3. Enable the Google Drive API:
     APIs & Services → Enable APIs → Search "Google Drive API" → Enable
  4. Create OAuth credentials:
     APIs & Services → Credentials → Create Credentials → OAuth client ID
     → Application type: Desktop app → Name it anything → Create
  5. Copy the Client ID and Client Secret shown on screen
  6. Generate a refresh token via OAuth Playground:
     https://developers.google.com/oauthplayground
     → Settings (gear icon) → check "Use your own OAuth credentials"
     → Enter your Client ID and Secret
     → In Step 1, enter scope: ${chalk.cyan("https://www.googleapis.com/auth/drive.file")}
     → Click Authorize → in Step 2, click "Exchange authorization code for tokens"
     → Copy the ${chalk.bold("refresh_token")} value from the JSON response (starts with 1//)
  7. Find your Drive folder ID from the folder's browser URL:
     https://drive.google.com/drive/folders/${chalk.bold("THIS_IS_THE_FOLDER_ID")}\n`);

  const ready = await confirm({ message: "Do you have your credentials ready?", default: false });
  if (!ready) {
    console.log(chalk.yellow("\n  Setup paused. Run npm run setup again once you have credentials.\n"));
    process.exit(0);
  }

  let clientId   = existing?.googleDrive?.clientId   ?? "";
  let clientSecret = existing?.googleDrive?.clientSecret ?? "";
  let refreshToken = existing?.googleDrive?.refreshToken ?? "";
  let folderId   = existing?.googleDrive?.folderId   ?? "";

  while (true) {
    clientId = await input({
      message: "Google OAuth Client ID (ends with .apps.googleusercontent.com):",
      default: clientId || undefined,
      validate: (v) => v.includes(".apps.googleusercontent.com") ? true : "Should end with .apps.googleusercontent.com"
    });

    clientSecret = await input({
      message: "Google OAuth Client Secret (starts with GOCSPX-):",
      default: clientSecret || undefined,
      validate: (v) => v.startsWith("GOCSPX-") ? true : "Should start with GOCSPX-"
    });

    refreshToken = await input({
      message: "Google OAuth Refresh Token (starts with 1//, copy value only not full JSON):",
      default: refreshToken || undefined,
      validate: (v) => {
        if (v.startsWith("1//")) return true;
        if (v.includes("{") || v.includes("POST") || v.includes("HTTP")) {
          return "Looks like you copied the wrong thing — paste only the refresh_token value (starts with 1//)";
        }
        return "Refresh token should start with 1//";
      }
    });

    folderId = await input({
      message: "Google Drive Folder ID (short alphanumeric string from the folder URL):",
      default: folderId || undefined,
      validate: (v) => {
        const clean = v.trim();
        if (clean.includes("drive.google.com") || clean.includes("http")) {
          return "Paste only the folder ID, not the full URL (the part after /folders/)";
        }
        if (clean.length < 10 || clean.includes(" ")) {
          return "Folder ID should be a short alphanumeric string from the folder URL";
        }
        return true;
      }
    });

    const spinner = ora("Verifying Google Drive access...").start();
    const auth = getAuthClient(clientId, clientSecret, refreshToken.trim());
    const hasAccess = await verifyFolderAccess(auth, folderId.trim());

    if (!hasAccess) {
      spinner.fail(
        "Cannot access that Google Drive folder.\n\n" +
        "  Common causes:\n" +
        "  • Wrong folder ID — copy only the ID from the URL, not the full link\n" +
        "  • Folder not shared with your Google account\n" +
        "  • Refresh token expired — re-generate it from OAuth Playground\n" +
        "  • Wrong OAuth scope — make sure you used https://www.googleapis.com/auth/drive.file\n"
      );
      console.log(chalk.yellow("  Let's try again — you can re-enter just the fields that need fixing.\n"));
      continue;
    }

    spinner.succeed("Google Drive access verified");
    break;
  }

  return {
    mode: "google_drive",
    resumeFormat,
    googleDrive: { folderId, folderName: "job-search-agent", clientId, clientSecret, refreshToken }
  };
}

// ─── Cron setup ──────────────────────────────────────────────────────────────

async function setupCron(): Promise<void> {
  if (process.platform === "win32") {
    console.log(chalk.yellow(
      "\n  ⚠  Windows detected — automatic scheduling requires WSL or Task Scheduler.\n" +
      "  Run npm run cron from a WSL terminal to set it up.\n"
    ));
    return;
  }

  console.log("\n" + chalk.cyan("─".repeat(62)));
  console.log("  " + chalk.bold.white("Automatic Scheduling") + chalk.dim("  (optional)"));
  console.log(chalk.cyan("─".repeat(62)) + "\n");

  const existing = hasExistingCronJob();
  if (existing) {
    console.log(chalk.yellow("  ↻  An existing schedule was found for this agent.\n"));
  }

  const wantsSchedule = await confirm({
    message: existing
      ? "Update the automatic run schedule?"
      : "Run the agent automatically on a schedule?",
    default: true
  });

  if (!wantsSchedule) {
    if (existing) {
      const remove = await confirm({ message: "Remove existing schedule?", default: false });
      if (remove) { removeCronJob(); success("Schedule removed."); }
    } else {
      console.log(chalk.dim("  Skipped — run npm run cron later to set up a schedule.\n"));
    }
    return;
  }

  const frequency = await select({
    message: "How often should the agent run?",
    choices: [
      { name: "Daily   — runs every day at a set time", value: "daily"  },
      { name: "Weekly  — runs once a week on a chosen day", value: "weekly" }
    ]
  }) as "daily" | "weekly";

  let weekday: number | undefined;
  if (frequency === "weekly") {
    weekday = await select({
      message: "Which day of the week?",
      choices: WEEKDAYS
    });
  }

  const timeChoice = await select({
    message: "What time should it run?",
    choices: [
      { name: "6:00 AM",  value: { hour: 6,  minute: 0  } },
      { name: "7:00 AM",  value: { hour: 7,  minute: 0  } },
      { name: "8:00 AM",  value: { hour: 8,  minute: 0  } },
      { name: "9:00 AM",  value: { hour: 9,  minute: 0  } },
      { name: "12:00 PM", value: { hour: 12, minute: 0  } },
      { name: "Custom",   value: { hour: -1, minute: -1 } }
    ]
  });

  let { hour, minute } = timeChoice;
  if (hour === -1) {
    hour   = parseInt(await input({ message: "Hour (0–23):",   validate: v => parseInt(v) >= 0 && parseInt(v) <= 23 ? true : "Enter 0–23" }));
    minute = parseInt(await input({ message: "Minute (0–59):", default: "0", validate: v => parseInt(v) >= 0 && parseInt(v) <= 59 ? true : "Enter 0–59" }));
  }

  const schedule: CronSchedule = { frequency, hour, minute, weekday };

  try {
    installCronJob(schedule);
    success(`Scheduled: ${describeSchedule(schedule)}`);
    console.log(chalk.dim(`  Logs: ${LOG_FILE}\n`));
  } catch (err: any) {
    console.log(chalk.red(`  Could not install cron job: ${err.message}`));
    console.log(chalk.dim("  Run npm run cron later to set it up manually.\n"));
  }
}

// ─── Review screen ───────────────────────────────────────────────────────────

function printReview(
  apiKey: string,
  model: string,
  resume: UserConfig["resume"],
  roles: string[],
  companies: string[],
  preferences: UserConfig["preferences"],
  applicantInfo: UserConfig["applicantInfo"],
  emailConfig: UserConfig["emailConfig"] | undefined,
  output: UserConfig["output"]
) {
  const masked = apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
  const outputDesc = output.mode === "local"
    ? `Local → ${output.localPath}`
    : `Google Drive (${output.resumeFormat})`;
  const salaryDesc = preferences.minBaseSalary
    ? `$${(preferences.minBaseSalary / 1000).toFixed(0)}k min base`
    : "no minimum";
  const emailDesc = preferences.emailReport
    ? (emailConfig ? emailConfig.toAddress : "enabled — email not configured")
    : "disabled";

  reviewBox([
    { label: "API Key",       value: masked },
    { label: "Model",         value: model },
    { label: "Resume",        value: resume.parsedText.split(/\s+/).length + " words" },
    { label: "Target Roles",  value: roles.slice(0, 2).join(", ") + (roles.length > 2 ? ` +${roles.length - 2} more` : "") },
    { label: "Company Types", value: companies.length + " types" },
    { label: "Roles/Day",     value: String(preferences.dailyRoleCount) },
    { label: "Min Salary",    value: salaryDesc },
    { label: "Email Report",  value: emailDesc },
    { label: "Contact",       value: applicantInfo.email + (applicantInfo.phone ? " · " + applicantInfo.phone : "") },
    { label: "Output",        value: outputDesc },
  ]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  infoBox("job-search-agent  setup", [
    chalk.dim("AI-powered job search via Claude · search, score, tailor, apply"),
    "",
    chalk.dim("You'll be guided through 8 steps. Press") + " Ctrl+C " + chalk.dim("at any time to exit.")
  ]);

  // Allow Ctrl+C to exit cleanly at any point
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n  Setup cancelled. Run npm run setup to continue.\n"));
    process.exit(0);
  });

  const existing = await loadConfig();

  if (existing) {
    console.log(chalk.yellow("  ↻  Existing config found — running in update mode.\n"));
  }

  // Run all steps once upfront
  let apiKey        = await setupApiKey(existing?.anthropicApiKey);
  let model         = await setupModel(existing?.model);
  let resume        = await setupResume(apiKey, existing?.resume);
  let roles         = await setupTargetRoles(apiKey, resume.parsedText, existing?.targetRoles);
  let companies     = await setupCompanyTypes(apiKey, resume.parsedText, existing?.targetCompanyTypes);
  let preferences   = await setupPreferences(existing?.preferences);
  let applicantInfo = await setupApplicantInfo(existing?.applicantInfo);
  let emailConfig: UserConfig["emailConfig"] = existing?.emailConfig;
  if (preferences.emailReport && !emailConfig) {
    emailConfig = await setupEmailConfig(applicantInfo.email, existing?.emailConfig);
  }
  let output        = await setupOutput(existing?.output);

  // Review + edit loop
  while (true) {
    printReview(apiKey, model, resume, roles, companies, preferences, applicantInfo, emailConfig, output);

    const action = await select({
      message: "Ready to save?",
      choices: [
        { name: "✅  Save and finish", value: "save" },
        { name: "✏️   Edit API key", value: "apiKey" },
        { name: "✏️   Edit model", value: "model" },
        { name: "✏️   Edit resume", value: "resume" },
        { name: "✏️   Edit target roles", value: "roles" },
        { name: "✏️   Edit company types", value: "companies" },
        { name: "✏️   Edit preferences", value: "preferences" },
        { name: "✏️   Edit contact info", value: "contact" },
        { name: "✏️   Edit email settings", value: "email" },
        { name: "✏️   Edit output settings", value: "output" },
        { name: "✖   Exit without saving", value: "exit" },
      ]
    });

    if (action === "save") break;
    if (action === "exit") {
      console.log(chalk.yellow("\n  Exited without saving. Run npm run setup to continue.\n"));
      process.exit(0);
    }
    if (action === "apiKey")      apiKey        = await setupApiKey(apiKey);
    if (action === "model")       model         = await setupModel(model);
    if (action === "resume")      resume        = await setupResume(apiKey, resume);
    if (action === "roles")       roles         = await setupTargetRoles(apiKey, resume.parsedText, roles);
    if (action === "companies")   companies     = await setupCompanyTypes(apiKey, resume.parsedText, companies);
    if (action === "preferences") preferences   = await setupPreferences(preferences);
    if (action === "contact")     applicantInfo = await setupApplicantInfo(applicantInfo);
    if (action === "email")       emailConfig   = await setupEmailConfig(applicantInfo.email, emailConfig);
    if (action === "output")      output        = await setupOutput(output);

    // If email report was just enabled and no config yet, prompt for it
    if (action === "preferences" && preferences.emailReport && !emailConfig) {
      emailConfig = await setupEmailConfig(applicantInfo.email);
    }
  }

  const config: UserConfig = {
    version: "1.0.0",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resume,
    targetRoles: roles,
    targetCompanyTypes: companies,
    preferences,
    output,
    anthropicApiKey: apiKey,
    model,
    applicantInfo,
    emailConfig
  };

  await saveConfig(config);

  // Optional cron scheduling — always offered at end of setup
  await setupCron();

  successBox("Setup complete!", [
    chalk.dim("Config saved to: ") + chalk.white(CONFIG_PATH),
    "",
    chalk.bold("Next step:") + "  " + chalk.cyan("npm run run") + chalk.dim("  — start your first job search"),
    "",
    chalk.dim("npm run status") + "   view application tracker",
    chalk.dim("npm run resume") + "   update your master resume",
    chalk.dim("npm run cron")   + "     update schedule anytime",
    chalk.dim("npm run setup")  + "    change any setting",
  ]);

  process.exit(0);
}

main().catch((err) => {
  // @inquirer/prompts v8 throws ExitPromptError on Ctrl+C — treat as clean exit
  if (err?.name === "ExitPromptError" || err?.constructor?.name === "ExitPromptError") {
    console.log(chalk.yellow("\n\n  Setup cancelled. Run npm run setup to continue.\n"));
    process.exit(0);
  }
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
