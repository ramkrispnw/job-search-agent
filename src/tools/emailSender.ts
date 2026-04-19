// src/tools/emailSender.ts — send HTML job report by email via SMTP

import nodemailer from "nodemailer";

export async function sendJobReport(opts: {
  smtpUser: string;
  smtpPass: string;
  toAddress: string;
  subject: string;
  htmlContent: string;
}): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: opts.smtpUser, pass: opts.smtpPass }
  });

  await transporter.sendMail({
    from: `"Job Search Agent" <${opts.smtpUser}>`,
    to: opts.toAddress,
    subject: opts.subject,
    html: opts.htmlContent
  });
}
