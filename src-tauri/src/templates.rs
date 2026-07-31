//! PH freelancer project scaffolds for New Build.

use anyhow::{bail, Context, Result};
use std::path::Path;

#[derive(Debug, Clone, Copy)]
pub struct TemplateMeta {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
}

pub const TEMPLATES: &[TemplateMeta] = &[
    TemplateMeta {
        id: "blank",
        label: "Blank",
        blurb: "Empty folder — start from a prompt",
    },
    TemplateMeta {
        id: "portfolio",
        label: "Portfolio",
        blurb: "Personal site for freelancers",
    },
    TemplateMeta {
        id: "sari-sari",
        label: "Sari-sari / POS",
        blurb: "Simple storefront + price list",
    },
    TemplateMeta {
        id: "booking",
        label: "Booking",
        blurb: "Appointments for clinics / salons",
    },
    TemplateMeta {
        id: "fb-landing",
        label: "FB Ads landing",
        blurb: "One-page offer for Facebook ads",
    },
];

pub fn scaffold(template_id: &str, root: &Path) -> Result<()> {
    let id = template_id.trim().to_ascii_lowercase();
    if id.is_empty() || id == "blank" {
        std::fs::create_dir_all(root).context("Could not create project folder")?;
        return Ok(());
    }
    std::fs::create_dir_all(root).context("Could not create project folder")?;
    match id.as_str() {
        "portfolio" => write_portfolio(root)?,
        "sari-sari" => write_sari_sari(root)?,
        "booking" => write_booking(root)?,
        "fb-landing" => write_fb_landing(root)?,
        other => bail!("Unknown template: {other}"),
    }
    Ok(())
}

fn write_file(root: &Path, rel: &str, content: &str) -> Result<()> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)
        .with_context(|| format!("Could not write {}", path.display()))?;
    Ok(())
}

fn write_portfolio(root: &Path) -> Result<()> {
    write_file(
        root,
        "README.md",
        "# Portfolio\n\nPersonal portfolio starter for Filipino freelancers.\n\nOpen `index.html` in a browser, or ask Hormachuelos to restyle and deploy.\n",
    )?;
    write_file(
        root,
        "index.html",
        r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Your Name — Portfolio</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="hero">
    <p class="eyebrow">Freelancer · Philippines</p>
    <h1>Your Name</h1>
    <p class="lede">I build websites and apps for local businesses.</p>
    <a class="cta" href="#work">See work</a>
  </header>
  <main id="work">
    <h2>Selected work</h2>
    <ul class="grid">
      <li><strong>Client site</strong> — Landing page for FB ads</li>
      <li><strong>Store page</strong> — Price list + GCash CTA</li>
      <li><strong>Booking</strong> — Simple appointment form</li>
    </ul>
  </main>
  <footer>
    <p>Contact: you@email.com · Viber / Messenger</p>
  </footer>
</body>
</html>
"##,
    )?;
    write_file(
        root,
        "styles.css",
        r##":root {
  --bg: #121212;
  --fg: #f2f0e8;
  --muted: #9a9a9a;
  --accent: #e8e4d8;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Segoe UI", system-ui, sans-serif;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.5;
}
.hero { padding: 18vh 8vw 10vh; }
.eyebrow { color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px; }
h1 { font-size: clamp(2.4rem, 8vw, 4.5rem); margin: 0.2em 0; font-weight: 600; }
.lede { max-width: 28ch; color: var(--muted); font-size: 1.15rem; }
.cta {
  display: inline-block;
  margin-top: 1.5rem;
  padding: 0.75rem 1.25rem;
  border-radius: 999px;
  background: var(--accent);
  color: #111;
  text-decoration: none;
  font-weight: 600;
}
main { padding: 0 8vw 12vh; }
.grid { list-style: none; padding: 0; display: grid; gap: 1rem; }
.grid li { padding: 1rem 0; border-top: 1px solid #2a2a2a; }
footer { padding: 2rem 8vw 4rem; color: var(--muted); font-size: 0.95rem; }
"##,
    )?;
    Ok(())
}

