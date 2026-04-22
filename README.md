# job-search-agent

> AI-powered job search agent built on Claude. Set up once, run daily — searches the web for best-fit roles, tailors a resume and cover letter for each, researches salary ranges, preps answers to application questions, and auto-applies via Lever, Greenhouse, or Workday.

---

## What It Does

### Setup (run once, ~5 min)
1. Enter your Anthropic API key and choose a Claude model
2. Upload your resume (PDF, DOCX, TXT, or Markdown) or paste a Google Doc link
3. Claude suggests target job titles → you approve or edit
4. Claude suggests target company types → you approve or edit
5. Pick preferred locations (presets + custom, supports Remote)
6. Set preferences: roles per day, minimum base salary, email report opt-in
7. Enter contact info for auto-apply (email, phone, LinkedIn, work authorization)
8. Choose output: local folder or Google Drive
9. Optionally schedule automatic daily or weekly runs via cron

Re-running setup lands on a menu where you pick exactly which section to update — no need to re-enter everything.

### Agent (run daily or on cron)
1. Loads your resume and preferences
2. Searches the web for open roles matching your titles, company types, and **locations**
3. Filters results by your minimum base salary
4. Shortlists the top N roles by fit score (0–10)
5. Researches salary ranges for each role (from job postings or Claude's knowledge)
6. Checks each application form: cover letter required? Any extra questions?
7. Generates an **HTML jobs report** with role cards, salary badges, fit scores, and fit reasoning
8. Writes a tailored resume per role (reframes real experience, no invented facts)
9. Writes a cover letter per role when required or recommended
10. Drafts answers to any extra application questions (work samples, "why us", etc.)
11. Saves everything to a dated folder
12. Optionally emails the HTML report to you
13. Offers to auto-apply via ATS (Lever, Greenhouse, Workday)

### Status Dashboard
```bash
npm run status
```
SQLite-backed tracker. Shows all applications with fit score, current status, and lifetime stats (applied / interviewing / offers / response rate).

---

## Output Structure

```
job-search-output/
└── 2026-04-19/
    ├── jobs-report.html              ← styled HTML report with all roles
    ├── resume-1-anthropic.md         ← tailored resume (Markdown, Word, or Google Doc)
    ├── cover-1-anthropic.md          ← cover letter for role #1
    ├── answers-1-anthropic.md        ← answers to extra application questions
    ├── resume-2-openai.md
    ├── cover-2-openai.md
    └── ...
```

---

## Prerequisites

- **Node.js 18+** — [download](https://nodejs.org)
- **Anthropic API key** — [get one](https://console.anthropic.com/settings/keys)
- **Your resume** in PDF, DOCX, TXT, or MD format

> This agent uses the Anthropic API (separate from a claude.ai subscription). New accounts get $5 in free credits — enough for weeks of daily runs.

## Cost Estimate

Each daily run makes roughly 15–25 API calls (search, salary research, application research, N resumes, N cover letters, N answer sets, report). At current Sonnet pricing:

| Usage | Estimated Cost |
|---|---|
| Single run (5 roles) | ~$0.08–0.15 |
| Daily for a month | ~$2.50–4.50 |
| Free credit ($5) covers | ~35–60 runs |

Set a monthly spend limit in the [Anthropic Console](https://console.anthropic.com) to stay in control.

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/ramkrispnw/job-search-agent
cd job-search-agent

# 2. Install dependencies
npm install

# 3. Run interactive setup (~5 min)
npm run setup

# 4. Run the agent
npm run run
```

---

## Commands

| Command | What It Does |
|---|---|
| `npm run setup` | Interactive setup wizard (first time) or section editor (update mode) |
| `npm run run` | Run the full agent: search → score → tailor → apply |
| `npm run status` | View application tracker dashboard |
| `npm run resume` | Update your master resume only |
| `npm run cron` | Manage automatic scheduling (daily or weekly) |

---

## Setup Walkthrough

### Step 1 — Anthropic API Key
Stored locally at `~/.job-search-agent/config.json`. Verified with a live API call on entry.

### Step 2 — Claude Model
Choose between Sonnet (recommended), Opus (highest quality), or Haiku (fastest, lowest cost).

### Step 3 — Resume
Upload a local file (PDF, DOCX, TXT, MD) or paste a Google Doc URL. The parsed text is stored locally — Claude uses it as the base for all tailoring.

### Step 4 — Target Roles
Claude analyzes your resume and suggests 8 job titles. Accept, add to, or fully rewrite the list.

### Step 5 — Target Company Types
Claude suggests 6 company archetypes (e.g. "AI-native startups Series B–D"). Edit as needed.

### Step 6 — Preferred Locations
Multi-select from preset cities or add custom ones. Includes a Remote option. Only roles matching your locations are returned.

### Step 7 — Preferences
- **Roles per day** — how many roles the agent finds each run (1–10)
- **Minimum base salary** — roles below this are flagged with a warning badge
- **Email report** — opt in to receive the HTML report in your inbox after each run

### Step 8 — Contact Info
Used to fill application forms during auto-apply:
- Email, phone, LinkedIn URL
- **Work authorization** — are you legally authorized to work in the target country?
- **Visa sponsorship** — will you require sponsorship now or in the future?

These answers are used to auto-fill Greenhouse, Lever, and Workday dropdowns.

### Step 9 — Output
**Local folder** — choose a path (default: `~/job-search-output`)

**Google Drive** — requires OAuth 2.0 credentials:
1. [Google Cloud Console](https://console.cloud.google.com/) → Create project → Enable **Google Drive API**
2. Create OAuth credentials: APIs & Services → Credentials → OAuth client ID → Desktop app
3. Generate a refresh token via [OAuth Playground](https://developers.google.com/oauthplayground):
   - Settings → Use your own OAuth credentials
   - Scope: `https://www.googleapis.com/auth/drive.file`
   - Authorize → Exchange code → copy Refresh Token
4. Find your folder ID from the Drive URL: `.../folders/`**`FOLDER_ID`**

### Cron Scheduling
At the end of setup (or via `npm run cron`), optionally install an automatic schedule — daily or weekly, at a time you choose. In cron mode the agent runs fully, but skips the interactive apply step and queues applications for your next manual run.

---

## Updating Your Config

Re-running `npm run setup` on an existing config shows your current settings and a pick-list:

```
  API Key         sk-ant-...4f2a
  Model           claude-sonnet-4-6
  Resume          1,842 words
  Target Roles    Senior PMM, Director of PMM  +3 more
  Company Types   5 types
  Locations       Remote, San Francisco, CA
  Roles/Day       5  ·  Min base $180k
  ...

? What would you like to edit?
  ✅  Save and finish
  ──────────────────
    API key
    Model
    Resume
  ❯ Target roles
    Target company types
    Preferred locations
    Preferences  (roles/day, salary, email report)
    Contact info  (email, phone, LinkedIn, work auth)
    Email report settings
    Output settings
```

---

## ATS Auto-Apply

The agent can auto-apply to jobs hosted on:

| ATS | Support |
|---|---|
| **Greenhouse** | ✅ Full auto-apply · auto-reads email security code from Gmail |
| **Lever** | ✅ Full auto-apply |
| **Workday** | ✅ Full auto-apply (multi-step) |
| **Ashby** | 🔜 Coming soon |
| Other | ⚠️ Flagged for manual apply |

### Greenhouse email verification
Greenhouse sends a one-time security code to the applicant's email after form submission. If you've configured email reporting (Gmail app password in setup), the agent automatically reads the code from your inbox via IMAP and enters it — no manual action needed. If email isn't configured, it shows the job URL and asks you to complete it manually.

### Work authorization auto-fill
Greenhouse, Lever, and Workday forms often have required dropdowns for "Are you authorized to work?" and "Do you require sponsorship?". The agent fills these from your answers in the Contact Info setup step.

### Apply modes (interactive)
When running `npm run run`, you'll be prompted:
- **Auto-apply** — submits to all qualifying roles automatically
- **Confirm each one** — prompts you per role
- **Skip** — saves output, applies nothing

> In cron mode (non-interactive), the agent never auto-applies — it queues everything for your next manual run.

---

## Email Report

If enabled during setup, the agent emails you an HTML report after each run containing:
- Role cards with company, title, location, fit score
- Salary range badge (from job posting or estimated)
- Cover letter status badge (required / recommended / optional)
- Extra question count
- Direct application links

Requires a Gmail app password. Generate one at: myaccount.google.com → Security → App Passwords.

---

## Application Tracker

```bash
npm run status
```

```
  job-search-agent  tracker

  Total   Applied   Interviewing   Offers   Response Rate
  27      21        5              1        24%

  #   Company        Title                        Fit   Status         Applied
  ─────────────────────────────────────────────────────────────────────────────
  1   Anthropic      Product Marketing Lead        9     INTERVIEWING   Apr 12
  2   OpenAI         Senior PMM, Platform          8     APPLIED        Apr 13
  3   Together AI    Product Marketing Director    8     APPLIED        Apr 15
  ...
```

Update status interactively (applied → interviewing → offer / rejected).

---

## Privacy

- Resume and config stored **only** on your machine at `~/.job-search-agent/`
- Resume text is sent to Anthropic's API for processing ([Privacy Policy](https://www.anthropic.com/privacy))
- Google Drive users: files go to your own Drive folder via OAuth — no third-party access
- ATS auto-apply runs Puppeteer locally — your credentials never leave your machine
- Email reading (security code) connects to Gmail via IMAP using your own app password

---

## Tech Stack

| Component | Technology |
|---|---|
| AI / LLM | Claude (`claude-sonnet-4-6` default) |
| Job search | Claude built-in `web_search_20250305` tool |
| Resume parsing | `pdf-parse` + `mammoth` |
| ATS automation | Puppeteer |
| Email report | `nodemailer` (Gmail SMTP) |
| Email security code | `imapflow` (Gmail IMAP) |
| Application tracking | SQLite via `better-sqlite3` |
| Google Drive | Google Drive API v3 + OAuth2 |
| CLI prompts | `@inquirer/prompts` |
| Terminal UI | `chalk` + `ora` + `boxen` |

---

## Roadmap

- [ ] Ashby ATS support
- [ ] LinkedIn Easy Apply support
- [ ] Interview prep generator per role
- [ ] Salary negotiation coach (post-offer)
- [ ] Multi-resume profiles (IC track vs. manager track)

---

## Contributing

PRs welcome. Open an issue first for major changes.

To add a new ATS:
1. Add a detector pattern to `src/ats/detector.ts`
2. Create `src/ats/yourATS.ts` following the `lever.ts` pattern
3. Wire it into `src/ats/index.ts`

---

## License

MIT
