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
    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Greenhouse has a consistent form structure
    // First name / Last name (split)
    const [firstName, ...rest] = payload.name.split(" ");
    const lastName = rest.join(" ") || "";

    const firstNameField = await page.$("#first_name");
    const lastNameField  = await page.$("#last_name");

    if (firstNameField) {
      await firstNameField.click({ clickCount: 3 });
      await firstNameField.type(firstName);
    }
    if (lastNameField) {
      await lastNameField.click({ clickCount: 3 });
      await lastNameField.type(lastName);
    }

    // Email
    const emailField = await page.$("#email");
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type(payload.email);
    }

    // Phone
    if (payload.phone) {
      const phoneField = await page.$("#phone");
      if (phoneField) {
        await phoneField.click({ clickCount: 3 });
        await phoneField.type(payload.phone);
      }
    }

    // Resume upload — Greenhouse uses a specific input
    const resumeInput = await page.$('input[type="file"][name*="resume"], #resume');
    if (!resumeInput) throw new Error("Could not find resume upload field");
    await resumeInput.uploadFile(payload.resumePath);
    await page.waitForTimeout(2000);

    // Cover letter — sometimes a textarea, sometimes file upload
    if (payload.coverLetter) {
      const clTextarea = await page.$("textarea#cover_letter, textarea[name='cover_letter']");
      if (clTextarea) {
        await clTextarea.click({ clickCount: 3 });
        await clTextarea.type(payload.coverLetter.slice(0, 5000));
      }
    }

    // LinkedIn URL — Greenhouse has a custom questions section
    if (payload.linkedinUrl) {
      const liField = await page.$("input[placeholder*='LinkedIn'], input[id*='linkedin']");
      if (liField) {
        await liField.click({ clickCount: 3 });
        await liField.type(payload.linkedinUrl);
      }
    }

    // Screenshot before submit
    const screenshotPath = `/tmp/greenhouse-apply-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Submit
    const submitBtn = await page.$('input[type="submit"]#submit_app, button[type="submit"]');
    if (!submitBtn) throw new Error("Could not find Submit button");

    await submitBtn.click();
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});

    const pageText = await page.evaluate(() => document.body.innerText);
    const succeeded = pageText.toLowerCase().includes("thank") ||
                      pageText.toLowerCase().includes("application submitted");

    if (!succeeded) throw new Error("Could not confirm Greenhouse submission");

    return { success: true, url: page.url(), screenshotPath };

  } catch (err: any) {
    return { success: false, url: jobUrl, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}
