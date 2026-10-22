// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 is deterministic, with no I/O or ambient state.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { ImportParsedItem, MemoryImportParser } from "./MemoryImportTypes.ts";

export const ASIDE_SEMANTIC_PROFILE = "aside-semantic-v1";
const DIRECTORIES = new Set([
  "agent",
  "concepts",
  "projects",
  "sites",
  "people",
  "companies",
  "users",
]);
const validPayload = Schema.is(M.MemoryPayload);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const canonical = (text: string) => text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
const headingText = (text: string) => canonical(text).replace(/\s+/g, " ");
const H2 = /^ {0,3}##(?!#)(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const H3 = /^ {0,3}###(?!#)(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
// A backtick fence's info string cannot contain backticks, so ```code``` on one line is a span.
const FENCE = /^ {0,3}(\x60{3,}(?=[^\x60]*$)|~{3,})/;
const H1 = /^ {0,3}#(?!#)(?:[ \t]|$)/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;

type Section = { readonly heading: string | null; readonly body: string };
type Page = {
  readonly title: string | null;
  readonly host: string | null;
  readonly aliases: readonly string[];
  readonly sections: readonly Section[];
};

/** Only scalar `title`/`host` and a string-list `aliases` are read; other plain values are ignored. */
const frontmatter = (source: string) => {
  const doc = parseDocument(source, { uniqueKeys: true, version: "1.2" });
  if (doc.errors.length || doc.warnings.length) return undefined;
  if (doc.contents === null) return { title: null, host: null, aliases: [] };
  if (!isMap(doc.contents) || doc.contents.tag || doc.contents.anchor) return undefined;
  let title: string | null = null;
  let host: string | null = null;
  let aliases: string[] = [];
  const plain = (node: unknown) =>
    isScalar(node) && !node.tag && !node.anchor && typeof node.value !== "object";
  for (const pair of doc.contents.items) {
    if (!plain(pair.key) || !isScalar(pair.key) || typeof pair.key.value !== "string")
      return undefined;
    const key = pair.key.value;
    const value = pair.value;
    if (key === "title" || key === "host") {
      if (!isScalar(value) || !plain(value) || typeof value.value !== "string") return undefined;
      const text = headingText(value.value);
      if (!text) return undefined;
      if (key === "title") title = text;
      else host = text;
    } else if (key === "aliases") {
      if (!isSeq(value) || value.tag || value.anchor) return undefined;
      aliases = [];
      for (const item of value.items) {
        if (!isScalar(item) || !plain(item) || typeof item.value !== "string") return undefined;
        aliases.push(headingText(item.value));
      }
    } else if (
      value !== null &&
      !plain(value) &&
      !(isSeq(value) && !value.tag && !value.anchor && value.items.every(plain))
    )
      return undefined;
  }
  return { title, host, aliases };
};

/**
 * The first H2 must be `## Current`, and the next H2 (if any) must be `## History`. Headings
 * inside code fences are text. Anything else is ambiguous and the whole page is refused.
 */
