export type ToolArgField = "path" | "content" | "old_string" | "new_string";

const TRACKED_FIELDS = new Set<ToolArgField>([
  "path",
  "content",
  "old_string",
  "new_string",
]);
const PATH_PREVIEW_LIMIT = 2_048;
const CONTENT_PREVIEW_LIMIT = 65_536;

type StringRole = "key" | "value" | "other" | null;

/**
 * Incrementally decodes selected top-level JSON string fields from streamed
 * tool arguments. It never treats the partial JSON as executable/valid input;
 * the backend still owns final parsing and tool execution.
 */
export class ToolArgsStreamDecoder {
  private depth = 0;
  private expectingKey = false;
  private inString = false;
  private stringRole: StringRole = null;
  private keyBuffer = "";
  private pendingKey: string | null = null;
  private activeValueKey: ToolArgField | null = null;
  private escaped = false;
  private unicodeDigits: string | null = null;
  private readonly present = new Set<ToolArgField>();
  private readonly values = new Map<ToolArgField, string>();
  private readonly totals = new Map<ToolArgField, number>();
  private readonly truncated = new Set<ToolArgField>();

  append(delta: string) {
    if (!delta) return;
    const decoded = new Map<ToolArgField, string>();
    for (const char of delta) {
      this.consume(char, decoded);
    }
    for (const [field, chunk] of decoded) {
      if (!chunk) continue;
      const limit = field === "path" ? PATH_PREVIEW_LIMIT : CONTENT_PREVIEW_LIMIT;
      const previous = this.values.get(field) ?? "";
      const combined = previous + chunk;
      this.totals.set(field, (this.totals.get(field) ?? 0) + chunk.length);
      if (combined.length > limit) {
        this.values.set(field, combined.slice(-limit));
        this.truncated.add(field);
      } else {
        this.values.set(field, combined);
      }
    }
  }

  has(field: ToolArgField): boolean {
    return this.present.has(field);
  }

  value(field: ToolArgField): string | undefined {
    return this.present.has(field) ? (this.values.get(field) ?? "") : undefined;
  }

  total(field: ToolArgField): number {
    return this.totals.get(field) ?? 0;
  }

  isTruncated(field: ToolArgField): boolean {
    return this.truncated.has(field);
  }

  private consume(char: string, decoded: Map<ToolArgField, string>) {
    if (this.inString) {
      this.consumeString(char, decoded);
      return;
    }

    if (char === "{") {
      this.depth += 1;
      if (this.depth === 1) this.expectingKey = true;
      return;
    }
    if (char === "}") {
      if (this.depth === 1) {
        this.expectingKey = false;
        this.pendingKey = null;
      }
      this.depth = Math.max(0, this.depth - 1);
      return;
    }
    if (this.depth !== 1) return;

    if (char === ",") {
      this.expectingKey = true;
      this.pendingKey = null;
      return;
    }
    if (char === '"') {
      this.inString = true;
      this.escaped = false;
      this.unicodeDigits = null;
      if (this.expectingKey) {
        this.stringRole = "key";
        this.keyBuffer = "";
      } else if (this.pendingKey) {
        this.stringRole = "value";
        const key = this.pendingKey as ToolArgField;
        this.activeValueKey = TRACKED_FIELDS.has(key) ? key : null;
        if (this.activeValueKey) {
          this.present.add(this.activeValueKey);
          if (!this.values.has(this.activeValueKey)) {
            this.values.set(this.activeValueKey, "");
          }
        }
      } else {
        this.stringRole = "other";
      }
    }
  }

  private consumeString(char: string, decoded: Map<ToolArgField, string>) {
    if (this.unicodeDigits !== null) {
      this.unicodeDigits += char;
      if (this.unicodeDigits.length === 4) {
        const code = Number.parseInt(this.unicodeDigits, 16);
        this.appendDecoded(
          Number.isNaN(code) ? `\\u${this.unicodeDigits}` : String.fromCharCode(code),
          decoded,
        );
        this.unicodeDigits = null;
      }
      return;
    }

    if (this.escaped) {
      this.escaped = false;
      if (char === "u") {
        this.unicodeDigits = "";
        return;
      }
      const escaped = ({
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      } as Record<string, string>)[char] ?? char;
      this.appendDecoded(escaped, decoded);
      return;
    }

    if (char === "\\") {
      this.escaped = true;
      return;
    }
    if (char !== '"') {
      this.appendDecoded(char, decoded);
      return;
    }

    this.inString = false;
    if (this.stringRole === "key") {
      this.pendingKey = this.keyBuffer;
      this.expectingKey = false;
    } else if (this.stringRole === "value") {
      this.pendingKey = null;
      this.activeValueKey = null;
    }
    this.stringRole = null;
  }

  private appendDecoded(char: string, decoded: Map<ToolArgField, string>) {
    if (this.stringRole === "key") {
      this.keyBuffer += char;
      return;
    }
    if (this.stringRole !== "value" || !this.activeValueKey) return;
    decoded.set(this.activeValueKey, (decoded.get(this.activeValueKey) ?? "") + char);
  }
}
