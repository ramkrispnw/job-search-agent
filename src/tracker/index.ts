// src/tracker/index.ts — SQLite-based application tracker

import * as path from "path";
import { CONFIG_DIR } from "../config/types";

const DB_PATH = path.join(CONFIG_DIR, "applications.db");

// Lazy-load better-sqlite3 so it doesn't break if not installed
function getDb() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id      TEXT NOT NULL UNIQUE,
      title       TEXT NOT NULL,
      company     TEXT NOT NULL,
      location    TEXT,
      url         TEXT,
      status      TEXT NOT NULL DEFAULT 'queued',
      alignment   INTEGER,
      applied_at  TEXT,
      response_at TEXT,
      notes       TEXT,
      output_dir  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_runs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date   TEXT NOT NULL,
      jobs_found INTEGER,
      applied    INTEGER,
      queued     INTEGER,
      output_dir TEXT,
      ran_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

export type AppStatus =
  | "queued"       // found, not yet applied
  | "applied"      // submitted
  | "interviewing" // got a response
  | "rejected"
  | "offer"
  | "skipped";     // user manually skipped

export interface Application {
  id?: number;
  job_id: string;
  title: string;
  company: string;
  location?: string;
  url?: string;
  status: AppStatus;
  alignment?: number;
  applied_at?: string;
  response_at?: string;
  notes?: string;
  output_dir?: string;
}

export function upsertApplication(app: Application): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO applications (job_id, title, company, location, url, status, alignment, output_dir)
    VALUES (@job_id, @title, @company, @location, @url, @status, @alignment, @output_dir)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      output_dir = excluded.output_dir
  `).run({ output_dir: null, ...app });
}

export function markApplied(jobId: string, notes?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE applications
    SET status = 'applied', applied_at = datetime('now'), notes = @notes
    WHERE job_id = @job_id
  `).run({ job_id: jobId, notes: notes ?? null });
}

export function markStatus(jobId: string, status: AppStatus, notes?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE applications
    SET status = @status,
        response_at = CASE WHEN @status IN ('interviewing','rejected','offer')
                     THEN datetime('now') ELSE response_at END,
        notes = @notes
    WHERE job_id = @job_id
  `).run({ job_id: jobId, status, notes: notes ?? null });
}

export function getAll(): Application[] {
  return getDb().prepare(`SELECT * FROM applications ORDER BY created_at DESC`).all() as Application[];
}

export function getPending(): Application[] {
  return getDb()
    .prepare(`SELECT * FROM applications WHERE status = 'queued' ORDER BY alignment DESC`)
    .all() as Application[];
}

export function logRun(data: {
  run_date: string;
  jobs_found: number;
  applied: number;
  queued: number;
  output_dir: string;
}): void {
  getDb().prepare(`
    INSERT INTO daily_runs (run_date, jobs_found, applied, queued, output_dir)
    VALUES (@run_date, @jobs_found, @applied, @queued, @output_dir)
  `).run(data);
}

export function getStats(): {
  total: number;
  applied: number;
  interviewing: number;
  offers: number;
  responseRate: string;
} {
  const db = getDb();
  const total     = (db.prepare(`SELECT COUNT(*) as n FROM applications WHERE status != 'skipped'`).get() as any).n;
  const applied   = (db.prepare(`SELECT COUNT(*) as n FROM applications WHERE status IN ('applied','interviewing','rejected','offer')`).get() as any).n;
  const interviewing = (db.prepare(`SELECT COUNT(*) as n FROM applications WHERE status = 'interviewing'`).get() as any).n;
  const offers    = (db.prepare(`SELECT COUNT(*) as n FROM applications WHERE status = 'offer'`).get() as any).n;
  const responseRate = applied > 0 ? `${Math.round((interviewing / applied) * 100)}%` : "N/A";
  return { total, applied, interviewing, offers, responseRate };
}
