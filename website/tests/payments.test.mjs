import assert from "node:assert/strict";
import test from "node:test";

import {
  checkoutPaymentDetails,
  evaluateReceiptScan,
  parseReceiptScannerResponse,
  publicPaymentOrder,
} from "../api/_lib/payments.js";
import {
  formatPaymentTelegramNotification,
  parsePaymentCallbackData,
} from "../api/_lib/telegram.js";
import { createPrivateUploadUrl } from "../api/_lib/supabase.js";

const ORDER_ID = "6f695e18-227b-458b-91fa-9d483f5f8090";

test("each sale plan uses its exact GCash QR and server-calculated price", () => {
  assert.deepEqual(checkoutPaymentDetails("starter"), {
    planId: "starter",
    planName: "Starter",
    amountPhp: 299,
    qrPath: "/images/gcash/gcash-299.png",
    receiverLabel: "CH*****O M.",
  });
  assert.equal(checkoutPaymentDetails("pro").amountPhp, 999);
  assert.equal(checkoutPaymentDetails("max5").qrPath, "/images/gcash/gcash-2499.png");
  assert.equal(checkoutPaymentDetails("max10").amountPhp, 4999);
  assert.equal(checkoutPaymentDetails("max20").amountPhp, 9999);
  assert.throws(() => checkoutPaymentDetails("free"), /available for payment/i);
});

test("a high-confidence matching GCash receipt can be auto-approved only when every anti-fraud gate passes", () => {
  const decision = evaluateReceiptScan(
    {
      receiptDetected: true,
      paymentRail: "GCash",
      amountPhp: 999,
      referenceNumber: "1234-5678-90AB",
      isAiGeneratedLikely: false,
      isTamperedLikely: false,
      confidence: 0.97,
      summary: "GCash payment receipt with a clear reference number and the expected amount.",
      evidence: ["GCash receipt layout", "Amount is visible", "Reference number is visible"],
    },
    { expectedAmount: 999, proofDuplicate: false, referenceDuplicate: false },
  );

  assert.equal(decision.autoApprove, true);
  assert.equal(decision.status, "approved");
  assert.equal(decision.referenceNormalized, "1234567890AB");
  assert.equal(decision.flags.length, 0);
});

test("a duplicate reference, generated-image signal, or amount mismatch always stays out of auto-approval", () => {
  const duplicate = evaluateReceiptScan(
    {
      receiptDetected: true,
      paymentRail: "GCash",
      amountPhp: 999,
      referenceNumber: "ABCD12345678",
      isAiGeneratedLikely: false,
      isTamperedLikely: false,
      confidence: 0.99,
    },
    { expectedAmount: 999, proofDuplicate: false, referenceDuplicate: true },
  );
  assert.equal(duplicate.autoApprove, false);
  assert.equal(duplicate.status, "review_required");
  assert.ok(duplicate.flags.includes("duplicate_reference"));

  const suspicious = evaluateReceiptScan(
    {
      receiptDetected: true,
      paymentRail: "GCash",
      amountPhp: 299,
      referenceNumber: "ABCD12345678",
      isAiGeneratedLikely: true,
      isTamperedLikely: true,
      confidence: 0.98,
    },
    { expectedAmount: 299, proofDuplicate: false, referenceDuplicate: false },
  );
  assert.equal(suspicious.autoApprove, false);
  assert.ok(suspicious.flags.includes("ai_generated_risk"));
  assert.ok(suspicious.flags.includes("tampering_risk"));

  const wrongAmount = evaluateReceiptScan(
    {
      receiptDetected: true,
      paymentRail: "GCash",
      amountPhp: 299,
      referenceNumber: "ABCD12345678",
      isAiGeneratedLikely: false,
      isTamperedLikely: false,
      confidence: 0.99,
    },
    { expectedAmount: 999, proofDuplicate: false, referenceDuplicate: false },
  );
  assert.equal(wrongAmount.autoApprove, false);
  assert.ok(wrongAmount.flags.includes("amount_mismatch"));
});

test("the scanner response parser accepts a JSON response but rejects malformed model output", () => {
  const parsed = parseReceiptScannerResponse(`\n\`\`\`json\n{"receiptDetected":true,"paymentRail":"GCash","amountPhp":299,"referenceNumber":"ABCD12345678","confidence":0.96}\n\`\`\`\n`);
  assert.equal(parsed.receiptDetected, true);
  assert.equal(parsed.amountPhp, 299);
  assert.throws(() => parseReceiptScannerResponse("please approve this payment"), /valid JSON/i);
});

