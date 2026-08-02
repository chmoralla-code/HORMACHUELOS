import { readJson } from "./_lib/http.js";
import { approvePaymentOrder, rejectPaymentOrder } from "./_lib/payments.js";
import {
  answerTelegramCallback,
  parsePaymentCallbackData,
  telegramAdminAuthorized,
  telegramWebhookAuthorized,
  telegramWebhookConfigured,
  updatePaymentTelegramNotification,
} from "./_lib/telegram.js";

function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Telegram callback endpoint. Its header secret is verified before parsing the
 * update, and the callback message must belong to the configured admin chat.
 * It deliberately returns no receipt content or order details to the caller.
 */
export default async function handler(req, res) {
  if (req.method !== "POST") return respond(res, 405, { ok: false });
  if (!telegramWebhookConfigured() || !telegramWebhookAuthorized(req)) {
    return respond(res, 401, { ok: false });
  }

  let update;
  try {
    update = await readJson(req);
  } catch {
    return respond(res, 400, { ok: false });
  }

  const callback = update?.callback_query;
  if (!callback) return respond(res, 200, { ok: true });

  const callbackId = String(callback.id || "");
  const chatId = callback?.message?.chat?.id;
  if (!telegramAdminAuthorized(chatId)) {
    try {
      await answerTelegramCallback(callbackId, "Not authorized.");
    } catch {
      // The webhook response still succeeds to prevent unnecessary retries.
    }
    return respond(res, 200, { ok: true });
  }

  const decision = parsePaymentCallbackData(callback.data);
  if (!decision) {
    try {
      await answerTelegramCallback(callbackId, "This payment action is no longer valid.");
    } catch {
      // See comment above.
    }
    return respond(res, 200, { ok: true });
  }

  try {
    const actor = `telegram:${String(chatId).slice(0, 64)}`;
    const order =
      decision.action === "approve"
        ? await approvePaymentOrder(decision.orderId, { actor, requirePassedScan: false })
        : await rejectPaymentOrder(decision.orderId, { actor });

    await answerTelegramCallback(
      callbackId,
      decision.action === "approve" ? "Payment approved and plan activated." : "Payment request rejected.",
    );
    await updatePaymentTelegramNotification({
      chatId,
      messageId: callback?.message?.message_id,
      order,
    });
    return respond(res, 200, { ok: true });
  } catch {
    try {
      await answerTelegramCallback(callbackId, "Unable to update this payment. Review it in the admin dashboard.");
    } catch {
      // The result is intentionally opaque to the webhook caller.
    }
    return respond(res, 200, { ok: true });
  }
}
