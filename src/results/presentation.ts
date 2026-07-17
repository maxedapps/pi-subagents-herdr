import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MODEL_VISIBLE_BYTE_LIMIT, sha256Text } from "./contracts.ts";

export interface ExactRenderDetails<T> {
  readonly deliveredText: string;
  readonly result: T;
}

export interface BoundUtf8Result {
  readonly text: string;
  readonly truncated: boolean;
  readonly omittedBytes: number;
  readonly fullSha256: string;
}

const COLLAPSED_PREVIEW_BYTES = 240;
const COLLAPSED_PREVIEW_LINES = 3;

/** Decode a byte range that starts/ends on UTF-8 codepoint boundaries. */
function utf8SafeSlice(bytes: Buffer, start: number, end: number): string {
  let from = Math.max(0, Math.min(start, bytes.length));
  let to = Math.max(from, Math.min(end, bytes.length));
  // Advance start past any continuation bytes.
  while (from < to && (bytes[from]! & 0b1100_0000) === 0b1000_0000) from += 1;
  // Retreat end so we never split a multi-byte sequence.
  while (to > from) {
    const b = bytes[to - 1]!;
    if ((b & 0b1000_0000) === 0) break; // ASCII
    // Walk back to the lead byte of this sequence.
    let lead = to - 1;
    while (lead > from && (bytes[lead]! & 0b1100_0000) === 0b1000_0000) lead -= 1;
    const leadByte = bytes[lead]!;
    const expected =
      (leadByte & 0b1111_1000) === 0b1111_0000 ? 4
        : (leadByte & 0b1111_0000) === 0b1110_0000 ? 3
          : (leadByte & 0b1110_0000) === 0b1100_0000 ? 2
            : 1;
    if (to - lead >= expected && (leadByte & 0b1100_0000) !== 0b1000_0000) break;
    to = lead;
  }
  return bytes.subarray(from, to).toString("utf8");
}

/** Bound UTF-8 text while preserving both beginning and conclusion when truncated. */
export function boundUtf8HeadTail(text: string, maxBytes = MODEL_VISIBLE_BYTE_LIMIT): BoundUtf8Result {
  const fullSha256 = sha256Text(text);
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) {
    return { text, truncated: false, omittedBytes: 0, fullSha256 };
  }
  const bytes = Buffer.from(text, "utf8");
  const build = (headLen: number, tailLen: number): BoundUtf8Result => {
    const head = utf8SafeSlice(bytes, 0, headLen);
    const tail = tailLen > 0 ? utf8SafeSlice(bytes, Math.max(0, total - tailLen), total) : "";
    const used = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    const omittedBytes = Math.max(0, total - used);
    const marker = `\n[... truncated; omitted=${omittedBytes} bytes; full SHA-256: ${fullSha256}]\n`;
    const combined = `${head}${marker}${tail}`;
    return { text: combined, truncated: true, omittedBytes, fullSha256 };
  };

  // Prefer head+tail; shrink until the combined payload fits.
  let headBudget = Math.floor(maxBytes * 0.55);
  let tailBudget = Math.floor(maxBytes * 0.30);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = build(headBudget, tailBudget);
    if (Buffer.byteLength(candidate.text, "utf8") <= maxBytes) return candidate;
    headBudget = Math.floor(headBudget * 0.75);
    tailBudget = Math.floor(tailBudget * 0.75);
  }
  // Head-only shrink when head+tail cannot fit.
  let headOnly = Math.floor(maxBytes * 0.7);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = build(headOnly, 0);
    if (Buffer.byteLength(candidate.text, "utf8") <= maxBytes) return candidate;
    headOnly = Math.floor(headOnly * 0.7);
  }
  const marker = `\n[... truncated; full SHA-256: ${fullSha256}]\n`;
  const hard = utf8SafeSlice(bytes, 0, Math.max(1, maxBytes - Buffer.byteLength(marker, "utf8")));
  return {
    text: `${hard}${marker}`,
    truncated: true,
    omittedBytes: Math.max(0, total - Buffer.byteLength(hard, "utf8")),
    fullSha256,
  };
}

export function collapsedPreview(deliveredText: string, maxBytes = COLLAPSED_PREVIEW_BYTES, maxLines = COLLAPSED_PREVIEW_LINES): string {
  const lines = deliveredText.split("\n");
  let candidate = lines.slice(0, maxLines).join("\n");
  if (lines.length > maxLines) candidate = `${candidate}\n…`;
  if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
    return candidate === deliveredText ? candidate : `${candidate}${candidate.endsWith("…") ? "" : "…"}`;
  }
  const bytes = Buffer.from(candidate, "utf8");
  const head = utf8SafeSlice(bytes, 0, Math.max(1, maxBytes - 3));
  return `${head}…`;
}

export function resultCollapsedPreview(deliveredText: string, expansionHint = "Ctrl+O"): string {
  const lines = deliveredText.split("\n");
  if (!lines[0]?.startsWith("HERDR_RESULT_V1 ")) return collapsedPreview(deliveredText);
  const bodyStart = lines.indexOf("") + 1;
  const bodyLines = bodyStart > 0 ? lines.slice(bodyStart) : [];
  const actionStart = bodyLines.findIndex((line) => line.startsWith("HERDR_ACTION_REQUIRED_V1 "));
  const bodyLine = (actionStart < 0 ? bodyLines : bodyLines.slice(0, actionStart))
    .find((line) => line.trim().length > 0);
  const preview = bodyLine === undefined ? "No child result text" : collapsedPreview(bodyLine.trim(), 180, 1);
  return `Result received · ${preview}\n${expansionHint} to expand`;
}

export function actionCollapsedPreview(deliveredText: string, expansionHint = "Ctrl+O"): string {
  const lines = deliveredText.split("\n");
  const headline = lines.find((line) => line.startsWith("ACTION REQUIRED")) ?? "ACTION REQUIRED";
  const reason = lines.find((line) => line.startsWith("reason="));
  return [headline, ...(reason === undefined ? [] : [collapsedPreview(reason, 180, 1)]), `${expansionHint} to expand`].join("\n");
}

export function exactToolPayload<T>(result: T, serialize: (value: T) => string): {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: ExactRenderDetails<T>;
} {
  const deliveredText = serialize(result);
  return {
    content: [{ type: "text", text: deliveredText }],
    details: { deliveredText, result },
  };
}

export function renderExactDeliveredText(
  deliveredText: string,
  expanded: boolean,
  theme: Theme,
  collapsedPrefix?: string,
): Component {
  if (!expanded) {
    const preview = collapsedPreview(deliveredText);
    const line = collapsedPrefix ? `${collapsedPrefix} ${preview}` : preview;
    return new Text(theme.fg("muted", line), 0, 0);
  }
  return new Text(deliveredText, 0, 0);
}

export function extractDeliveredText(details: unknown): string | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as Record<string, unknown>;
  if (typeof value.deliveredText === "string") return value.deliveredText;
  return undefined;
}
