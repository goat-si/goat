// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 is deterministic, with no I/O or ambient state.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { ImportParsedItem, MemoryImportParser } from "./MemoryImportTypes.ts";

const validPayload = Schema.is(M.MemoryPayload);
const PROFILE = "omo-memory-core-beta63";
const bytes = (text: string) => new TextEncoder().encode(text).length;
const canonical = (text: string) => text.normalize("NFC").replace(/\r\n/g, "\n").trim();
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const allowed = /^(system|notes|people|reference|projects)\/.+\.md$/;
const safeSelector = (selector: string) =>
  selector === selector.trim() &&
  bytes(`${selector}#body`) <= 512 &&
  !/[\\:#]/.test(selector) &&
  !Array.from(selector).some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) &&
  selector
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");

/** Scan decoded aliases even when another header field will reject the item. */
const hasDecodedAliasSecret = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return false;
  const end = lines.indexOf("---", 1);
  for (const line of lines.slice(1, end < 0 ? undefined : end)) {
    const match = /^aliases:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    try {
      const decoded: unknown = JSON.parse(match[1]!);
      if (
        Array.isArray(decoded) &&
        decoded.some(
          (alias) =>
            typeof alias === "string" && scanMemoryValue(canonical(alias)).kind === "blocked",
        )
      )
        return true;
    } catch {
      // Syntax rejection belongs to header(); keep scanning subsequent fields.
    }
  }
  return false;
};

/** beta63 uses first-colon scalar fields, not general YAML or includes. */
const header = (text: string) => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  const fields = new Map<string, string>();
  let aliases: readonly string[] = [];
  for (const line of lines.slice(1, end)) {
    if (line.trim() === "") continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match || fields.has(match[1]!)) return undefined;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (key === "aliases") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return undefined;
      }
      if (!Array.isArray(parsed) || !parsed.every((alias) => typeof alias === "string"))
        return undefined;
      aliases = parsed.map(canonical);
    } else if (!value || /^[!&*[{>|]/.test(value)) {
      return undefined;
    }
    fields.set(key, value);
  }
  const description = fields.get("description");
  if (!description) return undefined;
  return {
    title: canonical(description),
    readOnly: fields.has("read_only") ? canonical(fields.get("read_only")!) : null,
    kind: fields.has("kind") ? canonical(fields.get("kind")!) : null,
    aliases,
    body: canonical(lines.slice(end + 1).join("\n")),
  };
};

/** Consume only the reader's pinned committed bytes; registration evidence belongs to L4. */
export const parseOmoMemory: MemoryImportParser = (input) =>
  Effect.gen(function* () {
    if (
      input.format !== "omo" ||
      input.slot.format !== "omo" ||
      input.profile !== PROFILE ||
      input.parserVersion !== PROFILE ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.commitOid ?? "")
    )
      return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "unsupported_format" }));
    if (scanMemoryValue(input.sourceLocator).kind === "blocked")
      return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "secret_detected" }));
    const seen = new Set<string>();
    let totalBytes = 0;
    // Preflight the entire snapshot so a later unsafe file cannot leak earlier rows.
    for (const file of input.files) {
      if (scanMemoryValue(file.selector).kind === "blocked")
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "secret_detected" }));
      if (!safeSelector(file.selector) || seen.has(file.selector))
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "path_rejected" }));
      seen.add(file.selector);
      if (!allowed.test(file.selector)) continue;
      if (file.text.includes("\0") || !file.text.isWellFormed())
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "invalid_utf8" }));
      const size = bytes(file.text);
      if (file.byteCount !== size)
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "source_changed" }));
      totalBytes += size;
      if (size > 256 * 1024 || totalBytes > 8 * 1024 * 1024)
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "limit_exceeded" }));
      if (
        scanMemoryValue(file.text).kind === "blocked" ||
        scanMemoryValue(canonical(file.text)).kind === "blocked" ||
        hasDecodedAliasSecret(file.text)
      )
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "secret_detected" }));
    }
    const files = input.files.filter((file) => allowed.test(file.selector));
    if (files.length > 128)
      return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "limit_exceeded" }));
    const items: ImportParsedItem[] = [];
    for (const file of [...files].sort((a, b) =>
      a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0,
    )) {
      const sourceItemKey = `${file.selector}#body`;
      const parsed = header(file.text);
      const reject = (issue: M.MemoryImportIssue) =>
        items.push({ kind: "rejected", sourceItemKey, byteCount: file.byteCount, issue });
      if (!parsed || !parsed.body) {
        reject("unsupported_format");
        continue;
      }
      if (
        Array.from(parsed.title).length > 256 ||
        bytes(parsed.body) > M.MEMORY_BODY_MAX_UTF8_BYTES
      ) {
        reject("limit_exceeded");
        continue;
      }
      const payload = { text: parsed.body, evidence: [], derivedFromMemoryRevisions: [] };
      if (scanMemoryValue(payload).kind === "blocked")
        return yield* Effect.fail(new M.MemoryImportRpcError({ issue: "secret_detected" }));
      if (!validPayload(payload)) {
        reject("limit_exceeded");
        continue;
      }
      items.push({
        kind: "candidate",
        candidate: {
          sourceItemKey,
          sourceFingerprint: hash(
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- fixed tuple serialization is the deterministic fingerprint preimage, not a trust-boundary codec.
            JSON.stringify([
              input.parserVersion,
              parsed.title,
              parsed.body,
              parsed.readOnly,
              parsed.kind,
              parsed.aliases,
            ]),
          ),
          contentFingerprint: hash(parsed.body),
          title: parsed.title,
          payload,
          byteCount: file.byteCount,
        },
      });
    }
    return items;
  });
