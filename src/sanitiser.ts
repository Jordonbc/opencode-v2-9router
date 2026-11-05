/**
 * Incremental sanitiser for OpenAI-compatible SSE responses.
 *
 * Removes only the nonstandard `usage.opencode` object from usage-only events
 * (events with no assistant choices). Assistant content, reasoning, tool calls,
 * finish reasons, event order, standard usage and `[DONE]` are preserved.
 */

const findSeparator = (
  buffer: string,
): { readonly index: number; readonly length: number } => {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return { index: -1, length: 0 };
  if (lf < 0) return { index: crlf, length: 4 };
  if (crlf < 0) return { index: lf, length: 2 };
  if (crlf < lf) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
};

const matchingBraceEnd = (text: string, start: number): number => {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i] as string;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const stripOpencodeProperty = (jsonText: string): string => {
  const key = "\"opencode\"";
  let searchFrom = 0;
  while (true) {
    const keyIndex = jsonText.indexOf(key, searchFrom);
    if (keyIndex < 0) return jsonText;
    // Confirm this occurrence is an object key.
    let cursor = keyIndex + key.length;
    while (cursor < jsonText.length && /\s/u.test(jsonText[cursor] as string)) cursor += 1;
    if (cursor >= jsonText.length || jsonText[cursor] !== ":") {
      searchFrom = keyIndex + key.length;
      continue;
    }
    cursor += 1;
    while (cursor < jsonText.length && /\s/u.test(jsonText[cursor] as string)) cursor += 1;
    if (cursor >= jsonText.length || jsonText[cursor] !== "{") {
      searchFrom = keyIndex + key.length;
      continue;
    }
    const end = matchingBraceEnd(jsonText, cursor);
    if (end < 0) return jsonText;

    const removeStart = keyIndex;
    const removeEnd = end + 1;

    // Prefer removing a preceding comma (and surrounding spaces).
    let left = removeStart - 1;
    while (left >= 0 && /\s/u.test(jsonText[left] as string)) left -= 1;
    if (left >= 0 && jsonText[left] === ",") {
      return jsonText.slice(0, left) + jsonText.slice(removeEnd);
    }
    // Otherwise remove a following comma (and surrounding spaces).
    let right = removeEnd;
    while (right < jsonText.length && /\s/u.test(jsonText[right] as string)) right += 1;
    if (right < jsonText.length && jsonText[right] === ",") {
      right += 1;
      while (right < jsonText.length && /\s/u.test(jsonText[right] as string)) right += 1;
      return jsonText.slice(0, removeStart) + jsonText.slice(right);
    }
    return jsonText.slice(0, removeStart) + jsonText.slice(removeEnd);
  }
};

const isUsageOnlyEvent = (value: unknown): boolean => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const usage = record.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  if (!Object.prototype.hasOwnProperty.call(usage, "opencode")) return false;
  const choices = record.choices;
  return !Array.isArray(choices) || choices.length === 0;
};

const sanitizeEvent = (eventText: string): string => {
  const separatorMatch = eventText.match(/(\r\n\r\n|\n\n|\r\r)$/u);
  const separator = separatorMatch ? separatorMatch[0] : "";
  const body = separator ? eventText.slice(0, -separator.length) : eventText;
  const lines = body.split("\n");
  const nextLines = lines.map((line) => {
    const match = line.match(/^data:(.*)$/u);
    if (!match) return line;
    const raw = match[1] as string;
    let prefix = "data:";
    let payload = raw;
    if (payload.startsWith(" ")) {
      prefix = "data: ";
      payload = payload.slice(1);
    }
    const trimmed = payload.trim();
    if (trimmed === "[DONE]") return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return line;
    }
    if (!isUsageOnlyEvent(parsed)) return line;
    // Preserve original spacing outside the removed property by editing the
    // original payload text rather than re-serialising.
    const strippedPayload = stripOpencodeProperty(payload);
    return `${prefix}${strippedPayload}`;
  });
  return nextLines.join("\n") + separator;
};

export const createSseSanitizer = (): {
  transform: (chunk: string) => string;
  flush: () => string;
} => {
  let buffer = "";
  return {
    transform(chunk: string): string {
      buffer += chunk;
      let output = "";
      while (true) {
        const separator = findSeparator(buffer);
        if (separator.index < 0) break;
        const eventText = buffer.slice(0, separator.index + separator.length);
        buffer = buffer.slice(separator.index + separator.length);
        output += sanitizeEvent(eventText);
      }
      return output;
    },
    flush(): string {
      const remaining = buffer;
      buffer = "";
      if (remaining.length === 0) return "";
      return sanitizeEvent(remaining);
    },
  };
};

export const sanitizeSse = (input: string): string => {
  const sanitizer = createSseSanitizer();
  return sanitizer.transform(input) + sanitizer.flush();
};

// Compatibility aliases.
export const sanitize = sanitizeSse;
export const sanitizeSseChunk = (chunk: string, sanitizer?: ReturnType<typeof createSseSanitizer>): string => {
  const instance = sanitizer ?? createSseSanitizer();
  return instance.transform(chunk);
};
export const createSanitizer = createSseSanitizer;
export const createResponseSanitizer = createSseSanitizer;
export const createResponseSanitiser = createSseSanitizer;
export const sanitizeResponse = sanitizeSse;
export const sanitizeResponseBody = sanitizeSse;
export const sanitizeResponseChunk = sanitizeSseChunk;

export class SseSanitizer {
  private readonly inner = createSseSanitizer();
  transform(chunk: string): string {
    return this.inner.transform(chunk);
  }
  flush(): string {
    return this.inner.flush();
  }
}

export { SseSanitizer as SseSanitizerClass, SseSanitizer as ResponseSanitizer, SseSanitizer as Sanitizer, SseSanitizer as ResponseSanitiser };
