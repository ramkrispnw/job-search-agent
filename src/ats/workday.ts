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
    // Wait for next page element rather than a fixed sleep
    await page.waitForSelector(
      '[data-automation-id="applyWithoutAccount"], input[type="file"], [data-automation-id="legalNameSection_firstName"]',
      { timeout: 8000 }
    ).catch(() => {}); // ignore if none found — page may already be ready

    // Workday may redirect to login — check for create account / guest apply
    const guestBtn = await page.$('[data-automation-id="applyWithoutAccount"]');
    if (guestBtn) {
      await guestBtn.click();
      await page.waitForSelector('input[type="file"], [data-automation-id="legalNameSection_firstName"]', { timeout: 6000 }).catch(() => {});
    }

    // Step 1: Resume upload (Workday always starts here)
    const resumeInput = await page.$('input[type="file"]');
    if (resumeInput) {
      await resumeInput.uploadFile(payload.resumePath);
      // Wait for parse spinner to disappear or a form field to appear
      await page.waitForSelector('[data-automation-id="legalNameSection_firstName"]', { timeout: 8000 }).catch(() => {
        return new Promise(r => setTimeout(r, 2000)); // fallback if selector never appears
      });
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
        // Wait for confirmation text or page change
        await page.waitForFunction(
          () => document.body.innerText.toLowerCase().includes("thank") ||
                document.body.innerText.toLowerCase().includes("submitted"),
          { timeout: 8000 }
        ).catch(() => {}); // page may not show confirmation inline
        break;
      }

      if (nextBtn) {
        await nextBtn.click();
        // Wait for the next button to disappear (step change) or a new one to appear
        await page.waitForFunction(
          (prevText: string) => document.body.innerText !== prevText,
          { timeout: 5000 },
          await page.evaluate(() => document.body.innerText)
        ).catch(() => {}); // ignore timeout — continue anyway
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
