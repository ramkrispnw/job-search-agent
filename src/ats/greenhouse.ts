// src/ats/greenhouse.ts — auto-apply to Greenhouse job postings

import { readGreenhouseSecurityCode } from "../utils/emailReader";

export interface ApplyPayload {
  name: string;
  email: string;
  phone?: string;
  resumePath: string;
  coverLetter?: string;
  linkedinUrl?: string;
  workAuthorized?: boolean;      // from config.applicantInfo
  requiresSponsorship?: boolean; // from config.applicantInfo
  emailCredentials?: { smtpUser: string; smtpPass: string };
}

export interface ApplyResult {
  success: boolean;
  url: string;
  error?: string;
  screenshotPath?: string;
  needsEmailVerification?: boolean;
}

const SELECTORS = {
  firstName: ["#first_name", "input[name='first_name']", "input[autocomplete='given-name']"],
  lastName:  ["#last_name",  "input[name='last_name']",  "input[autocomplete='family-name']"],
  email:     ["#email",      "input[name='email']",       "input[type='email']"],
  phone:     ["#phone",      "input[name='phone']",       "input[type='tel']"],
  resume: [
    "input[data-qa='resume-upload-input']",
    "input[type='file'][name='resume']",
    "input[type='file'][id='resume']",
    "input[type='file'][accept*='pdf']",
    "input[type='file']"
  ],
  coverLetter: [
    "textarea#cover_letter",
    "textarea[name='cover_letter']",
    "textarea[data-qa='cover_letter']"
  ],
  linkedin: [
    "input[data-qa='input-linkedin']",
    "input[id*='linkedin']",
    "input[name*='linkedin']",
    "input[placeholder*='LinkedIn']",
    "input[placeholder*='linkedin']",
    "input[type='url'][id*='linkedin']",
    "input[aria-label*='LinkedIn']"
  ],
  submit: [
    "input[type='submit'][id='submit_app']",
    "button[type='submit'][data-qa='btn-submit']",
    "button[type='submit']",
    "input[type='submit']"
  ],
  securityCode: [
    "input[name='security_code']",
    "input[id*='security']",
    "input[placeholder*='security']",
    "input[placeholder*='code']",
    "input[aria-label*='security']",
    "input[aria-label*='code']"
  ]
};

async function fillField(page: any, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(value);
      return true;
    }
  }
  return false;
}

async function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

