const RESEND_API = "https://api.resend.com/emails";

export function resendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function resendFrom() {
  // Display name must be HORMACHUELOS. Override address via RESEND_FROM_EMAIL
  // after verifying a domain in Resend (defaults to Resend onboarding sender).
  const email = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
  const bare = String(email).replace(/^.*<|>.*$/g, "").trim() || "onboarding@resend.dev";
  return `HORMACHUELOS <${bare}>`;
}

export async function sendResendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw Object.assign(new Error("RESEND_API_KEY is not configured."), { status: 503 });
  }
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resendFrom(),
      to: [to],
      subject,
      html,
      text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || `Resend failed (${res.status})`;
    throw Object.assign(new Error(String(msg)), { status: 502 });
  }
  return data;
}

export async function sendVerificationEmail({ to, name, code }) {
  const site = process.env.PUBLIC_SITE_URL || "https://hormachuelos.vercel.app";
  const link = `${site}/#/verify?email=${encodeURIComponent(to)}&code=${encodeURIComponent(code)}`;
  const subject = "Confirm your Hormachuelos account";
  const text = `Hi ${name || "there"},

Your Hormachuelos verification code is: ${code}

Or open this link: ${link}

This code expires in 30 minutes. If you did not sign up, ignore this email.

— HORMACHUELOS`;
  const html = `
  <div style="font-family:IBM Plex Sans,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
    <p style="letter-spacing:.12em;font-size:12px;font-weight:700;margin:0 0 16px">HORMACHUELOS</p>
    <h1 style="font-size:22px;margin:0 0 12px">Confirm your account</h1>
    <p style="margin:0 0 16px;line-height:1.5">Hi ${escapeHtml(name || "there")}, use this code to finish signing up:</p>
    <p style="font-size:32px;letter-spacing:.2em;font-weight:700;margin:0 0 20px">${escapeHtml(code)}</p>
    <p style="margin:0 0 16px;line-height:1.5">Or <a href="${escapeHtml(link)}">click here to verify</a>. The code expires in 30 minutes.</p>
    <p style="margin:0;color:#666;font-size:13px;line-height:1.5">If you did not create a Hormachuelos account, you can ignore this email.</p>
  </div>`;
  return sendResendEmail({ to, subject, html, text });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