const page = (text: string): Page | undefined => {
  const lines = text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  const meta = frontmatter(lines.slice(1, end).join("\n"));
  if (!meta) return undefined;
  let state: "before" | "current" | "history" = "before";
  let fence: { char: string; length: number } | null = null;
  const current: string[] = [];
  let previous = "";
  for (const line of lines.slice(end + 1)) {
    if (fence) {
      const close = FENCE.exec(line);
      if (
        close &&
        close[1]![0] === fence.char &&
        close[1]!.length >= fence.length &&
        line.trim() === close[1]
      )
        fence = null;
    } else {
      const open = FENCE.exec(line);
      if (open) fence = { char: open[1]![0]!, length: open[1]!.length };
      else {
        // Setext headings and an H1 inside Current would hide a section boundary; refuse them
        // rather than let later text (such as History) leak into the imported section.
        if (state !== "history" && SETEXT.test(line) && previous.trim() && !H2.test(previous))
          return undefined;
        if (state === "current" && H1.test(line)) return undefined;
        const h2 = H2.exec(line);
        if (h2) {
          const name = headingText(h2[1] ?? "");
          if (state === "before" && name === "Current") {
            state = "current";
            continue;
          }
          if (state === "current" && name === "History") {
            state = "history";
            continue;
          }
          if (state !== "history" || name === "Current" || name === "History") return undefined;
        }
      }
    }
    if (state === "current") current.push(line);
    previous = fence ? "" : line;
  }
  if (fence || state === "before") return undefined;
  const sections: Section[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;
  let body: string[] = [];
  let inner: { char: string; length: number } | null = null;
  const flush = () => {
    const text = canonical(body.join("\n"));
    if (text) sections.push({ heading, body: text });
  };
  for (const line of current) {
    const marker = FENCE.exec(line);
    if (inner) {
      if (
        marker &&
        marker[1]![0] === inner.char &&
        marker[1]!.length >= inner.length &&
        line.trim() === marker[1]
      )
        inner = null;
    } else if (marker) inner = { char: marker[1]![0]!, length: marker[1]!.length };
    else {
      const h3 = H3.exec(line);
      if (h3) {
        flush();
        const name = headingText(h3[1] ?? "");
        if (!name || seen.has(name)) return undefined;
        seen.add(name);
        heading = name;
        body = [];
        continue;
      }
    }
    body.push(line);
  }
  flush();
  if (!sections.length) return undefined;
  return { ...meta, sections };
};

/** Pure snapshot -> rows for one Aside semantic directory. Evidence is attached by L4. */
export const parseAsideMemory: MemoryImportParser = Effect.fn("AsideMemoryImporter.parse")(
  function* (input) {
    const at = input.slot.selection?.lastIndexOf(":") ?? -1;
    const directory = input.slot.selection?.slice(at + 1) ?? "";
    if (
      input.format !== "aside" ||
      input.slot.format !== "aside" ||
      input.profile !== ASIDE_SEMANTIC_PROFILE ||
      input.parserVersion !== ASIDE_SEMANTIC_PROFILE ||
      at < 1 ||
      !DIRECTORIES.has(directory)
    )
      return yield* new M.MemoryImportRpcError({ issue: "unsupported_format" });
    if (scanMemoryValue(input.sourceLocator).kind === "blocked")
      return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
    const seen = new Set<string>();
    let totalBytes = 0;
    // Preflight the whole snapshot so an unsafe later file cannot leak earlier rows.
    for (const file of input.files) {
      if (
        !file.selector.endsWith(".md") ||
        file.selector !== file.selector.trim() ||
        /[/\\]/.test(file.selector) ||
        Array.from(file.selector).some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127) ||
        seen.has(file.selector)
      )
        return yield* new M.MemoryImportRpcError({ issue: "path_rejected" });
      seen.add(file.selector);
      if (scanMemoryValue(file.selector).kind === "blocked")
        return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
      if (file.issue) continue;
      if (!file.text.isWellFormed() || file.text.includes("\0"))
        return yield* new M.MemoryImportRpcError({ issue: "invalid_utf8" });
      const size = bytes(file.text);
      if (size !== file.byteCount)
        return yield* new M.MemoryImportRpcError({ issue: "source_changed" });
      totalBytes += size;
      if (size > 256 * 1024 || totalBytes > M.MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES)
        return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
    }
    // projects/ pages describe one project; they import only into an explicit project binding.
    const requiresProject = directory === "projects" ? { requiresProject: true } : {};
    const rows: ImportParsedItem[] = [];
    for (const file of [...input.files].sort((a, b) =>
      a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0,
    )) {
      const pageKey = `${directory}/${file.selector}#current`;
      const reject = (
        issue: M.MemoryImportIssue,
        sourceItemKey = pageKey,
        byteCount = file.byteCount,
      ) => rows.push({ kind: "rejected", sourceItemKey, byteCount, issue, ...requiresProject });
      if (bytes(pageKey) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES)
        return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
      if (file.issue) {
        reject(file.issue);
        continue;
      }
      if (scanMemoryValue(file.text).kind === "blocked") {
        reject("secret_detected");
        continue;
      }
      const parsed = page(file.text);
      if (!parsed) {
        reject("unsupported_format");
        continue;
      }
      const keyed = parsed.sections.map((section) => ({
        ...section,
        sourceItemKey: section.heading === null ? pageKey : `${pageKey}:${section.heading}`,
      }));
      if (keyed.some((s) => bytes(s.sourceItemKey) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES)) {
        reject("limit_exceeded");
        continue;
      }
      const pageTitle = parsed.title ?? file.selector.slice(0, -3);
      for (const section of keyed) {
        const label = section.heading === null ? pageTitle : `${pageTitle} — ${section.heading}`;
        const text = `${label}\n\n${section.body}`;
        const payload = { text, evidence: [], derivedFromMemoryRevisions: [] };
        if (bytes(text) > M.MEMORY_BODY_MAX_UTF8_BYTES || !validPayload(payload)) {
          reject("limit_exceeded", section.sourceItemKey, bytes(text));
          continue;
        }
        rows.push({
          kind: "candidate",
          candidate: {
            sourceItemKey: section.sourceItemKey,
            sourceFingerprint: hash(
              // @effect-diagnostics-next-line preferSchemaOverJson:off -- fixed tuple serialization is the deterministic fingerprint preimage, not a trust-boundary codec.
              JSON.stringify([
                input.parserVersion,
                pageTitle,
                parsed.host,
                parsed.aliases,
                section.heading,
                section.body,
              ]),
            ),
            // Body only: a forgotten statement stays suppressed after its H3 or page is renamed.
            contentFingerprint: hash(section.body),
            ...(Array.from(label).length <= 256 ? { title: label } : {}),
            payload,
            byteCount: bytes(text),
            ...requiresProject,
          },
        });
      }
    }
    if (rows.length > M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS)
      return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
    return rows;
  },
);
