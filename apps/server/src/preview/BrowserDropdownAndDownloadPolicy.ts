/**
 * Ported from browser-use's default_action_watchdog.py (special-element click guard, native select
 * revert check) and downloads_watchdog.py (network download classification). Upstream lowercases
 * Content-Disposition before reading the filename and keeps filename* raw; here both are fixed.
 */

const DOWNLOAD_FILE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "csv",
  "tsv",
  "txt",
  "json",
  "xml",
  "zip",
  "gz",
  "tar",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
]);

const GENERIC_TEXT_ATTACHMENT_STEMS = new Set(["f", "download", "response", "data", "callback"]);
const GENERIC_TEXT_ATTACHMENT_EXTENSIONS = new Set(["", "txt", "json"]);
const GENERIC_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "application/json",
  "text/javascript",
  "application/javascript",
]);

const refLabel = (selectorIndex: string | number | undefined) =>
  selectorIndex === undefined ? "" : " (ref " + String(selectorIndex) + ")";

export const checkSpecialElementClickGuard = (input: {
  readonly tagName: string;
  readonly inputType?: string | undefined;
  readonly selectorIndex?: string | number | undefined;
}) => {
  const tagName = input.tagName.trim().toLowerCase();
  const ref = refLabel(input.selectorIndex);
  if (tagName === "select")
    return {
      ok: false,
      reason: "select_element",
      message:
        "Cannot click a <select>" +
        ref +
        ". Choose its option with goat_preview_select instead. Nothing was clicked.",
      nothingSent: true,
    } as const;
  if (tagName === "input" && input.inputType?.trim().toLowerCase() === "file")
    return {
      ok: false,
      reason: "file_input",
      message:
        "Cannot click a file input" +
        ref +
        ". Supply its files with goat_preview_upload (tab.upload in screen code) instead. Nothing was clicked.",
      nothingSent: true,
    } as const;
  return { ok: true } as const;
};

/**
 * Checks a single, non-clearing native select after its value was set and input/change fired.
 * requestedValue is the resolved option value, not its label. Input was already sent on failure.
 */
export const verifySelectOptionStickiness = (input: {
  readonly requestedValue: string;
  readonly observedValue: string;
  readonly observedSelectedIndex: number;
}) => {
  const { requestedValue, observedValue, observedSelectedIndex } = input;
  if (
    observedValue === requestedValue &&
    Number.isInteger(observedSelectedIndex) &&
    observedSelectedIndex >= 0
  )
    return { ok: true } as const;
  return {
    ok: false,
    reason: "select_value_reverted",
    message:
      "The page changed this <select> back after it was set: it now holds " +
      JSON.stringify(observedValue) +
      " instead of " +
      JSON.stringify(requestedValue) +
      ". Input was sent; read the page before trying again.",
    requestedValue,
    observedValue,
  } as const;
};

type DispositionParameters = { readonly type: string; readonly params: Map<string, string> };

const parseContentDisposition = (header: string): DispositionParameters => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < header.length; index++) {
    const char = header.charAt(index);
    if (quoted && char === "\\" && index + 1 < header.length) {
      current += header.charAt(++index);
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    if (name && !params.has(name)) params.set(name, part.slice(equals + 1).trim());
  }
  return { type: (parts[0] ?? "").trim().toLowerCase(), params };
};

/** RFC 8187: recipients must support UTF-8; other charsets fall back to filename=. */
const decodeExtendedValue = (value: string) => {
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match || match[1]?.toLowerCase() !== "utf-8") return undefined;
  try {
    return decodeURIComponent(match[2] ?? "");
  } catch {
    return undefined;
  }
};

/** Drops directory parts; callers still own filesystem-safe naming. */
const baseName = (value: string | null | undefined) => {
  const name = value?.split(/[/\\]/).pop()?.trim();
  return name ? name : undefined;
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const stemOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
};

const isGenericTextAttachment = (url: URL, mime: string, filename: string | undefined): boolean => {
  if (!GENERIC_TEXT_MIME_TYPES.has(mime) || !filename) return false;
  const pathName = baseName(url.pathname) ?? "";
  if (DOWNLOAD_FILE_EXTENSIONS.has(extensionOf(pathName))) return false;
  return (
    GENERIC_TEXT_ATTACHMENT_STEMS.has(stemOf(filename)) &&
    GENERIC_TEXT_ATTACHMENT_EXTENSIONS.has(extensionOf(filename))
  );
};

const parseHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Decides whether a top-level network response is a file download. The caller still skips
 * Fetch/XHR requests, which upstream filters before this point.
 */
export const classifyNetworkDownloadCandidate = (input: {
  readonly url: string;
  readonly contentType: string;
  readonly contentDisposition?: string | null | undefined;
  readonly suggestedFilename?: string | null | undefined;
}) => {
  const url = parseHttpUrl(input.url);
  if (!url) return { download: false, reason: "not_http" } as const;
  const mime = (input.contentType.split(";")[0] ?? "").trim().toLowerCase();
  const disposition = parseContentDisposition(input.contentDisposition ?? "");
  const extended = disposition.params.get("filename*");
  const plain = disposition.params.get("filename");
  const filename =
    baseName(extended === undefined ? undefined : decodeExtendedValue(extended)) ??
    baseName(plain) ??
    baseName(input.suggestedFilename) ??
    null;
  if (mime === "application/pdf") return { download: true, reason: "pdf", filename } as const;
  if (disposition.type !== "attachment")
    return { download: false, reason: "not_attachment" } as const;
  if (isGenericTextAttachment(url, mime, filename ?? undefined))
    return { download: false, reason: "generic_text_attachment" } as const;
  return { download: true, reason: "attachment", filename } as const;
};
