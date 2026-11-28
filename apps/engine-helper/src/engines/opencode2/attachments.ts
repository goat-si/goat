import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineInput } from "../../protocol.ts";

const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Builds the same prompt payload for start and steer. Set external for a remote server. */
export async function buildOpenCode2Prompt(
  inputs: ReadonlyArray<EngineInput>,
  preamble?: string | null,
  options: {
    readonly external?: boolean;
    readonly exists?: (path: string) => Promise<boolean>;
  } = {},
): Promise<{ text: string; files: Array<{ uri: string; name: string }> }> {
  const message = inputs.map((input) => input.text).filter(Boolean).join("\n");
  const text = [preamble, message].filter((part): part is string => Boolean(part));
  const files: Array<{ uri: string; name: string }> = [];
  for (const input of inputs) for (const attachment of input.attachments) {
    const path = attachment.path && isAbsolute(attachment.path) ? attachment.path : null;
    text.push(path
      ? `[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`
      : `[Attached ${attachment.type} "${attachment.name}" is unavailable: could not resolve a saved path for attachment '${attachment.id}'.]`);
    if (options.external || !path || attachment.type !== "image" || !IMAGE_MIMES.has(attachment.mimeType.toLowerCase())) continue;
    let exists = false;
    try {
      exists = await (options.exists ?? fileExists)(path);
    } catch {
      // A failed existence check is equivalent to an unavailable native file.
    }
    if (exists) files.push({ uri: pathToFileURL(path).href, name: attachment.name });
  }
  return { text: text.join("\n\n").trim(), files };
}
