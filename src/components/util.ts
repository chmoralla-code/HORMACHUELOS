// Shared render helpers
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

export function div(cls: string = "", html = "", kids: Node[] = []): HTMLDivElement {
  const node = document.createElement("div");
  if (cls) node.className = cls;
  if (html) node.innerHTML = html;
  for (const k of kids) node.appendChild(k);
  return node;
}

export function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}

/**
 * Paint a label with letter-by-letter shine (live activity rows).
 * OpenAI aliases use pink; other providers retain the existing blue effect.
 */
export function setShimmerText(el: HTMLElement | null, text: string, shimmer: boolean) {
  if (!el) return;
  const pinkOpenAi = !!el.closest("#chat.chat-sol");
  const toneClass = pinkOpenAi ? "shine-pink" : "shine-red";
  const animationName = pinkOpenAi ? "lightningFadeInOutPink" : "letterShineRed";
  const fallbackColor = pinkOpenAi ? "#ff75bb" : "#c44a44";
  if (!shimmer) {
    el.removeAttribute("data-shimmer");
    el.removeAttribute("aria-label");
    el.classList.remove("activity-shimmer", "shine-red", "shine-pink");
    el.textContent = text;
    return;
  }
  if (
    el.getAttribute("data-shimmer") === text &&
    el.classList.contains("activity-shimmer") &&
    el.classList.contains(toneClass) &&
    el.querySelector(`.shine-ch.${toneClass}`)
  ) {
    return;
  }
  el.setAttribute("data-shimmer", text);
  el.setAttribute("aria-label", text);
  el.classList.remove("shine-red", "shine-pink");
  el.classList.add("activity-shimmer", toneClass);
  const frag = document.createDocumentFragment();
  const chars = Array.from(text);
  const max = 120;
  for (let i = 0; i < chars.length; i++) {
    if (i >= max) {
      frag.appendChild(document.createTextNode(chars.slice(max).join("")));
      break;
    }
    const span = document.createElement("span");
    span.className = `shine-ch ${toneClass}`;
    span.style.setProperty("--i", String(i));
    // Inline fallback keeps the selected tone visible while WebView resolves CSS.
    span.style.animation = `${animationName} 1.25s ease-in-out ${i * 0.045}s infinite`;
    span.style.color = fallbackColor;
    span.textContent = chars[i] === " " ? "\u00A0" : chars[i];
    frag.appendChild(span);
  }
  el.replaceChildren(frag);
}

export function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** Short stamp under chat, e.g. "14 Jul · 23:06". */
export function formatChatTime(ms?: number | null): string {
  const d = new Date(ms && ms > 0 ? ms : Date.now());
  try {
    const day = d.getDate();
    const mon = d.toLocaleString(undefined, { month: "short" });
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${mon} · ${hh}:${mm}`;
  } catch {
    const iso = d.toISOString();
    return `${iso.slice(8, 10)} ${iso.slice(5, 7)} · ${iso.slice(11, 16)}`;
  }
}

/** Format token counts for the usage chip (e.g. 12400 → "12.4k"). */
export function formatTokens(n: number): string {
  if (!n || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** User-facing plan names: Pro · Pro+ · Max */
export function displayPlanLabel(plan: string): string {
  const p = (plan || "").trim().toLowerCase();
  if (p === "proplus" || p === "pro+" || p === "pro_plus") return "Pro+";
  if (p === "max20") return "Max 20×";
  if (p === "max10") return "Max 10×";
  if (p === "max5" || p === "max" || p === "ultra" || p === "agency") return "Max 5×";
  if (p === "pro" || p === "starter" || p === "fifteen" || p === "15day" || p === "15-day") {
    return "Pro";
  }
  if (!p) return "Plan";
  return p.charAt(0).toUpperCase() + p.slice(1);
}

type MarkdownTableAlignment = "left" | "center" | "right";

function isEscapedAt(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

/** Split a Markdown table row without treating escaped pipes as columns. */
function splitMarkdownTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !isEscapedAt(row, row.length - 1)) row = row.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "|" && !isEscapedAt(row, index)) {
      cells.push(cell);
      cell = "";
    } else {
      cell += row[index];
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim().replace(/\\\|/g, "|"));
}

function isMarkdownTableDivider(cells: string[]): boolean {
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function markdownTableAlignment(marker: string): MarkdownTableAlignment {
  const value = marker.trim();
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

/**
 * Converts standard Markdown tables into an accessible, scrollable table.
 * This is intentionally run after escaping user text, so table cells cannot
 * introduce raw HTML into the chat transcript.
 */
function renderMarkdownTables(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const headerLine = lines[index];
    const dividerLine = lines[index + 1];
    if (!headerLine.includes("|") || !dividerLine?.includes("|")) {
      output.push(headerLine);
      continue;
    }

    const headers = splitMarkdownTableRow(headerLine);
    const dividers = splitMarkdownTableRow(dividerLine);
    if (
      headers.length < 2 ||
      headers.length !== dividers.length ||
      !isMarkdownTableDivider(dividers)
    ) {
      output.push(headerLine);
      continue;
    }

    const hasOuterPipes = headerLine.trim().startsWith("|");
    const alignments = dividers.map(markdownTableAlignment);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const rowLine = lines[cursor];
      if (
        !rowLine.trim() ||
        !rowLine.includes("|") ||
        (hasOuterPipes && !rowLine.trim().startsWith("|"))
      ) {
        break;
      }
      const cells = splitMarkdownTableRow(rowLine);
      if (cells.length < 2) break;
      rows.push(headers.map((_header, cellIndex) => cells[cellIndex] || ""));
      cursor += 1;
    }

    const headerHtml = headers
      .map((header, cellIndex) => (
        `<th scope="col" data-align="${alignments[cellIndex]}">${header}</th>`
      ))
      .join("");
    const bodyHtml = rows
      .map((row) => `<tr>${row.map((cell, cellIndex) => `<td data-align="${alignments[cellIndex]}">${cell}</td>`).join("")}</tr>`)
      .join("");

    // Blank separators ensure surrounding prose still receives paragraph markup.
    output.push("");
    output.push(
      `<div class="md-table-wrap" role="region" aria-label="Response table" tabindex="0"><table class="md-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    );
    output.push("");
    index = cursor - 1;
  }

  return output.join("\n");
}

