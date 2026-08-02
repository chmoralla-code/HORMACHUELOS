import { corsHeaders, json, readJson } from "../_lib/http.js";
import { accountFromRequest } from "../_lib/auth.js";
import { getPaymentOrderById, supabaseConfigured } from "../_lib/supabase.js";
import {
  createPaymentOrder,
  createPaymentProofUploadIntent,
  listAccountPaymentOrders,
  savePaymentTelegramMessageId,
  submitPaymentProof,
} from "../_lib/payments.js";
import { sendPaymentTelegramNotification } from "../_lib/telegram.js";

function actionOf(req) {
  const path = req.query?.path;
  if (Array.isArray(path) && path.length) return path.map(String).join("/").toLowerCase();
  if (typeof path === "string" && path) return path.toLowerCase();
  const url = String(req.url || "");
  const match = url.match(/\/api\/payments\/(.+?)(?:\?|$)/i);
  return match ? match[1].replace(/\/+$/, "").toLowerCase() : "";
}

function queryValue(req, name) {
  if (req.query?.[name] != null) return String(req.query[name]);
  try {
    return new URL(String(req.url || ""), "https://hormachuelos.local").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function errorPayload(error, status = Number(error?.status) || 500) {
  if (status >= 500) {
    return { error: "Payment service is temporarily unavailable. Please try again later." };
  }
  const payload = { error: String(error?.message || error || "Payment request failed.") };
  if (error?.code) payload.code = error.code;
  return payload;
}

async function currentVerifiedAccount(req, res) {
  const account = await accountFromRequest(req);
  if (!account) {
    json(res, 401, { error: "Log in before starting checkout." }, req);
    return null;
  }
  if (!account.email_verified) {
    json(res, 403, { error: "Verify your email before submitting a payment proof." }, req);
    return null;
  }
  return account;
}

/**
 * Payment images are uploaded directly to a private Supabase Storage bucket
 * through a short-lived signed URL. Vercel only receives small JSON requests;
 * it never receives the proof image itself.
 */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [key, value] of Object.entries(corsHeaders(req))) res.setHeader(key, value);
    return res.end();
  }

  if (!supabaseConfigured()) {
    return json(res, 503, { error: "Payment service is not configured." }, req);
  }

  const action = actionOf(req);
  try {
    const account = await currentVerifiedAccount(req, res);
    if (!account) return;

    if (action === "create" && req.method === "POST") {
      const body = await readJson(req);
      const created = await createPaymentOrder(account, {
        planId: body.planId || body.plan_id,
        period: body.period,
      });
      return json(res, 201, { ok: true, ...created }, req);
    }

    if ((action === "upload-intent" || action === "upload_intent") && req.method === "POST") {
      const body = await readJson(req);
      const intent = await createPaymentProofUploadIntent(account, {
        orderId: body.orderId || body.order_id,
        mimeType: body.mimeType || body.mime_type,
        bytes: body.bytes,
      });
      return json(res, 200, { ok: true, ...intent }, req);
    }

    if (action === "submit" && req.method === "POST") {
      const body = await readJson(req);
      const result = await submitPaymentProof(account, {
        orderId: body.orderId || body.order_id,
      });

      // Telegram is an operational notification, not a payment dependency. A
      // completed scan/approval is retained even if the notification channel is
      // momentarily unavailable.
      let telegram = { delivered: false };
      // A concurrent retry can observe the in-progress state. Notify the
      // administrator only after the scanner has produced a reviewable result.
      if (result.order?.status !== "scanning") {
        try {
          const internalOrder = await getPaymentOrderById(result.order?.id);
          if (internalOrder) {
            telegram = await sendPaymentTelegramNotification(internalOrder);
            if (telegram.delivered && telegram.messageId) {
              await savePaymentTelegramMessageId(internalOrder.id, telegram.messageId);
            }
          }
        } catch {
          telegram = { delivered: false };
        }
      }

      return json(
        res,
        200,
        {
          ok: true,
          order: result.order,
          autoApproved: Boolean(result.autoApproved),
          notificationSent: Boolean(telegram.delivered),
        },
        req,
      );
    }

    if (action === "status" && req.method === "GET") {
      const orderId = queryValue(req, "orderId") || queryValue(req, "order_id");
      const orders = await listAccountPaymentOrders(account.id);
      const order = orders.find((candidate) => candidate.id === orderId);
      if (!order) return json(res, 404, { error: "Payment request not found." }, req);
      return json(res, 200, { ok: true, order }, req);
    }

    if (action === "list" && req.method === "GET") {
      const orders = await listAccountPaymentOrders(account.id);
      return json(res, 200, { ok: true, orders }, req);
    }

    return json(res, 404, { error: `Unknown payment action: ${action || "(empty)"}` }, req);
  } catch (error) {
    const status = Number(error?.status) || 500;
    return json(res, status, errorPayload(error, status), req);
  }
}
