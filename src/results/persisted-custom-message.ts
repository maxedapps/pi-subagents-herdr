import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface PersistedCustomMessage {
  readonly entryId: string;
  readonly customType: string;
  readonly text: string;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("");
}

export function extractPersistedCustomMessage(entry: SessionEntry): PersistedCustomMessage | undefined {
  if (entry.type !== "custom_message") return undefined;
  if (typeof entry.id !== "string" || entry.id.length === 0 || typeof entry.customType !== "string") return undefined;
  const text = contentText(entry.content);
  return text === undefined ? undefined : { entryId: entry.id, customType: entry.customType, text };
}
