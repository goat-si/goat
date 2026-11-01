// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 is deterministic pure computation, with no runtime service or I/O.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { ImportParsedItem, MemoryImportParser } from "./MemoryImportTypes.ts";

const FILE_MAX_BYTES = 256 * 1024;
const TITLE_MAX_CODE_POINTS = 256;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const canonical = (s: string) => s.normalize("NFC").replace(/\r\n/g, "\n").trim();
const hash = (s: string) => NodeCrypto.createHash("sha256").update(s).digest("hex");
const secret = (s: string) => scanMemoryValue(s).kind === "blocked";
const control = (s: string) =>
  [...s].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127);
const safeSelector = (s: string) =>
  s.length > 0 &&
  bytes(s) <= M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES &&
  !control(s) &&
  !/[\\:]/u.test(s) &&
  s.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const transcriptEnvelope = (line: string) => {
  if (!line.trimStart().startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(line);
    return (
      value !== null &&
      typeof value === "object" &&
      (("type" in value &&
        typeof value.type === "string" &&
        ("payload" in value ||
          ["session_meta", "event_msg", "response_item", "turn_context"].includes(value.type))) ||
        ("role" in value && "content" in value))
    );
  } catch {
    return false;
  }
};
const noteSelector = (s: string) => /^extensions\/ad_hoc\/notes\/[^/]+\.md$/u.test(s);

/** Only the two 050 §2 grammars; source registration and import evidence belong to L4. */
export const parseCodexMemory: MemoryImportParser = (input) =>
  Effect.gen(function* () {
    const fail = (issue: M.MemoryImportIssue) => Effect.fail(new M.MemoryImportRpcError({ issue }));
    if (
      input.format !== "codex" ||
      input.slot.format !== "codex" ||
      !["codex-handbook-v1", "codex-ad-hoc-v1"].includes(input.profile) ||
      input.parserVersion !== input.profile
    )
      return yield* fail("unsupported_format");
    if (secret(input.sourceLocator) || secret(input.parserVersion))
      return yield* fail("secret_detected");
    const items: ImportParsedItem[] = [];
    const selectors = new Set<string>();
    let totalBytes = 0;
    for (const file of input.files) {
      if (!safeSelector(file.selector)) return yield* fail("path_rejected");
      if (secret(file.selector)) return yield* fail("secret_detected");
      const allowed =
        input.profile === "codex-handbook-v1"
          ? file.selector === "MEMORY.md"
          : noteSelector(file.selector) && !file.selector.endsWith("/instructions.md");
      if (!allowed) continue;
      if (selectors.has(file.selector)) return yield* fail("unsupported_format");
      selectors.add(file.selector);
      const size = bytes(file.text);
      totalBytes += size;
      if (size > FILE_MAX_BYTES || totalBytes > M.MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES)
        return yield* fail("limit_exceeded");
      if (size !== file.byteCount) return yield* fail("source_changed");
      // A snapshot has strings, not undecoded bytes. Reject unpaired UTF-16 surrogates;
      // a legitimate U+FFFD cannot be distinguished from reader replacement here.
      if (
        file.text.includes(String.fromCharCode(0)) ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(file.text)
      )
        return yield* fail("invalid_utf8");
      if (secret(file.text)) return yield* fail("secret_detected");
      const add = (
        key: string,
        body: string,
        title?: string,
        metadata: readonly string[] = [],
        malformed = false,
      ) => {
        if (items.length >= M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS) return "limit_exceeded" as const;
        const text = canonical(body);
        const byteCount = bytes(text);
        if (secret(key) || (title !== undefined && secret(title)) || secret(text))
          return "secret_detected" as const;
        if (bytes(key) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES || control(key))
          return "path_rejected" as const;
        const payload = { text, evidence: [], derivedFromMemoryRevisions: [] };
        const issue =
          bytes(JSON.stringify(payload)) > M.MEMORY_PAYLOAD_MAX_UTF8_BYTES ||
          byteCount > M.MEMORY_BODY_MAX_UTF8_BYTES ||
          (title !== undefined && [...title].length > TITLE_MAX_CODE_POINTS)
            ? "limit_exceeded"
            : malformed || text.length === 0
              ? "unsupported_format"
              : undefined;
        if (issue) items.push({ kind: "rejected", sourceItemKey: key, byteCount, issue });
        else
          items.push({
            kind: "candidate",
            candidate: {
              sourceItemKey: key,
              sourceFingerprint: hash(
                JSON.stringify([input.parserVersion, title ?? null, text, metadata]),
              ),
              contentFingerprint: hash(text),
              ...(title === undefined ? {} : { title }),
              payload,
              byteCount,
            },
          });
        return undefined;
      };
      if (input.profile === "codex-ad-hoc-v1") {
        // JSON/JSONL transcript envelopes are never Markdown-note fallback inputs.
        if (file.text.split(/\r?\n/u).some(transcriptEnvelope))
          return yield* fail("unsupported_format");
        const issue = add(`${file.selector}#body`, file.text);
        if (issue) return yield* fail(issue);
      } else {
        let group:
          | { title: string; body: string[]; scope?: string; routing?: string; malformed: boolean }
          | undefined;
        const titles = new Set<string>();
        let fence: { char: string; length: number } | undefined;
        let omitSection = false;
        const flush = () =>
          group === undefined
            ? undefined
            : add(
                `MEMORY.md#task-group:${group.title}`,
                group.body.join("\n"),
                group.title,
                [group.scope ?? "", group.routing ?? ""],
                group.malformed || !group.scope,
              );
        for (const line of file.text.replace(/\r\n/g, "\n").split("\n")) {
          const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
          if (fence) {
            if (group && !omitSection) group.body.push(line);
            if (
              marker &&
              marker[1]![0] === fence.char &&
              marker[1]!.length >= fence.length &&
              marker[2]!.trim() === ""
            )
              fence = undefined;
            continue;
          }
          if (marker) {
            fence = { char: marker[1]![0]!, length: marker[1]!.length };
            if (group && !omitSection) group.body.push(line);
            continue;
          }
          const heading = /^# Task Group: (.+)$/u.exec(line);
          if (heading) {
            const issue = flush();
            if (issue) return yield* fail(issue);
            const title = canonical(heading[1]!);
            if (titles.has(title)) return yield* fail("unsupported_format");
            titles.add(title);
            group = { title, body: [], malformed: title.length === 0 };
            omitSection = false;
            continue;
          }
          if (!group) {
            if (line.trim() !== "") return yield* fail("unsupported_format");
            continue;
          }
          if (line.startsWith("scope:")) {
            if (group.scope !== undefined) group.malformed = true;
            group.scope = canonical(line.slice(6));
            continue;
          }
          if (line.startsWith("applies_to:")) {
            if (group.routing !== undefined) group.malformed = true;
            group.routing = canonical(line.slice(11));
            if (!/^cwd=.+; reuse_rule=.+$/u.test(group.routing)) group.malformed = true;
            continue;
          }
          const section = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
          if (section) {
            if (section[1]!.length <= 3)
              omitSection = section[2] === "rollout_summary_files" || section[2] === "keywords";
          }
          if (!omitSection) group.body.push(line);
        }
        const issue = flush();
        if (issue) return yield* fail(issue);
        if (titles.size === 0 || fence) return yield* fail("unsupported_format");
      }
      if (items.length > M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS) return yield* fail("limit_exceeded");
    }
    return items;
  });
