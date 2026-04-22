// src/cli/cron.ts — standalone cron schedule manager

import chalk from "chalk";
import { select, input, confirm } from "@inquirer/prompts";
import {
  installCronJob, removeCronJob, hasExistingCronJob,
  buildCronLine, describeSchedule, WEEKDAYS, CronSchedule, LOG_FILE
} from "../utils/cronManager";
import { infoBox, successBox } from "../utils/ui";

async function main() {
  if (process.platform === "win32") {
    infoBox("Cron setup — Windows", [
      chalk.yellow("Automatic scheduling requires WSL or Task Scheduler."),
      "",
      chalk.dim("WSL: open your WSL terminal and re-run ") + chalk.white("npm run cron"),
      chalk.dim("Task Scheduler: run agent/index.ts daily via ts-node")
    ]);
    process.exit(0);
  }

  infoBox("job-search-agent  schedule", [
    chalk.dim("Set up automatic daily or weekly agent runs via cron")
  ]);

  const existing = hasExistingCronJob();
  if (existing) {
    console.log(chalk.yellow("  ↻  Existing job-search-agent schedule found.\n"));
  }

  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: existing ? "Update schedule" : "Set up schedule", value: "install" },
      ...(existing ? [{ name: "Remove schedule", value: "remove" }] : []),
      { name: "Exit", value: "exit" }
    ]
  });

  if (action === "exit") process.exit(0);

  if (action === "remove") {
    const confirmed = await confirm({ message: "Remove the job-search-agent cron job?", default: false });
    if (confirmed) { removeCronJob(); console.log(chalk.green("  ✓ Schedule removed.\n")); }
    process.exit(0);
  }

  // ── Build schedule ─────────────────────────────────────────────────────────

  const frequency = await select({
    message: "How often should the agent run?",
    choices: [
      { name: "Daily   — runs every day at a set time",       value: "daily"  },
      { name: "Weekly  — runs once a week on a chosen day",   value: "weekly" }
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

  console.log(chalk.dim(`\n  Cron line: ${buildCronLine(schedule)}\n`));
  const confirmed = await confirm({ message: `Schedule: ${describeSchedule(schedule)} — confirm?`, default: true });
  if (!confirmed) { console.log(chalk.dim("  Cancelled.")); process.exit(0); }

  installCronJob(schedule);

  successBox("Schedule installed!", [
    chalk.white(describeSchedule(schedule)),
    "",
    chalk.dim("Logs: ") + chalk.white(LOG_FILE),
    "",
    chalk.dim("tail -f " + LOG_FILE + "   — watch live logs"),
    chalk.dim("npm run cron              — update schedule"),
    chalk.dim("crontab -e               — edit manually"),
  ]);
}

main().catch((err) => {
  if (err?.name === "ExitPromptError" || err?.constructor?.name === "ExitPromptError") process.exit(0);
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
