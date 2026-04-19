# job-search-agent 🔍

> AI-powered job search agent built on Claude. Set up once, run daily — searches the web for best-fit roles, shortlists 5, writes a tailored resume and cover letter for each, researches salary ranges, and auto-applies via Lever, Greenhouse, or Workday.

---

## What It Does

### Setup (run once, ~5 min)
1. Upload your resume (PDF, DOCX, or Markdown)
2. Claude reads it and suggests target roles → you approve/edit
3. Claude suggests target company types → you approve/edit
4. Choose output destination: local folder or Google Drive

### Agent (run daily or on cron)
1. Loads your resume from config
2. Searches the web for open roles matching your profile
3. Shortlists the top 5 by fit score (0–10)
4. Researches salary ranges via Levels.fyi, Glassdoor, job postings
5. Generates a jobs report with role descriptions, fit reasoning, and comp data
6. Writes a tailored resume per role (no invented facts — reframes real experience)
7. Writes a tailored cover letter per role (~250 words, company-specific)
8. Saves everything to a dated folder (`job-search-2025-04-19/`)
9. Offers to auto-apply via ATS (Lever, Greenhouse, Workday)

### Status Dashboard
- SQLite-backed application tracker
- Tracks: queued → applied → interviewing → offer/rejected
- Shows lifetime response rate

---

## Output Structure

```
job-search-output/
└── job-search-2026-04-19/
    ├── jobs-report.md                   ← ranked roles, fit scores, salary bands
    ├── resume-1-anthropic.docx          ← tailored resume (Word) or .md (Markdown)
    ├── cover-1-anthropic.md             ← cover letter for role #1
    ├── resume-2-openai.docx
    ├── cover-2-openai.md
    ├── resume-3-figma.docx
    ├── cover-3-figma.md
    ├── resume-4-notion.docx
    ├── cover-4-notion.md
    ├── resume-5-linear.docx
    └── cover-5-linear.md
```
*(Google Drive users choosing "Google Doc" will see native Google Docs instead of .docx files)*

---

## Prerequisites

