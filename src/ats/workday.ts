// src/ats/workday.ts — auto-apply to Workday job postings

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

export async function applyWorkday(
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

    // Workday uses JS-heavy SPA — need longer wait
    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 45000 });

    // Click "Apply" button (Workday uses data-automation-id)
    await page.waitForSelector('[data-automation-id="applyButton"]', { timeout: 15000 });
    await page.click('[data-automation-id="applyButton"]');
    await page.waitForTimeout(3000);

    // Workday may redirect to login — check for create account / guest apply
    const guestBtn = await page.$('[data-automation-id="applyWithoutAccount"]');
    if (guestBtn) {
      await guestBtn.click();
      await page.waitForTimeout(2000);
    }

    // Step 1: Resume upload (Workday always starts here)
    const resumeInput = await page.$('input[type="file"]');
    if (resumeInput) {
      await resumeInput.uploadFile(payload.resumePath);
      await page.waitForTimeout(3000); // Workday parses resume
    }

    // Step 2: Personal info (Workday auto-fills from parsed resume, but we override)
    const [firstName, ...rest] = payload.name.split(" ");
    const lastName = rest.join(" ") || "";

    await fillWorkdayField(page, 'legalNameSection_firstName', firstName);
    await fillWorkdayField(page, 'legalNameSection_lastName', lastName);
    await fillWorkdayField(page, 'email', payload.email);
    if (payload.phone) await fillWorkdayField(page, 'phone-number', payload.phone);

    // Screenshot before final submit
    const screenshotPath = `/tmp/workday-apply-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Workday is multi-step — click through Next buttons
    let maxSteps = 8;
    while (maxSteps-- > 0) {
      const nextBtn = await page.$('[data-automation-id="bottom-navigation-next-button"]');
      const submitBtn = await page.$('[data-automation-id="bottom-navigation-done-button"]');

      if (submitBtn) {
        await submitBtn.click();
        await page.waitForTimeout(3000);
        break;
      }

      if (nextBtn) {
        await nextBtn.click();
        await page.waitForTimeout(2000);
      } else {
        break;
      }
    }

    const pageText = await page.evaluate(() => document.body.innerText);
    const succeeded = pageText.toLowerCase().includes("thank") ||
                      pageText.toLowerCase().includes("submitted");

    return { success: succeeded, url: page.url(), screenshotPath };

  } catch (err: any) {
    return { success: false, url: jobUrl, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

async function fillWorkdayField(page: any, automationId: string, value: string) {
  try {
    const field = await page.$(`[data-automation-id="${automationId}"] input, [data-automation-id="${automationId}"]`);
    if (field) {
      await field.click({ clickCount: 3 });
      await field.type(value);
    }
  } catch {
    // Field not found — skip
  }
}
