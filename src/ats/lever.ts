// src/ats/lever.ts — auto-apply to Lever job postings

import { UserConfig } from "../config/types";

export interface ApplyPayload {
  name: string;
  email: string;
  phone?: string;
  resumePath: string;     // local path to tailored resume (converted to PDF)
  coverLetter?: string;
  linkedinUrl?: string;
}

export interface ApplyResult {
  success: boolean;
  url: string;
  error?: string;
  screenshotPath?: string;
}

export async function applyLever(
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

    // Navigate to job posting
    await page.goto(jobUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Find and click Apply button
    const applyBtn = await page.$('a[href*="/apply"], button[data-qa="btn-apply-bottom"]');
    if (!applyBtn) throw new Error("Could not find Apply button on Lever page");
    await applyBtn.click();
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    // Fill name
    const nameField = await page.$('input[name="name"]');
    if (nameField) {
      await nameField.click({ clickCount: 3 });
      await nameField.type(payload.name);
    }

    // Fill email
    const emailField = await page.$('input[name="email"]');
    if (emailField) {
      await emailField.click({ clickCount: 3 });
      await emailField.type(payload.email);
    }

    // Fill phone
    if (payload.phone) {
      const phoneField = await page.$('input[name="phone"]');
      if (phoneField) {
        await phoneField.click({ clickCount: 3 });
        await phoneField.type(payload.phone);
      }
    }

    // Upload resume
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error("Could not find resume upload field");
    await fileInput.uploadFile(payload.resumePath);
    await new Promise(r => setTimeout(r, 2000)); // wait for upload

    // Fill cover letter if field exists
    if (payload.coverLetter) {
      const clField = await page.$('textarea[name="comments"], textarea[placeholder*="cover"]');
      if (clField) {
        await clField.click({ clickCount: 3 });
        await clField.type(payload.coverLetter.slice(0, 3000)); // Lever has char limits
      }
    }

    // LinkedIn
    if (payload.linkedinUrl) {
      const liField = await page.$('input[name="urls[LinkedIn]"], input[placeholder*="LinkedIn"]');
      if (liField) {
        await liField.click({ clickCount: 3 });
        await liField.type(payload.linkedinUrl);
      }
    }

    // Screenshot before submit (for audit trail)
    const screenshotPath = `/tmp/lever-apply-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Submit — find submit button
    const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
    if (!submitBtn) throw new Error("Could not find Submit button");

    await submitBtn.click();
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});

    // Check for success indicators
    const pageText = await page.evaluate(() => document.body.innerText);
    const succeeded = pageText.toLowerCase().includes("thank") ||
                      pageText.toLowerCase().includes("submitted") ||
                      pageText.toLowerCase().includes("application received");

    if (!succeeded) {
      throw new Error("Could not confirm submission — check screenshot");
    }

    return { success: true, url: page.url(), screenshotPath };

  } catch (err: any) {
    return { success: false, url: jobUrl, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}
