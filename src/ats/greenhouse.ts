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
}

// Selectors to try for each field — Greenhouse has two form variants:
// boards.greenhouse.io (older) and job-boards.greenhouse.io (newer)
const SELECTORS = {
  firstName: ["#first_name", "input[name='first_name']", "input[autocomplete='given-name']"],
  lastName:  ["#last_name",  "input[name='last_name']",  "input[autocomplete='family-name']"],
  email:     ["#email",      "input[name='email']",       "input[type='email']"],
  phone:     ["#phone",      "input[name='phone']",       "input[type='tel']"],
  resume:    [
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
    "input[placeholder*='LinkedIn']",
    "input[id*='linkedin']",
    "input[name*='linkedin']"
  ],
  submit: [
    "input[type='submit'][id='submit_app']",
    "button[type='submit'][data-qa='btn-submit']",
    "button[type='submit']",
    "input[type='submit']"
  ]
};

async function tryClick(page: any, selectors: string[]): Promise<any> {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

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
    await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");

    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 45000 });

    // Wait for the form to appear
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

    // Resume upload — find the file input
    let resumeInput: any = null;
    for (const sel of SELECTORS.resume) {
      resumeInput = await page.$(sel);
      if (resumeInput) break;
    }
    if (!resumeInput) {
      // Last resort: any file input on the page
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

    // LinkedIn
    if (payload.linkedinUrl) {
      await fillField(page, SELECTORS.linkedin, payload.linkedinUrl);
    }

    // Detect required fields that are still empty — report them before attempting submit
    const validationIssues: string[] = await page.evaluate(() => {
      const issues: string[] = [];
      const required = Array.from(document.querySelectorAll("[required], [aria-required='true']"));
      for (const el of required as HTMLElement[]) {
        const inp = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (!inp.value || inp.value.trim() === "") {
          const label = document.querySelector(`label[for='${inp.id}']`)?.textContent?.trim()
            ?? (inp as HTMLInputElement).placeholder ?? inp.name ?? "unknown field";
          if (!issues.includes(label)) issues.push(label);
        }
      }
      return issues;
    });
    if (validationIssues.length > 0) {
      console.warn("  [Greenhouse] Required fields still empty:", validationIssues.join(", "));
    }

    // Submit
    const submitBtn = await tryClick(page, SELECTORS.submit);
    if (!submitBtn) throw new Error("Could not find Submit button");

    await submitBtn.click();

    // Wait for either navigation or an in-page confirmation
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
      page.waitForSelector(
        "[data-qa='application-confirmation'], .application-confirmation, #confirmation, .confirmation",
        { timeout: 20000 }
      )
    ]).catch(() => {});

    await sleep(1500);

    // Screenshot AFTER submit for debugging
    const screenshotPath = `/tmp/greenhouse-apply-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const finalUrl = page.url();
    const pageText: string = await page.evaluate(() => (document as any).body.innerText);
    const textLower = pageText.toLowerCase();

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
      // Check for visible validation errors on the page
      const errorText: string = await page.evaluate(() => {
        const errs = Array.from(document.querySelectorAll(
          ".error, .field-error, [class*='error'], [aria-invalid='true'] + *, .invalid-feedback"
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
    if (browser) await browser.close();
  }
}
