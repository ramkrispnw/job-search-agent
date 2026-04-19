// src/setup/index.ts — interactive setup wizard

import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import * as fs from "fs-extra";
import { input, confirm, select, checkbox, editor } from "@inquirer/prompts";
import { UserConfig, CONFIG_PATH, CONFIG_DIR } from "../config/types.js";
import { parseResume, extractGoogleDocId, fetchGoogleDoc } from "../utils/resumeParser.js";
import { ask } from "../utils/claude.js";
import { saveConfig, loadConfig } from "../utils/config.js";
import { getAuthClient, verifyFolderAccess } from "../tools/googleDrive.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function header(text: string) {
  console.log("\n" + chalk.bold.cyan("━".repeat(60)));
  console.log(chalk.bold.white(` ${text}`));
  console.log(chalk.bold.cyan("━".repeat(60)) + "\n");
}

function success(text: string) {
  console.log(chalk.green("  ✓ ") + text);
}

function info(text: string) {
  console.log(chalk.dim("  ℹ ") + text);
}

// ─── Step 0: API Key ─────────────────────────────────────────────────────────

async function setupApiKey(existing?: string): Promise<string> {
  header("Step 0 — Anthropic API Key");
  info("Your API key is stored locally in ~/.job-search-agent/config.json");
  info("Get one at: https://console.anthropic.com/settings/keys\n");

  const apiKey = await input({
    message: "Enter your Anthropic API key:",
    default: existing,
    validate: (val) => val.startsWith("sk-") ? true : "Key must start with sk-"
  });

  // Quick sanity check
  const spinner = ora("Verifying API key...").start();
  try {
    await ask(apiKey, "Say OK", undefined, 10);
    spinner.succeed("API key verified");
  } catch {
    spinner.fail("Could not verify API key — please check it and try again");
    process.exit(1);
  }

  return apiKey;
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
  header("Step 0b — Claude Model");
  info("Choose which Claude model powers the agent. This affects quality and API cost.\n");

  return select({
    message: "Claude model:",
    choices: MODELS,
    default: existing ?? "claude-sonnet-4-6"
  });
}

// ─── Step 1: Resume Upload ───────────────────────────────────────────────────

