// src/utils/cronManager.ts — shared cron install/remove logic

import { execSync } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs-extra";

export const PROJECT_DIR = path.resolve(__dirname, "../../");
export const LOG_FILE    = path.join(os.homedir(), "logs", "job-search-agent.log");

export type CronFrequency = "daily" | "weekly";

export interface CronSchedule {
  frequency: CronFrequency;
  hour: number;
  minute: number;
  weekday?: number;  // 0=Sun, 1=Mon … 6=Sat (only for weekly)
}

export const WEEKDAYS = [
  { name: "Monday",    value: 1 },
  { name: "Tuesday",   value: 2 },
  { name: "Wednesday", value: 3 },
  { name: "Thursday",  value: 4 },
  { name: "Friday",    value: 5 },
  { name: "Saturday",  value: 6 },
  { name: "Sunday",    value: 0 },
];

export function buildCronLine(schedule: CronSchedule): string {
  const nodebin = process.execPath;
  const cmd = `cd ${PROJECT_DIR} && ${nodebin} node_modules/.bin/ts-node src/agent/index.ts >> ${LOG_FILE} 2>&1`;
  const { hour, minute, frequency, weekday } = schedule;
  const dow = frequency === "weekly" ? String(weekday ?? 1) : "*";
  return `${minute} ${hour} * * ${dow} ${cmd}`;
}

export function describeSchedule(schedule: CronSchedule): string {
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.frequency === "daily") return `every day at ${time}`;
  const day = WEEKDAYS.find(d => d.value === schedule.weekday)?.name ?? "Monday";
  return `every ${day} at ${time}`;
}

export function getCurrentCrontab(): string {
  try { return execSync("crontab -l 2>/dev/null").toString(); } catch { return ""; }
}

export function hasExistingCronJob(): boolean {
  return getCurrentCrontab().includes("job-search-agent");
}

export function installCronJob(schedule: CronSchedule): void {
  fs.ensureDirSync(path.dirname(LOG_FILE));
  const existing = getCurrentCrontab();
  const cleaned = existing
    .split("\n")
    .filter(l => !l.includes("job-search-agent"))
    .join("\n")
    .trim();
  const newCrontab = (cleaned ? cleaned + "\n" : "") + buildCronLine(schedule) + "\n";
  const tmp = `/tmp/crontab-${Date.now()}.txt`;
  fs.writeFileSync(tmp, newCrontab);
  execSync(`crontab ${tmp}`);
  fs.unlinkSync(tmp);
}

export function removeCronJob(): void {
  const existing = getCurrentCrontab();
  const cleaned = existing
    .split("\n")
    .filter(l => !l.includes("job-search-agent"))
    .join("\n")
    .trim();
  const tmp = `/tmp/crontab-${Date.now()}.txt`;
  fs.writeFileSync(tmp, cleaned + "\n");
  execSync(`crontab ${tmp}`);
  fs.unlinkSync(tmp);
}
