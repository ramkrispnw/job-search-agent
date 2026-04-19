// src/ats/greenhouse.ts — auto-apply to Greenhouse job postings

export interface ApplyPayload {
  name: string;
  email: string;
  phone?: string;
  resumePath: string;
  coverLetter?: string;
  linkedinUrl?: string;
}

export interface ApplyResult {
  success: boolean;
  url: string;
  error?: string;
  screenshotPath?: string;
  needsEmailVerification?: boolean;
}

// Greenhouse has two form variants: boards.greenhouse.io (older) and job-boards.greenhouse.io (newer)
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
  const filled: boolean = await page.evaluate((val: string) => {
    const labels = Array.from(document.querySelectorAll("label"));
    for (const label of labels) {
      if (/linkedin/i.test(label.textContent ?? "")) {
        const forId = label.getAttribute("for");
        const input: HTMLInputElement | null = forId
          ? document.getElementById(forId) as HTMLInputElement
          : label.querySelector("input");
        if (input && !input.value) {
          input.focus();
          input.value = val;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }
    }
    return false;
  }, value);
  return filled;
}

// Auto-answer common yes/no select/radio questions about work authorization
async function fillWorkAuthQuestions(page: any): Promise<void> {
  await page.evaluate(() => {
    // Handle <select> dropdowns
    const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
    for (const sel of selects) {
      const label = document.querySelector(`label[for='${sel.id}']`)?.textContent?.toLowerCase() ?? "";
      const options = Array.from(sel.options).map(o => o.text.toLowerCase());

      let targetValue: string | null = null;

      if (/authorized|legally.*work|eligible.*work/i.test(label)) {
        // Pick "Yes" option
        const yes = Array.from(sel.options).find(o => /^yes$/i.test(o.text.trim()));
        if (yes) targetValue = yes.value;
      } else if (/sponsor|visa.*sponsor|require.*sponsor/i.test(label)) {
        // Pick "No" option (don't require sponsorship)
        const no = Array.from(sel.options).find(o => /^no$/i.test(o.text.trim()));
        if (no) targetValue = no.value;
      }

      if (targetValue !== null && sel.value !== targetValue) {
        sel.value = targetValue;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    // Handle radio button groups
    const fieldsets = Array.from(document.querySelectorAll("fieldset"));
    for (const fs of fieldsets) {
      const legend = fs.querySelector("legend")?.textContent?.toLowerCase() ?? "";
      const radios = Array.from(fs.querySelectorAll("input[type='radio']")) as HTMLInputElement[];
      if (radios.length === 0) continue;

      let targetLabel: RegExp | null = null;
      if (/authorized|legally.*work|eligible.*work/i.test(legend)) {
        targetLabel = /^yes$/i;
      } else if (/sponsor|visa.*sponsor|require.*sponsor/i.test(legend)) {
        targetLabel = /^no$/i;
      }

      if (targetLabel) {
        for (const radio of radios) {
          const rLabel = document.querySelector(`label[for='${radio.id}']`)?.textContent?.trim() ?? radio.value;
          if (targetLabel.test(rLabel) && !radio.checked) {
            radio.click();
            break;
          }
        }
      }
    }
  });
}

// Detect if we're on the email security code page
async function isSecurityCodePage(page: any): Promise<boolean> {
  const hasCodeInput = await page.$(SELECTORS.securityCode.join(", ")) !== null;
  if (hasCodeInput) return true;

  const text: string = await page.evaluate(() => (document as any).body.innerText);
  return /security code|verification code|copy and paste this code|enter.*code.*email/i.test(text);
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
    const lastName = rest.join(" ") || "";
    await fillField(page, SELECTORS.firstName, firstName);
    await fillField(page, SELECTORS.lastName, lastName);

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
      const allFileInputs = await page.$$("input[type='file']");
      if (allFileInputs.length > 0) resumeInput = allFileInputs[0];
    }
    if (!resumeInput) throw new Error("Could not find resume upload field");
    await resumeInput.uploadFile(payload.resumePath);
    await sleep(2000);

    // Cover letter
    if (payload.coverLetter) {
      await fillField(page, SELECTORS.coverLetter, payload.coverLetter.slice(0, 5000));
    }

    // LinkedIn — try selectors first, then label-based fallback
    if (payload.linkedinUrl) {
      const filled = await fillField(page, SELECTORS.linkedin, payload.linkedinUrl);
      if (!filled) await fillLinkedinByLabel(page, payload.linkedinUrl);
    }

    // Auto-answer work authorization / sponsorship dropdowns + radios
    await fillWorkAuthQuestions(page);

    await sleep(500);

    // Submit
    const submitBtn = await page.$(SELECTORS.submit.join(", "));
    if (!submitBtn) throw new Error("Could not find Submit button");
    await submitBtn.click();

    // Wait for navigation or in-page confirmation
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 25000 }),
      page.waitForSelector(
        "[data-qa='application-confirmation'], .application-confirmation, #confirmation, .confirmation",
        { timeout: 25000 }
      )
    ]).catch(() => {});
    await sleep(1500);

    const screenshotPath = `/tmp/greenhouse-apply-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const finalUrl = page.url();
    const pageText: string = await page.evaluate(() => (document as any).body.innerText);
    const textLower = pageText.toLowerCase();

    // Check for email security code challenge (Greenhouse anti-bot)
    if (await isSecurityCodePage(page)) {
      return {
        success: false,
        url: finalUrl,
        needsEmailVerification: true,
        screenshotPath,
        error: `Greenhouse sent a security code to ${payload.email} — open that email and complete the application manually at: ${jobUrl}`
      };
    }

    const succeeded =
      textLower.includes("thank") ||
      textLower.includes("application submitted") ||
      textLower.includes("application received") ||
      textLower.includes("successfully submitted") ||
      textLower.includes("we've received your application") ||
      textLower.includes("your application has been") ||
      textLower.includes("we received your application") ||
      finalUrl.includes("/confirmation") ||
      finalUrl.includes("/submitted") ||
      finalUrl.includes("/success");

    if (!succeeded) {
      const errorText: string = await page.evaluate(() => {
        const errs = Array.from(document.querySelectorAll(
          ".error, .field-error, [class*='error'], [aria-invalid='true'] ~ *, .invalid-feedback"
        ));
        return errs.map((e: any) => e.textContent?.trim()).filter(Boolean).slice(0, 3).join("; ");
      });
      const hint = errorText ? ` Validation errors: ${errorText}` : "";
      throw new Error(`Could not confirm Greenhouse submission.${hint} Screenshot: ${screenshotPath}`);
    }

    return { success: true, url: finalUrl, screenshotPath };

  } catch (err: any) {
    return { success: false, url: jobUrl, error: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