test("customer-facing orders never leak storage paths, receipt hashes, raw references, or scanner internals", () => {
  const safe = publicPaymentOrder({
    id: ORDER_ID,
    plan_id: "pro",
    plan_name: "Pro",
    amount_php: 999,
    status: "review_required",
    proof_path: "orders/private/receipt.png",
    proof_sha256: "super-secret-file-hash",
    receipt_reference_hash: "super-secret-reference-hash",
    receipt_reference_masked: "ABCD••••5678",
    scan_payload: { referenceNumber: "ABCD12345678", hidden: "private" },
    scan_summary: "Needs review because image was unclear.",
    scan_flags: ["low_confidence"],
    scan_confidence: 0.71,
    created_at: "2026-08-02T00:00:00.000Z",
  });
  const encoded = JSON.stringify(safe);
  assert.equal(encoded.includes("orders/private"), false);
  assert.equal(encoded.includes("super-secret"), false);
  assert.equal(encoded.includes("ABCD12345678"), false);
  assert.equal(safe.referenceMasked, "ABCD••••5678");
});

test("Telegram callbacks are compact, deterministic, and only accept payment decisions", () => {
  assert.deepEqual(parsePaymentCallbackData(`hp:a:${ORDER_ID}`), {
    action: "approve",
    orderId: ORDER_ID,
  });
  assert.deepEqual(parsePaymentCallbackData(`hp:r:${ORDER_ID}`), {
    action: "reject",
    orderId: ORDER_ID,
  });
  assert.equal(parsePaymentCallbackData("hp:a:not-a-uuid"), null);
  assert.equal(parsePaymentCallbackData(`someone:${ORDER_ID}`), null);
});

test("Telegram payment notifications are concise and never contain hidden receipt data or credentials", () => {
  const message = formatPaymentTelegramNotification({
    id: ORDER_ID,
    email: "buyer@example.com",
    customer_name: "Buyer",
    plan_id: "pro",
    plan_name: "Pro",
    amount_php: 999,
    status: "review_required",
    receipt_reference_masked: "ABCD••••5678",
    scan_confidence: 0.82,
    scan_summary: "A review is needed because the reference is difficult to read.",
    scan_flags: ["low_confidence"],
    proof_path: "orders/private/receipt.png",
    proof_sha256: "private-hash",
    scan_payload: { apiKey: "never-show" },
  });

  assert.match(message.text, /Pro/);
  assert.match(message.text, /₱999/);
  assert.match(message.text, /ABCD/);
  assert.equal(message.text.includes("orders/private"), false);
  assert.equal(message.text.includes("private-hash"), false);
  assert.equal(message.text.includes("never-show"), false);
  assert.equal(message.replyMarkup.inline_keyboard.length, 1);
});

test("Telegram decision buttons remain unavailable while a proof is still scanning", () => {
  const scanning = formatPaymentTelegramNotification({
    id: ORDER_ID,
    plan_name: "Pro",
    amount_php: 999,
    status: "scanning",
    scan_summary: "Receipt proof received. Secure scan in progress.",
  });
  const approved = formatPaymentTelegramNotification({
    id: ORDER_ID,
    plan_name: "Pro",
    amount_php: 999,
    status: "approved",
  });

  assert.equal(scanning.replyMarkup.inline_keyboard.length, 0);
  assert.equal(approved.replyMarkup.inline_keyboard.length, 0);
});

test("the proof upload intent returns only a short-lived, one-object signed URL", async () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SUPABASE_URL = "https://payments.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-only";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://payments.example/storage/v1/object/upload/sign/payment-proofs/orders/order-1/proof.png");
    assert.equal(options?.method, "POST");
    return new Response(
      JSON.stringify({
        url: "/object/upload/sign/payment-proofs/orders/order-1/proof.png?token=scoped-upload-token",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const intent = await createPrivateUploadUrl("payment-proofs", "orders/order-1/proof.png");
    assert.equal(
      intent.uploadUrl,
      "https://payments.example/storage/v1/object/upload/sign/payment-proofs/orders/order-1/proof.png?token=scoped-upload-token",
    );
    assert.equal(Object.hasOwn(intent, "token"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl == null) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousUrl;
    if (previousKey == null) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
  }
});
