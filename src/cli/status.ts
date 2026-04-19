// src/cli/status.ts — application tracker dashboard

import chalk from "chalk";
import { select } from "@inquirer/prompts";
import { getAll, getPending, getStats, markStatus, AppStatus } from "../tracker/index";
import { format, parseISO } from "date-fns";

function statusColor(status: AppStatus): string {
  const colors: Record<AppStatus, (s: string) => string> = {
    queued:       chalk.dim,
    applied:      chalk.blue,
    interviewing: chalk.green,
    rejected:     chalk.red,
    offer:        chalk.bold.green,
    skipped:      chalk.gray
  };
  return (colors[status] ?? chalk.white)(status.toUpperCase());
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try { return format(parseISO(iso), "MMM d"); } catch { return iso.slice(0, 10); }
}

async function main() {
  console.log(chalk.bold.cyan(`
  ╔══════════════════════════════════════════╗
  ║       job-search-agent  status           ║
  ╚══════════════════════════════════════════╝
  `));

  let apps;
  try {
    apps = getAll();
  } catch {
    console.log(chalk.yellow("  No applications tracked yet. Run the agent first:\n  npm run run\n"));
    process.exit(0);
  }

  if (apps.length === 0) {
    console.log(chalk.dim("  No applications on record yet.\n"));
    process.exit(0);
  }

  // ── Stats bar ─────────────────────────────────────────────────────────────
  const stats = getStats();
  console.log(
    chalk.bold("  Totals: ") +
    `${stats.total} tracked  ·  ` +
    chalk.blue(`${stats.applied} applied`) + "  ·  " +
    chalk.green(`${stats.interviewing} interviewing`) + "  ·  " +
    chalk.bold.green(`${stats.offers} offers`) + "  ·  " +
    chalk.yellow(`${stats.responseRate} response rate`) + "\n"
  );

  // ── Table ─────────────────────────────────────────────────────────────────
  const cols = [
    { label: "#",        width: 3 },
    { label: "Company",  width: 22 },
    { label: "Title",    width: 30 },
    { label: "Fit",      width: 4 },
    { label: "Status",   width: 14 },
    { label: "Applied",  width: 8 },
    { label: "Response", width: 9 }
  ];

  const headerRow = cols.map(c => c.label.padEnd(c.width)).join("  ");
  console.log(chalk.bold("  " + headerRow));
  console.log(chalk.dim("  " + "─".repeat(headerRow.length)));

  apps.slice(0, 30).forEach((app, i) => {
    const row = [
      String(i + 1).padEnd(3),
      app.company.slice(0, 22).padEnd(22),
      app.title.slice(0, 30).padEnd(30),
      String(app.alignment ?? "—").padEnd(4),
      app.status.padEnd(14),
      fmtDate(app.applied_at).padEnd(8),
      fmtDate(app.response_at).padEnd(9)
    ].join("  ");
    console.log("  " + statusColor(app.status as AppStatus).replace(app.status.toUpperCase(), row));
  });

  if (apps.length > 30) {
    console.log(chalk.dim(`\n  ... and ${apps.length - 30} more`));
  }

  // ── Interactive update ────────────────────────────────────────────────────
  console.log();
  const action = await select({
    message: "What would you like to do?",
    choices: [
      { name: "Update application status", value: "update" },
      { name: "View pending (queued) applications", value: "pending" },
      { name: "Exit", value: "exit" }
    ]
  });

  if (action === "exit") process.exit(0);

  if (action === "pending") {
    const pending = getPending();
    console.log(chalk.bold(`\n  ${pending.length} pending applications:\n`));
    pending.forEach((app, i) => {
      console.log(`  ${i+1}. ${chalk.bold(app.company)} — ${app.title}`);
      console.log(chalk.dim(`     ${app.url ?? "No URL"}\n`));
    });
    process.exit(0);
  }

  if (action === "update") {
    const { input } = await import("@inquirer/prompts");
    const jobIdxStr = await input({ message: "Enter application # to update:" });
    const idx = parseInt(jobIdxStr) - 1;
    const app = apps[idx];
    if (!app) { console.log(chalk.red("  Invalid number.")); process.exit(1); }

    const newStatus = await select({
      message: `New status for ${app.company} — ${app.title}:`,
      choices: [
        { name: "Applied",      value: "applied" },
        { name: "Interviewing", value: "interviewing" },
        { name: "Rejected",     value: "rejected" },
        { name: "Offer",        value: "offer" },
        { name: "Skipped",      value: "skipped" }
      ]
    }) as AppStatus;

    const notes = await input({ message: "Notes (optional):", default: "" });
    markStatus(app.job_id, newStatus, notes || undefined);
    console.log(chalk.green(`\n  ✓ Updated ${app.company} → ${newStatus}\n`));
  }
}

main().catch((err) => {
  console.error(chalk.red("\n  Error: " + err.message));
  process.exit(1);
});
