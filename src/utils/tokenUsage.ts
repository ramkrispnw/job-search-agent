// src/utils/tokenUsage.ts — global token usage accumulator for the current run

import chalk from "chalk";

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  calls: number;
}

// Pricing for claude-sonnet-4-x (per million tokens)
const PRICE = {
  input:      3.00,
  output:    15.00,
  cacheWrite: 3.75,
  cacheRead:  0.30,
};

const state: UsageSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  calls: 0,
};

// Snapshot at the start of the last role — lets us print per-role delta
let roleCheckpoint: UsageSnapshot = { ...state };

/**
 * Call this right after every client.messages.create() response.
 * response.usage may be undefined on some error paths — guard accordingly.
 */
export function trackTokens(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
} | undefined | null): void {
  if (!usage) return;
  state.inputTokens      += usage.input_tokens      ?? 0;
  state.outputTokens     += usage.output_tokens     ?? 0;
  state.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
  state.cacheReadTokens  += usage.cache_read_input_tokens  ?? 0;
  state.calls            += 1;
}

/** Save current totals so the next call to roleDelta() returns the diff. */
export function markRoleStart(): void {
  roleCheckpoint = { ...state };
}

/** Return token usage since the last markRoleStart(). */
export function roleDelta(): UsageSnapshot {
  return {
    inputTokens:      state.inputTokens      - roleCheckpoint.inputTokens,
    outputTokens:     state.outputTokens     - roleCheckpoint.outputTokens,
    cacheWriteTokens: state.cacheWriteTokens - roleCheckpoint.cacheWriteTokens,
    cacheReadTokens:  state.cacheReadTokens  - roleCheckpoint.cacheReadTokens,
    calls:            state.calls            - roleCheckpoint.calls,
  };
}

/** Return the full run totals. */
export function totals(): UsageSnapshot {
  return { ...state };
}

/** Estimate cost in USD for a usage snapshot. */
export function estimateCost(snap: UsageSnapshot): number {
  return (
    (snap.inputTokens      / 1_000_000) * PRICE.input +
    (snap.outputTokens     / 1_000_000) * PRICE.output +
    (snap.cacheWriteTokens / 1_000_000) * PRICE.cacheWrite +
    (snap.cacheReadTokens  / 1_000_000) * PRICE.cacheRead
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One-line summary string for a snapshot. */
export function formatUsage(snap: UsageSnapshot, label?: string): string {
  const cost = estimateCost(snap);
  const parts = [
    chalk.dim("in")     + " " + chalk.white(fmt(snap.inputTokens)),
    chalk.dim("out")    + " " + chalk.white(fmt(snap.outputTokens)),
  ];
  if (snap.cacheReadTokens > 0) {
    parts.push(chalk.dim("cached") + " " + chalk.green(fmt(snap.cacheReadTokens)));
  }
  parts.push(chalk.dim("≈") + " " + chalk.yellow(`$${cost.toFixed(3)}`));
  const prefix = label ? chalk.dim(`${label}  `) : "";
  return prefix + parts.join(chalk.dim("  ·  "));
}

/** Print the grand total as a formatted summary line. */
export function printTotalSummary(): void {
  const snap = totals();
  const cost = estimateCost(snap);
  const saved = (snap.cacheReadTokens / 1_000_000) * (PRICE.input - PRICE.cacheRead);
  console.log(
    "\n  " + chalk.bold("Token usage") + "  " +
    chalk.dim("calls") + " " + chalk.white(String(snap.calls)) + "  ·  " +
    chalk.dim("in") + " " + chalk.white(fmt(snap.inputTokens)) + "  ·  " +
    chalk.dim("out") + " " + chalk.white(fmt(snap.outputTokens)) +
    (snap.cacheReadTokens > 0
      ? "  ·  " + chalk.dim("cached") + " " + chalk.green(fmt(snap.cacheReadTokens)) +
        " " + chalk.dim(`(saved ~$${saved.toFixed(3)})`)
      : "") +
    "  ·  " + chalk.bold.yellow(`est $${cost.toFixed(3)}`)
  );
}