// Fill LinkedIn by label-matching (fallback for unusual DOM structures)
async function fillLinkedinByLabel(page: any, value: string): Promise<boolean> {
  return page.evaluate((val: string) => {
    for (const label of Array.from(document.querySelectorAll("label"))) {
      if (!/linkedin/i.test(label.textContent ?? "")) continue;
      const forId = label.getAttribute("for");
      const input = (forId ? document.getElementById(forId) : label.querySelector("input")) as HTMLInputElement | null;
      if (input && !input.value) {
        input.focus();
        input.value = val;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, value);
}

// Fill work authorization selects/radios using the user's configured answers
async function fillWorkAuthQuestions(page: any, workAuthorized: boolean, requiresSponsorship: boolean): Promise<void> {
  await page.evaluate((authorized: boolean, needsSponsorship: boolean) => {
    function pickOption(sel: HTMLSelectElement, prefer: RegExp) {
      const match = Array.from(sel.options).find(o => prefer.test(o.text.trim()));
      if (match && sel.value !== match.value) {
        sel.value = match.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    function clickRadio(fs: Element, prefer: RegExp) {
      const radios = Array.from(fs.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
      for (const r of radios) {
        const label = document.querySelector(`label[for='${r.id}']`)?.textContent?.trim() ?? r.value;
        if (prefer.test(label) && !r.checked) { r.click(); break; }
      }
    }

    // Selects
    for (const sel of Array.from(document.querySelectorAll("select")) as HTMLSelectElement[]) {
      const labelText = document.querySelector(`label[for='${sel.id}']`)?.textContent?.toLowerCase() ?? "";
      if (/authorized|legally.*work|eligible.*work/i.test(labelText)) {
        pickOption(sel, authorized ? /^yes$/i : /^no$/i);
      } else if (/sponsor|visa.*sponsor|require.*sponsor/i.test(labelText)) {
        pickOption(sel, needsSponsorship ? /^yes$/i : /^no$/i);
      }
    }

    // Radio groups
    for (const fs of Array.from(document.querySelectorAll("fieldset"))) {
      const legend = fs.querySelector("legend")?.textContent?.toLowerCase() ?? "";
      if (/authorized|legally.*work|eligible.*work/i.test(legend)) {
        clickRadio(fs, authorized ? /^yes$/i : /^no$/i);
      } else if (/sponsor|visa.*sponsor|require.*sponsor/i.test(legend)) {
        clickRadio(fs, needsSponsorship ? /^yes$/i : /^no$/i);
      }
    }
  }, workAuthorized, requiresSponsorship);
}

async function isSecurityCodePage(page: any): Promise<boolean> {
  const hasInput = await page.$(SELECTORS.securityCode.join(", ")) !== null;
  if (hasInput) return true;
  const text: string = await page.evaluate(() => (document as any).body.innerText);
  return /security code|verification code|copy and paste this code|enter.*code.*email/i.test(text);
}

async function submitAndWait(page: any): Promise<void> {
  const btn = await page.$(SELECTORS.submit.join(", "));
  if (!btn) throw new Error("Could not find Submit button");
  await btn.click();
  await Promise.race([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }),
    page.waitForSelector(
      "[data-qa='application-confirmation'], .application-confirmation, #confirmation, .confirmation",
      { timeout: 25000 }
    )
  ]).catch(() => {});
  await sleep(1500);
}

function isConfirmed(pageText: string, url: string): boolean {
  const t = pageText.toLowerCase();
  return (
    t.includes("thank") ||
    t.includes("application submitted") ||
    t.includes("application received") ||
    t.includes("successfully submitted") ||
    t.includes("we've received your application") ||
    t.includes("your application has been") ||
    t.includes("we received your application") ||
    url.includes("/confirmation") ||
    url.includes("/submitted") ||
    url.includes("/success")
  );
}

export async function applyGreenhouse(
  jobUrl: string,
  payload: ApplyPayload,
  headless = true
): Promise<ApplyResult> {
  let browser: any;
  try {
    const puppeteer = await import("puppeteer");
    browser = await puppeteer.default.launch({
      headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector("form, #application-form, [data-qa='application-form']", { timeout: 15000 }).catch(() => {});
    await sleep(1500);

    // Name
    const [firstName, ...rest] = payload.name.split(" ");
    await fillField(page, SELECTORS.firstName, firstName);
    await fillField(page, SELECTORS.lastName, rest.join(" ") || "");

    // Email + Phone
    await fillField(page, SELECTORS.email, payload.email);
    if (payload.phone) await fillField(page, SELECTORS.phone, payload.phone);

    // Resume upload
    let resumeInput: any = null;
    for (const sel of SELECTORS.resume) {
      resumeInput = await page.$(sel);
      if (resumeInput) break;
    }
    if (!resumeInput) {
      const all = await page.$$("input[type='file']");
      if (all.length > 0) resumeInput = all[0];
    }
    if (!resumeInput) throw new Error("Could not find resume upload field");
    await resumeInput.uploadFile(payload.resumePath);
    await sleep(2000);

    // Cover letter
    if (payload.coverLetter) {
      await fillField(page, SELECTORS.coverLetter, payload.coverLetter.slice(0, 5000));
    }

    // LinkedIn
    if (payload.linkedinUrl) {
      const filled = await fillField(page, SELECTORS.linkedin, payload.linkedinUrl);
      if (!filled) await fillLinkedinByLabel(page, payload.linkedinUrl);
    }

    // Work authorization (using user's confirmed answers from setup)
    const authorized = payload.workAuthorized ?? true;
    const sponsorship = payload.requiresSponsorship ?? false;
    await fillWorkAuthQuestions(page, authorized, sponsorship);

    await sleep(500);

    // First submit
    await submitAndWait(page);

    // Screenshot after first submit
    const screenshotPath = `/tmp/greenhouse-apply-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    let finalUrl = page.url();
    let pageText: string = await page.evaluate(() => (document as any).body.innerText);

    if (isConfirmed(pageText, finalUrl)) {
      return { success: true, url: finalUrl, screenshotPath };
    }

    // Check for security code challenge
    if (await isSecurityCodePage(page)) {
      if (payload.emailCredentials) {
        // Try to read the code from Gmail
        process.stdout.write("  [Greenhouse] Security code required — checking inbox");
        const code = await readGreenhouseSecurityCode(payload.emailCredentials, 45000);

        if (code) {
          process.stdout.write(` → code found: ${code}\n`);
          const codeInput = await page.$(SELECTORS.securityCode.join(", "));
          if (codeInput) {
            await codeInput.click({ clickCount: 3 });
            await codeInput.type(code);
            await sleep(500);
            await submitAndWait(page);

            finalUrl = page.url();
            pageText = await page.evaluate(() => (document as any).body.innerText);
            await page.screenshot({ path: screenshotPath, fullPage: true });

            if (isConfirmed(pageText, finalUrl)) {
              return { success: true, url: finalUrl, screenshotPath };
            }
          }
        } else {
          process.stdout.write(" → not found within timeout\n");
        }
      }

      // Fall back: tell user to check inbox
      return {
        success: false,
        url: finalUrl,
        needsEmailVerification: true,
        screenshotPath,
        error: `Greenhouse sent a security code to ${payload.email} — check your inbox and complete at: ${jobUrl}`
      };
    }

    // Generic failure
    const errorText: string = await page.evaluate(() => {
      const errs = Array.from(document.querySelectorAll(
        ".error, .field-error, [class*='error'], [aria-invalid='true'] ~ *, .invalid-feedback"
      ));
      return errs.map((e: any) => e.textContent?.trim()).filter(Boolean).slice(0, 3).join("; ");
    });
    const hint = errorText ? ` Validation errors: ${errorText}` : "";
    throw new Error(`Could not confirm Greenhouse submission.${hint} Screenshot: ${screenshotPath}`);

  } catch (err: any) {
    return { success: false, url: jobUrl, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
