import {
  LEGACY_CONTEXT_CLIPBOARD_ATTRIBUTE,
  GOAT_CONTEXT_CLIPBOARD_ATTRIBUTE,
  CONTEXT_CLIPBOARD_MIMES,
} from "@goat/contracts/legacyT3Names";
import { COMPOSER_CONTEXT_CLIPBOARD_MIME, ComposerContextClipboardFragment } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export { COMPOSER_CONTEXT_CLIPBOARD_MIME };

const MAX_FRAGMENT_CHARS = 16_000_000;
const decodeFragment = Schema.decodeUnknownOption(ComposerContextClipboardFragment);

export function encodeComposerContextFragment(
  fragment: ComposerContextClipboardFragment,
): string | null {
  const encoded = JSON.stringify(fragment);
  return encoded.length <= MAX_FRAGMENT_CHARS ? encoded : null;
}

const HTML_WRAPPER_SLACK_CHARS = 4096;

export function encodeComposerContextClipboardHtml(
  text: string,
  fragment: string,
  html?: string,
): string {
  if (html !== undefined)
    return `<div ${GOAT_CONTEXT_CLIPBOARD_ATTRIBUTE}="${encodeURIComponent(fragment)}">${html}</div>`;
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<pre ${GOAT_CONTEXT_CLIPBOARD_ATTRIBUTE}="${encodeURIComponent(fragment)}">${escaped}</pre>`;
}

export function decodeComposerContextClipboardHtml(
  html: string | null | undefined,
): ComposerContextClipboardFragment | null {
  // Percent encoding can expand each UTF-16 code unit to nine characters.
  if (!html || html.length > MAX_FRAGMENT_CHARS * 9 + HTML_WRAPPER_SLACK_CHARS) return null;
  const encoded = new RegExp(
    `(?:${LEGACY_CONTEXT_CLIPBOARD_ATTRIBUTE}|${GOAT_CONTEXT_CLIPBOARD_ATTRIBUTE})=["']([^"']+)["']`,
  ).exec(html)?.[1];
  if (!encoded) return null;
  try {
    return decodeComposerContextFragment(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

export function decodeComposerContextFragment(
  raw: string | null | undefined,
): ComposerContextClipboardFragment | null {
  if (!raw || raw.length > MAX_FRAGMENT_CHARS) return null;
  try {
    return Option.getOrNull(decodeFragment(JSON.parse(raw)));
  } catch {
    return null;
  }
}

/** Reads both peer spellings and browser custom-format MIME wrappers on paste. */
export function readComposerContextClipboardFragment(clipboardData: {
  getData: (type: string) => string;
}): ComposerContextClipboardFragment | null {
  for (const mime of CONTEXT_CLIPBOARD_MIMES) {
    const fragment = decodeComposerContextFragment(clipboardData.getData(mime));
    if (fragment !== null) return fragment;
  }
  return decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
}
