import { Resend } from "resend";

/**
 * Transactional email. Uses Resend when RESEND_API_KEY is set; otherwise
 * logs the message to the server console (dev fallback so local signup
 * flows work without an email account).
 */
const FROM = process.env.EMAIL_FROM ?? "BizSplit <noreply@bizsplit.app>";

export async function sendEmail(opts: { to: string; subject: string; text: string }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.info(`[email:console-fallback] to=${opts.to} subject="${opts.subject}"\n${opts.text}`);
    return;
  }
  const resend = new Resend(key);
  const { error } = await resend.emails.send({ from: FROM, ...opts });
  if (error) throw new Error(`Failed to send email: ${error.message}`);
}
