// src/utils/ui.ts — shared terminal UI components

import chalk from "chalk";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const boxen = require("boxen").default as (text: string, opts: any) => string;

// ─── Progress bar ─────────────────────────────────────────────────────────────

export function progressBar(current: number, total: number, width = 24): string {
  const filled = Math.round((current / total) * width);
  return chalk.cyan("▓".repeat(filled)) + chalk.dim("░".repeat(width - filled));
}

// ─── Setup step header ────────────────────────────────────────────────────────

export function setupStepHeader(step: number, total: number, title: string): void {
  const bar   = progressBar(step, total);
  const label = chalk.bold.white(`Step ${step} of ${total}`);
  const line  = "─".repeat(62);

  console.log("\n" + chalk.cyan(line));
  console.log(`  ${label}  ${bar}  ${chalk.bold.white(title)}`);
  console.log(chalk.cyan(line));
  console.log(chalk.dim("  Ctrl+C at any time to exit without saving\n"));
}

// ─── Agent step header ────────────────────────────────────────────────────────

export function agentHeader(step: number, total: number, title: string): void {
  console.log("\n" + chalk.bold.cyan("━".repeat(60)));
  console.log(chalk.bold.white(`  Step ${step}/${total} — ${title}`));
  console.log(chalk.bold.cyan("━".repeat(60)) + "\n");
}

// ─── Boxen wrappers ───────────────────────────────────────────────────────────

export function infoBox(title: string, lines: string[]): void {
  const content = lines.join("\n");
  console.log(boxen(content, {
    title: chalk.bold.white(title),
    titleAlignment: "left",
    padding: { top: 0, bottom: 0, left: 1, right: 2 },
    margin: { top: 0, bottom: 1, left: 2, right: 0 },
    borderStyle: "round",
    borderColor: "cyan"
  }));
}

export function reviewBox(rows: Array<{ label: string; value: string; ok?: boolean }>): void {
  const lines = rows.map(r => {
    const icon = r.ok === false
      ? chalk.red("✗")
      : chalk.green("✓");
    return `${icon}  ${chalk.dim(r.label.padEnd(18))}${chalk.white(r.value)}`;
  });

  console.log(boxen(lines.join("\n"), {
    title: chalk.bold.cyan("  Configuration Review  "),
    titleAlignment: "center",
    padding: { top: 1, bottom: 1, left: 2, right: 4 },
    margin: { top: 1, bottom: 1, left: 2, right: 0 },
    borderStyle: "double",
    borderColor: "cyan"
  }));
}

export function successBox(title: string, lines: string[]): void {
  const content = lines.join("\n");
  console.log(boxen(content, {
    title: chalk.bold.green(`  ${title}  `),
    titleAlignment: "center",
    padding: { top: 1, bottom: 1, left: 2, right: 4 },
    margin: { top: 1, bottom: 0, left: 2, right: 0 },
    borderStyle: "round",
    borderColor: "green"
  }));
}

export function dashboardBox(title: string, cols: Array<{ label: string; value: string }>): void {
  const maxLabel = Math.max(...cols.map(c => c.label.length));
  const lines = cols.map(c =>
    `${chalk.dim(c.label.padEnd(maxLabel + 2))}${chalk.white(c.value)}`
  );
  console.log(boxen(lines.join("\n"), {
    title: chalk.bold.cyan(`  ${title}  `),
    titleAlignment: "center",
    padding: { top: 1, bottom: 1, left: 2, right: 4 },
    margin: { top: 0, bottom: 1, left: 2, right: 0 },
    borderStyle: "round",
    borderColor: "cyan"
  }));
}
