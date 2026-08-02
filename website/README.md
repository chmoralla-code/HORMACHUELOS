# Hormachuelos website

The Hormachuelos public site provides account access, downloads, hosted-model management, and a GCash proof-review checkout.

## GCash proof checkout

For each paid plan, the server—not the browser—chooses the price and matching QR image:

| Plan | Amount | QR asset |
| --- | ---: | --- |
| Starter | ₱299 | images/gcash/gcash-299.png |
| Pro | ₱999 | images/gcash/gcash-999.png |
| Max 5× | ₱2,499 | images/gcash/gcash-2499.png |
| Max 10× | ₱4,999 | images/gcash/gcash-4999.png |
| Max 20× | ₱9,999 | images/gcash/gcash-9999.png |

The flow is:

1. A signed-in, verified customer starts a payment request and sees the exact GCash QR.
2. The browser uploads the receipt image directly to the private payment-proofs Storage bucket through a short-lived signed URL. It never receives a Supabase service key.
3. The server checks the file format and SHA-256 fingerprint, then sends the image only to the configured NeuralWatt vision route using kimi-k2.7-code.
4. A payment is auto-approved only when all gates pass: readable GCash receipt, exact amount, a new fingerprint, a new reference number, no visual synthetic/tamper signal, and scanner confidence of at least 94%.
5. Any uncertain result remains in the private admin review list and sends an actionable Telegram notification. Admins can approve or reject it in Telegram or from the dashboard.

Receipt scanning is a fraud-control screen, not confirmation from GCash or a bank. A failed or uncertain scan never grants a plan automatically.

## Configuration

Copy [.env.example](./.env.example) into your Vercel environment configuration. Keep every value server-side; do not add keys or Telegram tokens to client JavaScript, source files, or public build output.

Required for the payment workflow:

- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
- NEURALWATT_RECEIPT_SCANNER_API_KEY
- TELEGRAM_BOT_TOKEN
- TELEGRAM_ADMIN_CHAT_ID
- TELEGRAM_WEBHOOK_SECRET — generate a long random value
- LICENSE_ISSUE_SECRET or HORMACHUELOS_LICENSE_KEY_SECRET

Optional:

- NEURALWATT_RECEIPT_SCANNER_BASE_URL (defaults to https://api.neuralwatt.com/v1)
- NEURALWATT_RECEIPT_SCANNER_MODEL (defaults to kimi-k2.7-code)
- GCASH_RECEIVER_LABEL (defaults to the masked label shown on the supplied QR images)
- PAYMENT_REFERENCE_SECRET (a separate secret used to HMAC receipt references)

## Launch checklist

1. Apply the migration in ../supabase/migrations/20260802132905_payment_proof_orders.sql to the production Supabase project.
2. Add the required environment values in Vercel for Production, Preview, and Development as appropriate.
3. Deploy the website.
4. Configure Telegram with a webhook URL ending in /api/telegram-webhook, the same TELEGRAM_WEBHOOK_SECRET, and callback_query as the allowed update type.
5. Test with a non-production account and receipt before announcing the checkout publicly.

## Local UI preview

For visual-only work:

~~~
npx --yes serve -l 5174
~~~

The payment APIs are Vercel serverless routes and require Supabase plus server-side environment variables. Use a Vercel-compatible development environment for end-to-end payment testing.

## Tests

~~~
node --test tests/payments.test.mjs
~~~

The unit tests cover plan/QR mapping, anti-fraud gates, scanner JSON parsing, non-leakage of private receipt data, and Telegram callback formatting.
