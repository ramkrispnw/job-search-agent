// src/cli/resume.ts — edit the master resume stored in config

import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import * as fs from "fs-extra";
import { select, input, editor } from "@inquirer/prompts";
import { loadConfig, saveConfig } from "../utils/config";
import { parseResume, extractGoogleDocId, fetchGoogleDoc } from "../utils/resumeParser";
import { CONFIG_DIR } from "../config/types";
import { format } from "date-fns";

function header(text: string) {
  console.log("\n" + chalk.bold.cyan("━".repeat(60)));
  console.log(chalk.bold.white(` ${text}`));
  console.log(chalk.bold.cyan("━".repeat(60)) + "\n");
}

async function main() {
  console.log(chalk.bold.cyan(`
  ╔══════════════════════════════════════════╗
  ║        job-search-agent                  ║
  ║  Master Resume Editor                    ║
  ╚══════════════════════════════════════════╝
  `));

  const config = await loadConfig();
  if (!config) {
    console.error(chalk.red("  No config found. Run setup first:\n  npm run setup"));
    process.exit(1);
  }

  const { resume } = config;
  const wordCount = resume.parsedText.split(/\s+/).length;
  const lastUpdated = format(new Date(resume.lastUpdated), "MMM d, yyyy 'at' h:mm a");

  console.log(chalk.dim(`  Current resume: ${wordCount} words · last updated ${lastUpdated}\n`));

  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Edit in terminal editor", value: "edit" },
      { name: "Re-upload from local file (PDF, DOCX, TXT, MD)", value: "file" },
      { name: "Re-fetch from Google Doc", value: "google_doc" },
    ]
  });

  let updatedText: string | null = null;

  if (action === "edit") {
    updatedText = await editor({
      message: "Edit your resume (saved when you close the editor):",
      default: resume.parsedText
    });
    updatedText = updatedText.trim();
  }

  if (action === "file") {
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
    const spinner = ora("Parsing resume...").start();
    try {
      updatedText = await parseResume(expanded);
      spinner.succeed(`Parsed ${updatedText.split(/\s+/).length} words`);

      const destPath = path.join(CONFIG_DIR, "resume" + path.extname(expanded));
      await fs.copyFile(expanded, destPath);
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }
  }

  if (action === "google_doc") {
    console.log(chalk.dim('  Make sure the doc is shared with "Anyone with the link can view"\n'));

    const docInput = await input({
      message: "Google Doc URL or document ID:",
      validate: (val) => extractGoogleDocId(val) ? true : "Could not find a Google Doc ID in that input"
    });

    const docId = extractGoogleDocId(docInput)!;
    const spinner = ora("Fetching Google Doc...").start();
    try {
      updatedText = await fetchGoogleDoc(docId);
      spinner.succeed(`Fetched ${updatedText.split(/\s+/).length} words`);

      const localCopy = path.join(CONFIG_DIR, "resume.txt");
      await fs.writeFile(localCopy, updatedText, "utf8");
    } catch (err: any) {
      spinner.fail(err.message);
      process.exit(1);
    }
  }

  if (!updatedText || updatedText === resume.parsedText) {
    console.log(chalk.yellow("\n  No changes made.\n"));
    return;
  }

  config.resume = {
    ...resume,
    parsedText: updatedText,
    lastUpdated: new Date().toISOString()
  };

  await saveConfig(config);

  const newWordCount = updatedText.split(/\s+/).length;
  console.log(chalk.bold.green(`
  ✅  Resume updated!

  ${newWordCount} words · saved to config
  The next agent run will use your updated resume.
  `));
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
