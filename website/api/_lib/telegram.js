import { timingSafeEqual } from "node:crypto";

function botToken() {
  return String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
}

function adminChatId() {
  return String(process.env.TELEGRAM_ADMIN_CHAT_ID || "").trim();
}

function webhookSecret() {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
}

function escapeTelegramHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function bounded(value, max = 280) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function money(value) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function statusLabel(status) {
  if (status === "approved") return "APPROVED";
  if (status === "rejected") return "REJECTED";
  if (status === "scan_failed") return "SCAN UNAVAILABLE";
  if (status === "scanning") return "SCANNING";
  return "REVIEW NEEDED";
}

function paymentButtons(order) {
  // Only expose a decision after a scan result exists. This prevents an early
  // Telegram click from approving a receipt that is still being inspected.
  if (!["review_required", "scan_failed"].includes(order.status)) return { inline_keyboard: [] };
  return {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `hp:a:${order.id}` },
        { text: "⛔ Disapprove", callback_data: `hp:r:${order.id}` },
      ],
    ],
  };
}

/** Compact, safe, detailed notification that intentionally excludes receipt URLs and raw data. */
export function formatPaymentTelegramNotification(order) {
  const reference = bounded(order?.receipt_reference_masked, 32) || "not detected";
  const confidence = Number(order?.scan_confidence);
  const confidenceText = Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : "n/a";
  const flags = Array.isArray(order?.scan_flags)
    ? order.scan_flags.map((flag) => bounded(flag, 48)).filter(Boolean).slice(0, 5)
    : [];
  const shortId = bounded(order?.id, 36).slice(0, 8) || "unknown";
  const summary = bounded(order?.scan_summary, 360) || "No scanner summary was returned.";
  const buyer = bounded(order?.customer_name, 100) || "—";
  const email = bounded(order?.email, 254) || "—";
  const plan = bounded(order?.plan_name || order?.plan_id, 80) || "—";

  const text = [
    `<b>GCash payment · ${escapeTelegramHtml(statusLabel(order?.status))}</b>`,
    `<b>Order:</b> <code>${escapeTelegramHtml(shortId)}</code>`,
    `<b>Plan:</b> ${escapeTelegramHtml(plan)} · <b>Amount:</b> ${escapeTelegramHtml(money(order?.amount_php))}`,
    `<b>Buyer:</b> ${escapeTelegramHtml(buyer)} · ${escapeTelegramHtml(email)}`,
    `<b>Reference:</b> ${escapeTelegramHtml(reference)}`,
    `<b>Scan:</b> ${escapeTelegramHtml(confidenceText)}${flags.length ? ` · ${escapeTelegramHtml(flags.join(", "))}` : ""}`,
    `<b>Summary:</b> ${escapeTelegramHtml(summary)}`,
    order?.status === "approved"
      ? "Plan was activated automatically after all receipt checks passed."
      : "Use the buttons below for a final decision. Receipt imagery remains in the private admin review area.",
  ].join("\n");

  return { text, replyMarkup: paymentButtons(order) };
}

export function telegramConfigured() {
  return Boolean(botToken() && adminChatId());
}

export function telegramWebhookConfigured() {
  return Boolean(botToken() && adminChatId() && webhookSecret());
}

export function telegramWebhookAuthorized(req) {
  const expected = webhookSecret();
  const headers = req?.headers || {};
  const actual = String(
    headers["x-telegram-bot-api-secret-token"] ||
      headers["X-Telegram-Bot-Api-Secret-Token"] ||
      "",
  );
  if (!expected || !actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function telegramAdminAuthorized(chatId) {
  return Boolean(adminChatId() && String(chatId || "").trim() === adminChatId());
}

export function parsePaymentCallbackData(value) {
  const match = String(value || "").match(
    /^hp:([ar]):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (!match) return null;
  return {
    action: match[1].toLowerCase() === "a" ? "approve" : "reject",
    orderId: match[2].toLowerCase(),
  };
}

async function telegramRequest(method, payload) {
  const token = botToken();
  if (!token) throw new Error("Telegram notifications are not configured.");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Telegram notification could not be delivered.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.ok) {
    throw new Error("Telegram notification could not be delivered.");
  }
  return body.result;
}

export async function sendPaymentTelegramNotification(order) {
  if (!telegramConfigured()) return { delivered: false, reason: "not_configured", messageId: null };
  const message = formatPaymentTelegramNotification(order);
  const sent = await telegramRequest("sendMessage", {
    chat_id: adminChatId(),
    text: message.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: message.replyMarkup,
  });
  return { delivered: true, messageId: Number(sent?.message_id) || null };
}

export async function answerTelegramCallback(callbackQueryId, text) {
  if (!callbackQueryId || !telegramConfigured()) return;
  await telegramRequest("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: bounded(text, 180) || "Updated",
  });
}

export async function updatePaymentTelegramNotification({ chatId, messageId, order }) {
  if (!telegramConfigured() || !chatId || !messageId) return;
  const message = formatPaymentTelegramNotification(order);
  try {
    await telegramRequest("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: message.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: message.replyMarkup,
    });
  } catch {
    // The approval has already been saved. Do not turn a Telegram edit failure
    // into a failed payment decision.
  }
}
