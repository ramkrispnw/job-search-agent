// src/cli/cron.ts — automated cron job setup for daily agent runs

import chalk from "chalk";
import { select, input, confirm } from "@inquirer/prompts";
import { execSync, exec } from "child_process";
import * as path from "path";
import * as os from "os";

const PROJECT_DIR = path.resolve(__dirname, "../../");
const LOG_FILE    = path.join(os.homedir(), "logs", "job-search-agent.log");

function getCurrentCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null").toString();
  } catch {
    return "";
  }
}

function setCrontab(content: string): void {
  const { writeFileSync } = require("fs");
  const tmpFile = `/tmp/crontab-${Date.now()}.txt`;
  writeFileSync(tmpFile, content);
  execSync(`crontab ${tmpFile}`);
  require("fs").unlinkSync(tmpFile);
}

function buildCronLine(hour: number, minute: number, projectDir: string, logFile: string): string {
  const nodebin = process.execPath;
  return `${minute} ${hour} * * * cd ${projectDir} && ${nodebin} node_modules/.bin/ts-node src/agent/index.ts >> ${logFile} 2>&1`;
}

async function main() {
  console.log(chalk.bold.cyan(`
  ╔══════════════════════════════════════════╗
  ║       job-search-agent  cron setup       ║
  ╚══════════════════════════════════════════╝
  `));

  // Detect platform
  const platform = process.platform;
  if (platform === "win32") {
    console.log(chalk.yellow(`
  Windows detected. Cron setup requires WSL or Task Scheduler.

  For WSL, open your WSL terminal and re-run:
    npm run cron

  For Task Scheduler, create a task that runs daily:
    Action: node ${PROJECT_DIR}/node_modules/.bin/ts-node src/agent/index.ts
    Start in: ${PROJECT_DIR}
    `));
    process.exit(0);
  }

  // Check existing cron
  const existing = getCurrentCrontab();
  const hasExisting = existing.includes("job-search-agent");

  if (hasExisting) {
    console.log(chalk.yellow("  An existing job-search-agent cron job was found:\n"));
    const lines = existing.split("\n").filter(l => l.includes("job-search-agent"));
    lines.forEach(l => console.log(chalk.dim(`  ${l}`)));
    console.log();

    const overwrite = await confirm({ message: "Replace existing cron job?", default: false });
    if (!overwrite) { console.log(chalk.dim("  Cron setup cancelled.")); process.exit(0); }
  }

  // Choose time
  const timeChoice = await select({
    message: "When should the agent run daily?",
    choices: [
      { name: "6:00 AM", value: { hour: 6,  minute: 0 } },
      { name: "7:00 AM", value: { hour: 7,  minute: 0 } },
      { name: "8:00 AM", value: { hour: 8,  minute: 0 } },
      { name: "9:00 AM", value: { hour: 9,  minute: 0 } },
      { name: "Custom",  value: { hour: -1, minute: -1 } }
    ]
  });

  let hour = timeChoice.hour;
  let minute = timeChoice.minute;

  if (hour === -1) {
    const hStr = await input({ message: "Hour (0–23):", validate: v => {
      const n = parseInt(v); return (n >= 0 && n <= 23) ? true : "Enter 0–23";
    }});
    const mStr = await input({ message: "Minute (0–59):", default: "0", validate: v => {
      const n = parseInt(v); return (n >= 0 && n <= 59) ? true : "Enter 0–59";
    }});
    hour = parseInt(hStr);
    minute = parseInt(mStr);
  }

  // Ensure log dir exists
  require("fs-extra").ensureDirSync(path.dirname(LOG_FILE));

  const cronLine = buildCronLine(hour, minute, PROJECT_DIR, LOG_FILE);

  console.log(chalk.dim(`\n  Will add:\n  ${cronLine}\n`));
  const confirmed = await confirm({ message: "Add this cron job?", default: true });

  if (!confirmed) { console.log(chalk.dim("  Cancelled.")); process.exit(0); }

  // Remove old job-search-agent lines + add new
  const cleanedCrontab = existing
    .split("\n")
    .filter(l => !l.includes("job-search-agent"))
    .join("\n")
    .trim();

  const newCrontab = (cleanedCrontab ? cleanedCrontab + "\n" : "") + cronLine + "\n";
  setCrontab(newCrontab);

  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  console.log(chalk.bold.green(`
  ✅  Cron job installed!

  The agent will run every day at ${timeStr}.
  Logs: ${LOG_FILE}

  To view logs:
    tail -f ${LOG_FILE}

  To remove the cron job:
    crontab -e   (delete the job-search-agent line)

  To run the agent right now:
    npm run run
  `));
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
