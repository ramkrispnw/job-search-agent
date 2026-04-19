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

  while (true) {
    const apiKey = await input({
      message: "Enter your Anthropic API key:",
      default: existing,
      validate: (val) => val.startsWith("sk-") ? true : "Key must start with sk-"
    });

    const spinner = ora("Verifying API key...").start();
    try {
      await ask(apiKey, "Say OK", undefined, 10);
      spinner.succeed("API key verified");
      return apiKey;
    } catch {
      spinner.fail("Could not verify API key — please check it and try again");
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
      message: "Google OAuth Client ID:",
      hint: "ends with .apps.googleusercontent.com",
      default: clientId || undefined,
      validate: (v) => v.includes(".apps.googleusercontent.com") ? true : "Should end with .apps.googleusercontent.com"
    });

    clientSecret = await input({
      message: "Google OAuth Client Secret:",
      hint: "starts with GOCSPX-",
      default: clientSecret || undefined,
      validate: (v) => v.startsWith("GOCSPX-") ? true : "Should start with GOCSPX-"
    });

    refreshToken = await input({
      message: "Google OAuth Refresh Token:",
      hint: "starts with 1// — copy only the token value, not the full JSON",
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
      message: "Google Drive Folder ID:",
      hint: "the last part of the folder URL — short alphanumeric string only",
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

// ─── Review screen ───────────────────────────────────────────────────────────

function printReview(
  apiKey: string,
  model: string,
  resume: UserConfig["resume"],
  roles: string[],
  companies: string[],
  applicantInfo: UserConfig["applicantInfo"],
  output: UserConfig["output"]
) {
  const masked = apiKey.slice(0, 8) + "..." + apiKey.slice(-4);
  const outputDesc = output.mode === "local"
    ? `Local → ${output.localPath}`
    : `Google Drive (${output.resumeFormat})`;

  console.log(chalk.bold("\n  Review your configuration:\n"));
  console.log(`  ${chalk.dim("0.")}  API Key        ${chalk.white(masked)}`);
  console.log(`  ${chalk.dim("0b.")} Model          ${chalk.white(model)}`);
  console.log(`  ${chalk.dim("1.")}  Resume         ${chalk.white(resume.parsedText.split(/\s+/).length + " words")}`);
  console.log(`  ${chalk.dim("2.")}  Target Roles   ${chalk.white(roles.length + " roles: " + roles.slice(0, 2).join(", ") + (roles.length > 2 ? " ..." : ""))}`);
  console.log(`  ${chalk.dim("3.")}  Company Types  ${chalk.white(companies.length + " types")}`);
  console.log(`  ${chalk.dim("4.")}  Contact Info   ${chalk.white(applicantInfo.email + (applicantInfo.phone ? " · " + applicantInfo.phone : ""))}`);
  console.log(`  ${chalk.dim("5.")}  Output         ${chalk.white(outputDesc)}`);
  console.log();
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

  // Run all steps once upfront
  let apiKey        = await setupApiKey(existing?.anthropicApiKey);
  let model         = await setupModel(existing?.model);
  let resume        = await setupResume(apiKey, existing?.resume);
  let roles         = await setupTargetRoles(apiKey, resume.parsedText, existing?.targetRoles);
  let companies     = await setupCompanyTypes(apiKey, resume.parsedText, existing?.targetCompanyTypes);
  let applicantInfo = await setupApplicantInfo(existing?.applicantInfo);
  let output        = await setupOutput(existing?.output);

  // Review + edit loop
  while (true) {
    printReview(apiKey, model, resume, roles, companies, applicantInfo, output);

    const action = await select({
      message: "Ready to save?",
      choices: [
        { name: "✅  Save and finish", value: "save" },
        { name: "✏️   Edit API key", value: "apiKey" },
        { name: "✏️   Edit model", value: "model" },
        { name: "✏️   Edit resume", value: "resume" },
        { name: "✏️   Edit target roles", value: "roles" },
        { name: "✏️   Edit company types", value: "companies" },
        { name: "✏️   Edit contact info", value: "contact" },
        { name: "✏️   Edit output settings", value: "output" },
      ]
    });

    if (action === "save") break;
    if (action === "apiKey")    apiKey        = await setupApiKey(apiKey);
    if (action === "model")     model         = await setupModel(model);
    if (action === "resume")    resume        = await setupResume(apiKey, resume);
    if (action === "roles")     roles         = await setupTargetRoles(apiKey, resume.parsedText, roles);
    if (action === "companies") companies     = await setupCompanyTypes(apiKey, resume.parsedText, companies);
    if (action === "contact")   applicantInfo = await setupApplicantInfo(applicantInfo);
    if (action === "output")    output        = await setupOutput(output);
  }

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

  Commands:
    npm run run     — search, tailor, and apply
    npm run status  — view application tracker
    npm run resume  — update your master resume
  `));
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