- **Node.js 18+** — [download](https://nodejs.org)
- **Anthropic API key** — [get one](https://console.anthropic.com/settings/keys) (Claude Pro or API credits)
- **Your resume** in PDF, DOCX, TXT, or MD format

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/yourusername/job-search-agent
cd job-search-agent

# 2. Install
npm install

# 3. Set up contact info for ATS auto-apply
cp .env.example .env
# Edit .env with your email, phone, LinkedIn URL

# 4. Run interactive setup (5 min)
npm run setup

# 5. Run the agent
npm run run
```

---

## Commands

| Command | What It Does |
|---|---|
| `npm run setup` | Interactive setup wizard (resume, roles, companies, output) |
| `npm run run` | Run the full agent (search → tailor → apply) |
| `npm run status` | View application tracker dashboard |
| `npm run cron` | Install a daily cron job (Mac/Linux) |

---

## Setup Walkthrough

### Step 0 — Anthropic API Key
Stored locally at `~/.job-search-agent/config.json`. Never sent anywhere except the Anthropic API.

Get a key at: https://console.anthropic.com/settings/keys

### Step 1 — Resume Upload
Provide a path to your resume file. Supported: `.pdf`, `.docx`, `.txt`, `.md`

A local copy is saved to `~/.job-search-agent/resume.<ext>`.

### Step 2 — Target Roles
Claude analyzes your resume and suggests 8 job titles. You can accept, add to, or fully edit the list.

### Step 3 — Target Company Types
Claude suggests 6 company archetypes (e.g. "AI-native startups Series B–D", "FAANG AI teams"). Edit as needed.

### Step 4 — Output Destination & Resume Format

You'll be asked where to save output **and** what format tailored resumes should be saved in.

**Resume format options:**
- **Google Doc** *(Google Drive only)* — opens natively in Google Docs, easy to edit and share
- **Word Document (.docx)** — standard format, works with any word processor
- **Markdown (.md)** — plain text, version-control friendly

All resumes are generated with ATS-compliant formatting: standard section headers, no tables or columns, consistent date formats, and keyword-mirrored language.

**Option A: Local folder**
```
Output path: ~/job-search-output
```

**Option B: Google Drive**

You'll need OAuth 2.0 credentials. The setup wizard walks you through it step-by-step, but here's the summary:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project → Enable **Google Drive API**
   - APIs & Services → Enable APIs → Search "Google Drive API" → Enable
3. Create OAuth 2.0 credentials:
   - APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Desktop app**
   - Copy the Client ID and Client Secret
4. Generate a refresh token via [OAuth Playground](https://developers.google.com/oauthplayground):
   - Settings → Use your own OAuth credentials → enter Client ID + Secret
   - Scope: `https://www.googleapis.com/auth/drive.file`
   - Authorize → Exchange code → copy Refresh Token
5. Find your folder ID from the Drive URL:
   `https://drive.google.com/drive/folders/`**`THIS_IS_THE_FOLDER_ID`**

---

## ATS Auto-Apply

The agent can auto-apply to jobs hosted on:

| ATS | Support |
|---|---|
| **Lever** | ✅ Full auto-apply |
| **Greenhouse** | ✅ Full auto-apply |
| **Workday** | ✅ Full auto-apply (multi-step) |
| **Ashby** | 🔜 Coming soon |
| Other | ⚠️ Flagged for manual apply |

### Setup for auto-apply

```bash
cp .env.example .env
```

Edit `.env`:
```env
APPLICANT_EMAIL=you@example.com
APPLICANT_PHONE=+1-206-555-0100
APPLICANT_LINKEDIN=https://www.linkedin.com/in/yourprofile
```

When running `npm run run`, you'll be prompted:
- **Auto-apply** — applies to all qualifying roles (score ≥ 8) automatically
- **Manual confirm** — prompts you for each role individually
- **Skip** — saves output but doesn't apply

> **Safety note:** The agent never applies without your explicit confirmation in the session. In cron mode (non-interactive), it queues jobs for review and does not auto-apply.

---

## Daily Cron Setup

```bash
npm run cron
```

Interactive prompts let you choose the time (e.g. 8:00 AM). The wizard installs a crontab entry automatically.

In cron mode, the agent:
- Searches and scores jobs
- Generates all output files
- Queues applications for manual review (no auto-apply without your approval)
- Logs to `~/logs/job-search-agent.log`

```bash
# Monitor live
tail -f ~/logs/job-search-agent.log
```

---

## Application Tracker

```bash
npm run status
```

Shows a dashboard of all tracked applications:

```
  Totals: 23 tracked  ·  18 applied  ·  4 interviewing  ·  1 offer  ·  22% response rate

  #   Company                 Title                           Fit   Status          Applied   Response
  ──────────────────────────────────────────────────────────────────────────────────────────────────
  1   Anthropic               Product Marketing Lead - Agents 9     INTERVIEWING    Apr 12    Apr 15
  2   OpenAI                  Senior PMM, Platform            8     APPLIED         Apr 12    —
  3   Figma                   Head of PMM                     8     APPLIED         Apr 13    —
  ...
```

Update status interactively (applied → interviewing → offer/rejected).

---

## Configuration

Config stored at `~/.job-search-agent/config.json`. Edit directly or re-run `npm run setup`.

```json
{
  "version": "2.0.0",
  "resume": {
    "originalPath": "~/.job-search-agent/resume.pdf",
    "parsedText": "...",
    "lastUpdated": "2025-04-19T08:00:00Z"
  },
  "targetRoles": [
    "Senior Product Marketing Manager",
    "Director of Product Marketing"
  ],
  "targetCompanyTypes": [
    "AI-native startups Series B-D",
    "FAANG AI teams"
  ],
  "output": {
    "mode": "local",
    "localPath": "~/job-search-output"
  }
}
```

---

## Privacy

- Resume and config stored **only** on your machine at `~/.job-search-agent/`
- Resume text sent to Anthropic API for processing ([Anthropic Privacy Policy](https://www.anthropic.com/privacy))
- If using Google Drive output, files go to your own Drive via OAuth
- ATS apply uses Puppeteer locally — your credentials never leave your machine
- No data sent to any third party

---

## Tech Stack

| Component | Technology |
|---|---|
| AI / LLM | Claude Sonnet (`claude-sonnet-4-20250514`) |
| Job search | Claude built-in web search tool |
| Resume parsing | `pdf-parse` + `mammoth` |
| ATS automation | Puppeteer |
| Application tracking | SQLite via `better-sqlite3` |
| Google Drive | Google Drive API v3 + OAuth2 |
| CLI prompts | `@inquirer/prompts` |
| Resume output | Google Doc, Word (.docx), or Markdown |

---

## Roadmap

- [ ] Ashby ATS support
- [ ] Email digest after each run (via SendGrid or nodemailer)
- [ ] Slack notification integration
- [ ] Salary negotiation coach (post-offer)
- [ ] Interview prep generator per role
- [ ] LinkedIn Easy Apply support
- [ ] Multi-resume profile support (e.g. IC vs. manager track)

---

## Contributing

PRs welcome. Please open an issue first for major changes.

To add a new ATS:
1. Add detector pattern to `src/ats/detector.ts`
2. Create `src/ats/yourATS.ts` following the `lever.ts` pattern
3. Wire into `src/ats/index.ts`

---

## License

MIT
