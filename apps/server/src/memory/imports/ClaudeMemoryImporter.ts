import * as M from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- deterministic SHA-256 only; no runtime resources.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isMap, isScalar, parseDocument } from "yaml";
import { scanMemoryValue } from "../MemorySecretScanner.ts";
import type { ImportParsedItem, MemoryImportParser } from "./MemoryImportTypes.ts";

const normalize = (text: string) => text.normalize("NFC").replace(/\r\n/g, "\n").trim();
const bytes = (text: string) => new TextEncoder().encode(text).length;
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const types = new Set(["user", "feedback", "project", "reference"]);
const excluded = new Set(["MEMORY.md", "CLAUDE.md", "memory_summary.md", "raw_memories.md"]);
const isPayload = Schema.is(M.MemoryPayload);
const FILE_MAX_BYTES = 256 * 1024;

/** Parse only the two pinned Claude topic grammars; no generic YAML/Markdown fallback. */
const header = (text: string, metadataProfile: boolean) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const doc = parseDocument(match[1]!, { uniqueKeys: true, version: "1.2" });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) return undefined;
  const top = new Map<string, string>();
  const metadata = new Map<string, string>();
  if (doc.contents.tag || doc.contents.anchor) return undefined;
  for (const pair of doc.contents.items) {
    if (
      !isScalar(pair.key) ||
      pair.key.tag ||
      pair.key.anchor ||
      typeof pair.key.value !== "string"
    )
      return undefined;
    const key = pair.key.value;
    if (key === "metadata" && metadataProfile && isMap(pair.value)) {
      if (pair.value.tag || pair.value.anchor) return undefined;
      for (const entry of pair.value.items) {
        if (
          !isScalar(entry.key) ||
          entry.key.tag ||
          entry.key.anchor ||
          typeof entry.key.value !== "string" ||
          !["type", "node_type", "originSessionId"].includes(entry.key.value) ||
          !isScalar(entry.value) ||
          entry.value.tag ||
          entry.value.anchor ||
          typeof entry.value.value !== "string"
        )
          return undefined;
        if (scanMemoryValue(entry.value.value).kind === "blocked")
          return { issue: "secret_detected" as const };
        metadata.set(entry.key.value, normalize(entry.value.value));
      }
    } else {
      if (
        !["name", "description", "type"].includes(key) ||
        !isScalar(pair.value) ||
        pair.value.tag ||
        pair.value.anchor ||
        typeof pair.value.value !== "string"
      )
        return undefined;
      if (scanMemoryValue(pair.value.value).kind === "blocked")
        return { issue: "secret_detected" as const };
      top.set(key, normalize(pair.value.value));
    }
  }
  const type = metadataProfile ? metadata.get("type") : top.get("type");
  if (
    !top.get("name") ||
    !top.get("description") ||
    !type ||
    !types.has(type) ||
    (metadataProfile && top.has("type") && top.get("type") !== type)
  )
    return undefined;
  // Foreign session/node identifiers are deliberately absent from canonical metadata.
  return {
    name: top.get("name")!,
    description: top.get("description")!,
    type,
    body: normalize(match[2]!),
  };
};

/** Pure snapshot -> candidates. Registration identity/evidence is attached by L4. */
export const parseClaudeMemory: MemoryImportParser = (input) =>
  Effect.gen(function* () {
    if (
      input.format !== "claude" ||
      input.slot.format !== "claude" ||
      !["claude-topic-v1", "claude-topic-metadata-v1"].includes(input.profile)
    )
      return yield* new M.MemoryImportRpcError({ issue: "unsupported_format" });
    if (scanMemoryValue(input.sourceLocator).kind === "blocked")
      return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
    const seen = new Set<string>();
    let totalBytes = 0;
    // Validate the complete snapshot before returning rows, including safe files before an unsafe one.
    for (const file of input.files) {
      const parts = file.selector.split("/");
      if (
        !file.selector ||
        file.selector !== file.selector.trim() ||
        Array.from(file.selector).some((char) => char.codePointAt(0)! < 32 || char === "\x7f") ||
        /[\\:#]/.test(file.selector) ||
        parts.some((part) => !part || part === "." || part === "..") ||
        seen.has(file.selector)
      )
        return yield* new M.MemoryImportRpcError({ issue: "path_rejected" });
      seen.add(file.selector);
      if (scanMemoryValue(file.selector).kind === "blocked")
        return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
      if (!file.text.isWellFormed() || !file.selector.isWellFormed())
        return yield* new M.MemoryImportRpcError({ issue: "invalid_utf8" });
      if (file.text.includes("\0"))
        return yield* new M.MemoryImportRpcError({ issue: "unsupported_format" });
      const actualBytes = bytes(file.text);
      totalBytes += actualBytes;
      if (
        bytes(file.selector) > 512 ||
        actualBytes > FILE_MAX_BYTES ||
        totalBytes > M.MEMORY_IMPORT_SNAPSHOT_MAX_UTF8_BYTES
      )
        return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
      if (actualBytes !== file.byteCount)
        return yield* new M.MemoryImportRpcError({ issue: "source_changed" });
      if (scanMemoryValue(file.text).kind === "blocked")
        return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
    }
    const rows: ImportParsedItem[] = [];
    for (const file of input.files) {
      if (
        file.selector.includes("/") ||
        !file.selector.endsWith(".md") ||
        excluded.has(file.selector)
      )
        continue;
      const sourceItemKey = `${file.selector}#body`;
      if (bytes(sourceItemKey) > M.MEMORY_IMPORT_KEY_MAX_UTF8_BYTES)
        return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
      const parsed = header(file.text, input.profile === "claude-topic-metadata-v1");
      if (parsed && "issue" in parsed)
        return yield* new M.MemoryImportRpcError({ issue: parsed.issue });
      const reject = (issue: M.MemoryImportIssue) =>
        rows.push({
          kind: "rejected",
          sourceItemKey,
          byteCount: file.byteCount,
          issue,
        });
      if (!parsed || !parsed.body) {
        reject("unsupported_format");
        continue;
      }
      const payload = { text: parsed.body, evidence: [], derivedFromMemoryRevisions: [] };
      if (
        scanMemoryValue({ text: [parsed.name, parsed.description, parsed.body] }).kind === "blocked"
      )
        return yield* new M.MemoryImportRpcError({ issue: "secret_detected" });
      if (Array.from(parsed.name).length > 256 || !isPayload(payload)) {
        reject("limit_exceeded");
        continue;
      }
      rows.push({
        kind: "candidate",
        candidate: {
          sourceItemKey,
          sourceFingerprint: hash(
            // @effect-diagnostics-next-line preferSchemaOverJson:off -- deterministic tuple framing for hashing, not a JSON wire codec.
            JSON.stringify([
              input.parserVersion,
              parsed.name,
              parsed.description,
              parsed.type,
              parsed.body,
            ]),
          ),
          contentFingerprint: hash(parsed.body),
          title: parsed.name,
          payload,
          byteCount: bytes(parsed.body),
        },
      });
    }
    if (rows.length > M.MEMORY_IMPORT_PREVIEW_MAX_ITEMS)
      return yield* new M.MemoryImportRpcError({ issue: "limit_exceeded" });
    return rows;
  });
