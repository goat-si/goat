import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";
import { MemoryStoreConflict, strict } from "./store/StoreModel.ts";

const MAX_ENTRIES = 8;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type SchemaIssueEntry = {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly reason: "missing" | "has an unexpected field" | "wrong type" | "invalid";
};

const reasonOf = (issue: SchemaIssue.Leaf): SchemaIssueEntry["reason"] => {
  switch (issue._tag) {
    case "MissingKey":
      return "missing";
    case "UnexpectedKey":
      return "has an unexpected field";
    case "InvalidType":
      return "wrong type";
    default:
      return "invalid";
  }
};

/**
 * Where a schema failed, without what was there. Memory payloads, queries and ids are personal
 * data, so diagnostics and refusals carry field paths and issue kinds only, never actual values.
 * Object keys can be input too: an unexpected key is reported on its parent, and any segment that
 * is not a plain field name or index is masked.
 */
export const schemaIssueEntries = (root: SchemaIssue.Issue): ReadonlyArray<SchemaIssueEntry> => {
  const entries = new Map<string, SchemaIssueEntry>();
  const visit = (issue: SchemaIssue.Issue, path: ReadonlyArray<PropertyKey>): void => {
    switch (issue._tag) {
      case "Filter":
      case "Encoding":
        return visit(issue.issue, path);
      case "Pointer":
        return visit(issue.issue, [...path, ...issue.path]);
      case "Composite":
      case "AnyOf":
        if (issue.issues.length === 0)
          entries.set(`${formatPath(path)} invalid`, { path, reason: "invalid" });
        for (const child of issue.issues) visit(child, path);
        return;
      default: {
        const entry = {
          path: issue._tag === "UnexpectedKey" ? path.slice(0, -1) : path,
          reason: reasonOf(issue),
        };
        entries.set(`${formatPath(entry.path)} ${entry.reason}`, entry);
      }
    }
  };
  visit(root, []);
  return [...entries.values()];
};

const formatPath = (path: ReadonlyArray<PropertyKey>) =>
  path.length === 0
    ? "arguments"
    : path
        .map((segment) =>
          typeof segment === "number" || (typeof segment === "string" && FIELD_NAME.test(segment))
            ? String(segment)
            : "*",
        )
        .join(".");

export const schemaIssueSummary = (root: SchemaIssue.Issue): string => {
  const entries = schemaIssueEntries(root);
  const shown = entries
    .slice(0, MAX_ENTRIES)
    .map((entry) => `${formatPath(entry.path)} ${entry.reason}`);
  const hidden = entries.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} (+${hidden} more)` : shown.join(", ");
};

/**
 * A response that fails its own contract is a server bug the caller cannot fix, so it stays
 * invalid_output, but the log names the stage, the failing fields and, for item lists, the ids of
 * the items involved, so one malformed row can be found without reading anyone's memories.
 */
const checkedOutput = <A, R>(
  stage: string,
  items: ReadonlyArray<{ readonly memoryId: string }>,
  decoded: Effect.Effect<A, Schema.SchemaError, R>,
) =>
  decoded.pipe(
    Effect.tapError((error) => {
      const entries = schemaIssueEntries(error.issue);
      const memoryIds = [
        ...new Set(
          entries.flatMap(({ path: [head, index] }) =>
            head === "items" && typeof index === "number" && items[index]
              ? [items[index].memoryId]
              : [],
          ),
        ),
      ];
      return Effect.logWarning("memory output failed its contract", {
        stage,
        issues: schemaIssueSummary(error.issue),
        ...(memoryIds.length > 0 ? { memoryIds } : {}),
      });
    }),
    Effect.mapError(() => new MemoryStoreConflict({ code: "invalid_output" })),
  );

const decodePage = Schema.decodeUnknownEffect(M.MemoryPage);
const decodeHistoryPage = Schema.decodeUnknownEffect(M.MemoryHistoryPage);
export const checkedPage = (page: unknown, items: ReadonlyArray<M.MemoryItem>) =>
  checkedOutput("memory-page", items, decodePage(page, strict));
export const checkedHistoryPage = (page: unknown) =>
  checkedOutput("memory-history", [], decodeHistoryPage(page, strict));
