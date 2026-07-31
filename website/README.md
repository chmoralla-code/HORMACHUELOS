# Hormachuelos marketing site

Monochrome, minimalist product site for the PH launch: login/signup, pricing tiers, demo GCash checkout, dashboard.

## Run locally

From this folder:

```bash
npx --yes serve -l 5174
```

Or with Python:

```bash
python -m http.server 5174
```

Open `http://localhost:5174`.

## Features

- Home, Features, Pricing, FAQ, Support, Legal
- Sign up / Log in (localStorage demo auth)
- Billing periods: **15 Days · Monthly · Yearly · Annual+**
- Plans: Starter / Pro / Agency (temporary PHP prices)
- Checkout with GCash / Maya / Card (simulated payment)
- Dashboard with plan, credits, order history

## Next

Wire real PayMongo or Xendit GCash when merchant KYC is ready.