fn write_sari_sari(root: &Path) -> Result<()> {
    write_file(
        root,
        "README.md",
        "# Sari-sari / mini POS\n\nSimple product list + GCash CTA for small stores.\n",
    )?;
    write_file(
        root,
        "index.html",
        r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Store — Price list</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header>
    <h1>Aling Nena's Store</h1>
    <p>Order via Messenger · Pay with GCash</p>
  </header>
  <main>
    <ul id="products" class="products"></ul>
    <aside class="pay">
      <h2>Mag-order</h2>
      <p>Message us your list, then pay via GCash.</p>
      <p class="gcash">GCash: 09XX XXX XXXX</p>
      <a class="cta" href="https://m.me/" target="_blank" rel="noopener">Chat on Messenger</a>
    </aside>
  </main>
  <script src="app.js"></script>
</body>
</html>
"##,
    )?;
    write_file(
        root,
        "styles.css",
        r##"body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #0f1410; color: #f0f2ef; }
header, main { padding: 1.5rem; max-width: 900px; margin: 0 auto; }
.products { list-style: none; padding: 0; display: grid; gap: 0.75rem; }
.products li { display: flex; justify-content: space-between; padding: 0.85rem 1rem; background: #1a211c; border-radius: 12px; }
.pay { margin-top: 2rem; padding: 1.25rem; border-radius: 16px; background: #162018; }
.gcash { font-family: ui-monospace, monospace; letter-spacing: 0.04em; }
.cta { display: inline-block; margin-top: 0.75rem; padding: 0.7rem 1.1rem; border-radius: 999px; background: #dfe8e2; color: #102015; text-decoration: none; font-weight: 600; }
"##,
    )?;
    write_file(
        root,
        "app.js",
        r##"const products = [
  { name: "Lucky Me Pancit Canton", price: 15 },
  { name: "Coke 1.5L", price: 75 },
  { name: "Egg (each)", price: 9 },
  { name: "Rice 1kg", price: 55 },
];
const list = document.getElementById("products");
list.innerHTML = products
  .map((p) => `<li><span>${p.name}</span><strong>₱${p.price}</strong></li>`)
  .join("");
"##,
    )?;
    Ok(())
}

fn write_booking(root: &Path) -> Result<()> {
    write_file(
        root,
        "README.md",
        "# Booking page\n\nSimple appointment request form for salons, clinics, and tutors.\n",
    )?;
    write_file(
        root,
        "index.html",
        r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Book an appointment</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main>
    <h1>Book with us</h1>
    <p class="sub">Same-day replies on Messenger · Pay via GCash after confirmation</p>
    <form id="book">
      <label>Name <input name="name" required /></label>
      <label>Service
        <select name="service">
          <option>Haircut</option>
          <option>Consultation</option>
          <option>Tutoring</option>
        </select>
      </label>
      <label>Preferred date <input type="date" name="date" required /></label>
      <label>Notes <textarea name="notes" rows="3" placeholder="Optional"></textarea></label>
      <button type="submit">Request booking</button>
    </form>
    <p id="status" hidden></p>
  </main>
  <script src="app.js"></script>
</body>
</html>
"##,
    )?;
    write_file(
        root,
        "styles.css",
        r##"body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #141218; color: #f5f2ea; }
main { max-width: 420px; margin: 0 auto; padding: 3rem 1.25rem; }
.sub { color: #a8a49a; }
form { display: grid; gap: 0.85rem; margin-top: 1.5rem; }
label { display: grid; gap: 0.35rem; font-size: 0.92rem; }
input, select, textarea, button {
  font: inherit; padding: 0.7rem 0.8rem; border-radius: 10px; border: 1px solid #2c2a32; background: #1c1a22; color: inherit;
}
button { background: #ece7db; color: #16141c; font-weight: 600; cursor: pointer; border: none; }
"##,
    )?;
    write_file(
        root,
        "app.js",
        r##"document.getElementById("book").addEventListener("submit", (e) => {
  e.preventDefault();
  const status = document.getElementById("status");
  status.hidden = false;
  status.textContent = "Salamat! We will confirm via Messenger. (Demo — wire this to your inbox.)";
});
"##,
    )?;
    Ok(())
}

fn write_fb_landing(root: &Path) -> Result<()> {
    write_file(
        root,
        "README.md",
        "# FB Ads landing\n\nOne-page offer page for Facebook / Instagram ads. Replace CTA links before launch.\n",
    )?;
    write_file(
        root,
        "index.html",
        r##"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Limited offer</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <section class="offer">
    <p class="badge">Promo · This week only</p>
    <h1>Get your business online in 7 days</h1>
    <p class="price">From <strong>₱2,999</strong></p>
    <p class="copy">Landing page + Messenger booking + GCash payment instructions — built for Filipino sellers.</p>
    <a class="cta" href="https://m.me/" target="_blank" rel="noopener">Message us to start</a>
  </section>
</body>
</html>
"##,
    )?;
    write_file(
        root,
        "styles.css",
        r##"body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(ellipse at top, #2a2418, #0e0d0b 55%);
  color: #f7f3ea;
  font-family: "Segoe UI", system-ui, sans-serif;
}
.offer { max-width: 34rem; padding: 2rem; text-align: center; }
.badge { color: #c9b896; letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.75rem; }
h1 { font-size: clamp(1.8rem, 6vw, 2.6rem); line-height: 1.15; }
.price { font-size: 1.35rem; }
.copy { color: #bdb6a8; }
.cta {
  display: inline-block;
  margin-top: 1.25rem;
  padding: 0.85rem 1.4rem;
  border-radius: 999px;
  background: #f0e6d2;
  color: #1a160f;
  text-decoration: none;
  font-weight: 700;
}
"##,
    )?;
    Ok(())
}