async function setupResume(apiKey: string, existing?: UserConfig["resume"]): Promise<UserConfig["resume"]> {
  header("Step 1 — Upload Your Resume");

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

    const docInput = await input({
      message: "Google Doc URL or document ID:",
      validate: (val) => extractGoogleDocId(val) ? true : "Could not find a Google Doc ID in that input"
    });

    const docId = extractGoogleDocId(docInput)!;
    const spinner = ora("Fetching your Google Doc...").start();
    try {
      parsedText = await fetchGoogleDoc(docId);
      spinner.succeed(`Fetched ${parsedText.split(" ").length} words from Google Doc`);
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }

    // Save a plain-text copy locally for offline use
    await fs.ensureDir(CONFIG_DIR);
    originalPath = path.join(CONFIG_DIR, "resume.txt");
    await fs.writeFile(originalPath, parsedText, "utf8");
    success(`Local copy saved to ${originalPath}`);
  } else {
    const filePath = await input({
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

    const expanded = filePath.replace("~", process.env.HOME!);
    const spinner = ora("Reading and parsing your resume...").start();
    try {
      parsedText = await parseResume(expanded);
      spinner.succeed(`Parsed ${parsedText.split(" ").length} words from your resume`);
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }

    await fs.ensureDir(CONFIG_DIR);
    originalPath = path.join(CONFIG_DIR, "resume" + path.extname(expanded));
    await fs.copyFile(expanded, originalPath);
    success(`Resume saved to ${originalPath}`);
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
  header("Step 2 — Target Roles");

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
  header("Step 3 — Target Company Types");

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

// ─── Step 4: Applicant Info ──────────────────────────────────────────────────

async function setupApplicantInfo(
  existing?: UserConfig["applicantInfo"]
): Promise<UserConfig["applicantInfo"]> {
  header("Step 4 — Contact Info for Auto-Apply");
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

// ─── Step 5: Output Configuration ───────────────────────────────────────────

async function setupOutput(existing?: UserConfig["output"]): Promise<UserConfig["output"]> {
  header("Step 5 — Output Configuration");
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
  5. Download the client ID and secret shown
  6. Generate a refresh token:
     Run this command in your terminal:
     ${chalk.cyan("npx --yes google-auth-library-nodejs-samples oauth2")}
     Or use the OAuth Playground: https://developers.google.com/oauthplayground
     (Scope needed: https://www.googleapis.com/auth/drive.file)
  7. Copy the refresh token from the response\n`);

  const ready = await confirm({ message: "Do you have your credentials ready?", default: false });
  if (!ready) {
    console.log(chalk.yellow("\n  Setup paused. Run npm run setup again once you have credentials.\n"));
    process.exit(0);
  }

  const clientId = await input({
    message: "Google OAuth Client ID:",
    default: existing?.googleDrive?.clientId,
    validate: (v) => v.length > 10 ? true : "Please enter a valid client ID"
  });

  const clientSecret = await input({
    message: "Google OAuth Client Secret:",
    default: existing?.googleDrive?.clientSecret,
    validate: (v) => v.length > 5 ? true : "Please enter a valid client secret"
  });

  const refreshToken = await input({
    message: "Google OAuth Refresh Token:",
    default: existing?.googleDrive?.refreshToken,
    validate: (v) => v.length > 10 ? true : "Please enter a valid refresh token"
  });

  const folderId = await input({
    message: "Google Drive Folder ID (from the folder URL):",
    default: existing?.googleDrive?.folderId,
    validate: (v) => v.length > 5 ? true : "Please enter a valid folder ID"
  });

  // Verify access
  const spinner = ora("Verifying Google Drive access...").start();
  const auth = getAuthClient(clientId, clientSecret, refreshToken);
  const hasAccess = await verifyFolderAccess(auth, folderId);

  if (!hasAccess) {
    spinner.fail("Cannot access that Google Drive folder. Check folder ID and permissions.");
    process.exit(1);
  }
  spinner.succeed("Google Drive access verified");

  return {
    mode: "google_drive",
    resumeFormat,
    googleDrive: { folderId, folderName: "job-search-agent", clientId, clientSecret, refreshToken }
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold.cyan(`
  ╔══════════════════════════════════════════╗
  ║        job-search-agent  setup           ║
  ║  AI-powered job search via Claude Code   ║
  ╚══════════════════════════════════════════╝
  `));

  const existing = await loadConfig();

  if (existing) {
    console.log(chalk.yellow("  Existing configuration found. Running in update mode.\n"));
  }

  // Run all steps
  const apiKey        = await setupApiKey(existing?.anthropicApiKey);
  const model         = await setupModel(existing?.model);
  const resume        = await setupResume(apiKey, existing?.resume);
  const roles         = await setupTargetRoles(apiKey, resume.parsedText, existing?.targetRoles);
  const companies     = await setupCompanyTypes(apiKey, resume.parsedText, existing?.targetCompanyTypes);
  const applicantInfo = await setupApplicantInfo(existing?.applicantInfo);
  const output        = await setupOutput(existing?.output);

  // Save config
  const config: UserConfig = {
    version: "1.0.0",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resume,
    targetRoles: roles,
    targetCompanyTypes: companies,
    output,
    anthropicApiKey: apiKey,
    model,
    applicantInfo
  };

  await saveConfig(config);

  console.log(chalk.bold.green(`
  ✅  Setup complete!

  Config saved to: ${CONFIG_PATH}

  To run the agent:
  ${chalk.cyan("npm run run")}

  The agent will:
  • Search the web for your best-fit roles
  • Shortlist the top 5
  • Generate a jobs report
  • Write a tailored resume for each role
  • Save everything to your output folder
  `));
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