/**
 * Safe subset markdown → HTML.
 * Escapes all HTML first, then applies only controlled substitutions (no raw HTML passthrough).
 */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  // Extract fenced code blocks first (protect from other transforms)
  const fences: string[] = [];
  let text = src.replace(/```([\w-]*)\r?\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const i = fences.length;
    const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
    fences.push(`<pre class="md-code"><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000FENCE${i}\u0000`;
  });

  // Escape remaining text
  text = escapeHtml(text);

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, "<code class=\"md-inline\">$1</code>");

  // Bold / italic (order matters)
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");

  // Headings
  text = text.replace(/^######\s+(.+)$/gm, "<h6>$1</h6>");
  text = text.replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>");
  text = text.replace(/^####\s+(.+)$/gm, "<h4>$1</h4>");
  text = text.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  text = text.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  text = text.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Unordered lists (consecutive lines)
  text = text.replace(/(?:^[-*+] .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((line) => line.replace(/^[-*+] /, "").trim())
      .filter(Boolean)
      .map((item) => `<li>${item}</li>`)
      .join("");
    return `<ul class="md-list">${items}</ul>\n`;
  });

  // Ordered lists
  text = text.replace(/(?:^\d+\. .+(?:\n|$))+/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((line) => line.replace(/^\d+\. /, "").trim())
      .filter(Boolean)
      .map((item) => `<li>${item}</li>`)
      .join("");
    return `<ol class="md-list">${items}</ol>\n`;
  });

  // Links [text](https://...)
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer"><span class="md-link-ico" aria-hidden="true"></span>$1</a>',
  );

  // Bare URLs (after markdown links so we don't double-wrap)
  text = text.replace(
    /(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g,
    '$1<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer"><span class="md-link-ico" aria-hidden="true"></span>$2</a>',
  );

  // Tables must be converted before generic paragraph splitting.
  text = renderMarkdownTables(text);

  // Paragraphs / line breaks for remaining plain lines
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      if (/^<(h[1-6]|ul|ol|pre|blockquote|div|table)/.test(t)) return t;
      return `<p>${t.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  // Restore fences
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)] || "");

  return text;
}

/** Prefer a female system voice for the “done working” cue. */
function pickFemaleVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const scored = voices.map((v) => {
    const name = `${v.name} ${v.lang}`.toLowerCase();
    let score = 0;
    if (/female|woman|zira|samantha|susan|karen|moira|tessa|fiona|victoria|hazel|aria|jenny|sara|eva|linda|heather/.test(name)) {
      score += 5;
    }
    if (/en[-_]?(us|gb|au|ph)/i.test(v.lang) || /english/i.test(name)) score += 2;
    if (v.localService) score += 1;
    return { v, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].v : voices.find((v) => /en/i.test(v.lang)) || voices[0] || null;
}

let voicesReady = false;
function ensureVoices(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  if (window.speechSynthesis.getVoices().length) {
    voicesReady = true;
    return;
  }
  window.speechSynthesis.addEventListener(
    "voiceschanged",
    () => {
      voicesReady = true;
    },
    { once: true },
  );
}

/** Speak a short female “done working” cue when an agent run finishes. */
export function speakDoneWorking(): void {
  try {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    ensureVoices();
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance("done working");
    utter.rate = 1;
    utter.pitch = 1.05;
    utter.volume = 1;
    const voice = pickFemaleVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang || "en-US";
    } else {
      utter.lang = "en-US";
    }
    // If voices haven't loaded yet, retry once shortly after
    if (!voicesReady && !voice) {
      window.setTimeout(() => {
        const v2 = pickFemaleVoice();
        if (v2) utter.voice = v2;
        window.speechSynthesis.speak(utter);
      }, 120);
      return;
    }
    window.speechSynthesis.speak(utter);
  } catch {
    // Voice is a nicety — never break the UI
  }
}
