// src/utils/emailReader.ts — read Greenhouse security code from Gmail via IMAP

interface EmailCredentials {
  smtpUser: string;  // Gmail address
  smtpPass: string;  // App password (16-char)
}

// Extracts the alphanumeric security code from Greenhouse email body text
function parseSecurityCode(text: string): string | null {
  // Greenhouse codes are 8 alphanumeric chars, typically on their own line
  const patterns = [
    /security code[:\s]*([A-Za-z0-9]{6,12})/i,
    /verification code[:\s]*([A-Za-z0-9]{6,12})/i,
    /your code[:\s]*([A-Za-z0-9]{6,12})/i,
    /\b([A-Za-z0-9]{8})\b/  // 8-char standalone token (Greenhouse default)
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export async function readGreenhouseSecurityCode(
  credentials: EmailCredentials,
  timeoutMs = 45000
): Promise<string | null> {
  const { ImapFlow } = await import("imapflow");

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: credentials.smtpUser, pass: credentials.smtpPass },
    logger: false
  });

  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 4000;

  try {
    await client.connect();
    await client.mailboxOpen("INBOX");

    while (Date.now() < deadline) {
      // Search for Greenhouse emails received in the last 2 minutes
      const since = new Date(Date.now() - 2 * 60 * 1000);
      const messages: number[] = (await client.search({
        since,
        or: [
          { from: "greenhouse.io" },
          { subject: "security code" },
          { subject: "verification code" }
        ]
      }) as any) || [];

      for (const uid of messages) {
        const msg = await client.fetchOne(String(uid), { bodyStructure: true, source: true });
        if (!msg) continue;
        const raw = msg.source?.toString() ?? "";

        // Extract plain text from the raw MIME message (strip HTML tags)
        const textPart = raw.replace(/<[^>]+>/g, " ").replace(/=\r?\n/g, "");
        const code = parseSecurityCode(textPart);
        if (code) return code;
      }

      if (Date.now() + pollIntervalMs < deadline) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
      } else {
        break;
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    await client.logout().catch(() => {});
  }
}
