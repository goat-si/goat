// @effect-diagnostics nodeBuiltinImport:off - reads the cache through one pinned file handle.
import * as NodeFSP from "node:fs/promises";
import { none, type Many } from "stream-chain/defs.js";
import { Assembler } from "stream-json/core/assembler.js";
import * as StreamJson from "stream-json/core/parser.js";
import type { ParserOptions, Token } from "stream-json/core/parser.js";
import type { TranscriptUsageFormat } from "@goat/provider-core/server/usage";
import type { UsageProviderKind } from "@goat/contracts";
import { isScanCacheVersion, scanCacheEntryDecoder } from "./usageScanCache.ts";
import type { UsageHistoryPages } from "./usageHistoryPages.ts";

export class InvalidUsageCache extends Error {}

const CHUNK_SIZE = 64 * 1024;
const headerSections = new Set(["models", "sessions", "sources", "coveredSince"]);
type CacheMember = { section: string; key: string | number; value: unknown };

async function* members(
  file: NodeFSP.FileHandle,
  sections: ReadonlySet<string>,
): AsyncGenerator<CacheMember> {
  const { jsonParser } = StreamJson as typeof StreamJson & {
    jsonParser: (
      options: ParserOptions,
    ) => (input: string | typeof none) => Many<Token> | typeof none;
  };
  const tokenize = jsonParser({ streamValues: false });
  const bytes = Buffer.allocUnsafe(CHUNK_SIZE);
  const text = new TextDecoder();
  let depth = 0;
  let section = "";
  let child: string | number = 0;
  let value: Assembler | undefined;

  function* consume(input: string | typeof none) {
    let tokens: Many<Token> | typeof none;
    try {
      tokens = tokenize(input);
    } catch (cause) {
      throw new InvalidUsageCache("Usage cache contains malformed JSON", { cause });
    }
    if (tokens === none) return;
    for (const token of tokens.values) {
      const opens = token.name === "startObject" || token.name === "startArray";
      const closes = token.name === "endObject" || token.name === "endArray";
      if (value !== undefined) {
        value.consume(token);
      } else if (token.name === "keyValue") {
        if (depth === 1) {
          section = token.value;
          child = 0;
        } else if (depth === 2) {
          child = token.value;
        }
      } else if (
        depth === 1 &&
        section === "version" &&
        sections === headerSections &&
        token.name === "numberValue"
      ) {
        yield { section, key: section, value: Number(token.value) };
      } else if (depth === 2 && sections.has(section) && !closes) {
        value = new Assembler();
        value.consume(token);
      }

      if (opens && ++depth > 128)
        throw new InvalidUsageCache("Usage cache exceeds its nesting limit");
      if (closes) depth--;
      if (value?.done) {
        yield { section, key: child, value: value.current };
        if (typeof child === "number") child++;
        value = undefined;
      }
    }
  }

  for (let offset = 0; ;) {
    const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    yield* consume(text.decode(bytes.subarray(0, bytesRead), { stream: true }));
  }
  yield* consume(text.decode());
  yield* consume(none);
  if (depth !== 0) throw new InvalidUsageCache("Usage cache ended inside a JSON value");
}

export async function loadScanCachePages(
  path: string,
  pages: UsageHistoryPages,
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
) {
  let file: NodeFSP.FileHandle;
  try {
    file = await NodeFSP.open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const sources: Record<string, unknown> = Object.create(null);
  const coveredSince: Record<string, unknown> = Object.create(null);
  try {
    let version: unknown;
    for await (const { section, key, value } of members(file, headerSections)) {
      if (section === "version") version = value;
      else if (section === "sources" && typeof key === "string") sources[key] = value;
      else if (section === "coveredSince" && typeof key === "string") coveredSince[key] = value;
      else if (typeof key === "number" && typeof value === "string")
        pages.setString(section, key, value);
      else throw new InvalidUsageCache("Usage cache contains an invalid intern table");
    }
    if (!isScanCacheVersion(version)) return null;
    const decode = scanCacheEntryDecoder(
      version,
      {
        model: (id) => pages.getString("models", id),
        session: (id) => pages.getString("sessions", id),
      },
      formats,
    );
    let saved = 0;
    for await (const { key, value } of members(file, new Set(["files"]))) {
      if (typeof key !== "string")
        throw new InvalidUsageCache("Usage cache files must be an object");
      saved++;
      const entry = decode(value);
      if (entry !== undefined) pages.set(key, entry, false);
    }
    return { metadata: { sources, coveredSince }, complete: saved === pages.size };
  } catch (error) {
    pages.clear();
    throw error;
  } finally {
    try {
      pages.clearStrings();
    } finally {
      await file.close();
    }
  }
}
