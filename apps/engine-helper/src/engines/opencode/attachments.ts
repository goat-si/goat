import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2";
import type { EngineInput } from "../../protocol.ts";

// Adapted from provider-opencode/openCodeFileParts.ts and provider-core/attachmentPrompt.ts.
const NATIVE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/pdf"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function promptParts(inputs: ReadonlyArray<EngineInput>, preamble?: string | null): Array<TextPartInput | FilePartInput> {
  const message = inputs.map((input) => input.text).filter(Boolean).join("\n");
  const text = [preamble, message].filter(Boolean) as string[];
  const files: FilePartInput[] = [];
  for (const input of inputs) for (const attachment of input.attachments) {
    const path = attachment.path && isAbsolute(attachment.path) ? attachment.path : null;
    text.push(path
      ? `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`
      : `[Attached ${attachment.type} "${attachment.name}" is unavailable: could not resolve a saved path for attachment '${attachment.id}'.]`);
    if (path && attachment.sizeBytes <= MAX_FILE_BYTES && NATIVE_MIMES.has(attachment.mimeType.trim().toLowerCase())) {
      files.push({ type: "file", mime: attachment.mimeType, filename: attachment.name, url: pathToFileURL(path).href });
    }
  }
  const value = text.join("\n\n").trim();
  return [...(value ? [{ type: "text" as const, text: value }] : []), ...files];
}
