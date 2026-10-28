import {
  AGENT_RESPONSE_MAX_BYTES,
  OrchestratorMcpFailure,
  type AgentWorkspaceListInput,
  type AgentWorkspaceListResult,
  type AgentWorkspaceReadInput,
  type AgentWorkspaceReadResult,
  type AgentWorkspaceSearchInput,
  type AgentWorkspaceSearchResult,
  type AgentWorkspaceWriteInput,
  type AgentWorkspaceWriteResult,
  AGENT_TEXT_MAX_BYTES,
  type ProjectEntry,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixed-size cursor targets avoid duplicating long escaped paths.
import * as NodeCrypto from "node:crypto";

import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { agentWorkspacePath, validAgentRelativePath } from "../workspace/agentWorkspacePath.ts";
import * as Access from "./AgentWorkspaceTerminalAccess.ts";
import * as Audit from "./AgentWorkspaceTerminalAudit.ts";
import * as ToolAccess from "./McpToolAccess.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const Cursor = Schema.Struct({ target: Schema.String, after: Schema.String });
const decodeCursor = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const failed = () => Access.invalid("The workspace path or text could not be read safely.");
const withinBudget = (value: unknown) => Buffer.byteLength(json(value)) <= AGENT_RESPONSE_MAX_BYTES;
const samePermit = (a: Access.AgentWorkspacePermit, b: Access.AgentWorkspacePermit) =>
  a.projectId === b.projectId &&
  a.threadId === b.threadId &&
  a.root === b.root &&
  a.owner === b.owner &&
  a.bindingGeneration === b.bindingGeneration;

export class AgentWorkspaceMcpService extends Context.Service<
  AgentWorkspaceMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: AgentWorkspaceListInput,
    ) => Effect.Effect<AgentWorkspaceListResult, OrchestratorMcpFailure>;
    readonly search: (
      scope: McpInvocationScope,
      input: AgentWorkspaceSearchInput,
    ) => Effect.Effect<AgentWorkspaceSearchResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      input: AgentWorkspaceReadInput,
    ) => Effect.Effect<AgentWorkspaceReadResult, OrchestratorMcpFailure>;
    readonly write: (
      scope: McpInvocationScope,
      input: AgentWorkspaceWriteInput,
    ) => Effect.Effect<AgentWorkspaceWriteResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/AgentWorkspaceMcpService") {}

const make = Effect.gen(function* () {
  const access = yield* Access.AgentWorkspaceTerminalAccess;
  const audit = yield* Audit.AgentWorkspaceTerminalAudit;
  const entries = yield* WorkspaceEntries.WorkspaceEntries;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const checkPath = (root: string, path: string, allowMissing = false) =>
    Effect.tryPromise({
      try: () => agentWorkspacePath(root, path, allowMissing),
      catch: failed,
    });
  const start = Effect.fn("AgentWorkspace.start")(function* (
    scope: McpInvocationScope,
    input: Access.AgentWorkspaceTarget,
    action: string,
    path: string,
  ) {
    const permit = yield* access.authorize(scope, input, "filesystem:read");
    const auditId = Audit.newAccessAuditId();
    yield* audit.append(scope, action, `${permit.projectId}/${path}`, "requested", auditId);
    return { ...permit, auditId };
  });
  const finish = Effect.fn("AgentWorkspace.finish")(function* (
    scope: McpInvocationScope,
    input: Access.AgentWorkspaceTarget,
    permit: Access.AgentWorkspacePermit & { readonly auditId: string },
    action: string,
    path: string,
  ) {
    const current = yield* access.authorize(scope, input, "filesystem:read");
    if (!samePermit(current, permit))
      return yield* Access.denied("The workspace changed during the operation.");
    yield* audit.append(scope, action, `${permit.projectId}/${path}`, "completed", permit.auditId);
  });
  const read = Effect.fn("AgentWorkspace.read")(function* (
    scope: McpInvocationScope,
    input: AgentWorkspaceReadInput,
  ) {
    const permit = yield* start(scope, input, "workspace.read", input.path);
    if (!validAgentRelativePath(input.path)) return yield* failed();
    yield* checkPath(permit.root, input.path, true);
    const result = yield* files
      .readFilePage({ ...input, cwd: permit.root })
      .pipe(Effect.mapError(failed));
    if (!withinBudget(result))
      return yield* Access.invalid("The file response exceeds its budget.");
    yield* finish(scope, input, permit, "workspace.read", input.path);
    return result;
  });
  const list = Effect.fn("AgentWorkspace.list")(function* (
    scope: McpInvocationScope,
    input: AgentWorkspaceListInput,
  ) {
    const path = input.path ?? "";
    const permit = yield* start(scope, input, "workspace.list", path);
    if (!validAgentRelativePath(path, true)) return yield* failed();
    const target = yield* checkPath(permit.root, path);
    const cursorTarget = NodeCrypto.createHash("sha256")
      .update(`${target.root}\0${path}`)
      .digest("hex");
    const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1);
    const cursorFor = (entry: ProjectEntry) =>
      encodeCursor({ target: cursorTarget, after: basename(entry.path) });
    const cursor =
      input.cursor === undefined
        ? undefined
        : yield* Effect.try({ try: () => decodeCursor(input.cursor), catch: failed });
    if (cursor && cursor.target !== cursorTarget)
      return yield* Access.invalid("The cursor belongs to another workspace or directory.");
    const result = yield* entries
      .list({ cwd: permit.root, directoryPath: path })
      .pipe(Effect.mapError(failed));
    const ordered = result.entries
      .filter((entry) => validAgentRelativePath(entry.path))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .filter((entry) => cursor === undefined || basename(entry.path) > cursor.after);
    const page: ProjectEntry[] = [];
    for (const entry of ordered) {
      if (
        page.length >= (input.limit ?? 100) ||
        !withinBudget({ entries: [...page, entry], nextCursor: cursorFor(entry), truncated: true })
      )
        break;
      yield* checkPath(permit.root, entry.path);
      page.push(entry);
    }
    const last = page.at(-1);
    const truncated = result.truncated || page.length < ordered.length;
    yield* finish(scope, input, permit, "workspace.list", path);
    return {
      entries: page,
      truncated,
      nextCursor: truncated && last ? cursorFor(last) : null,
    };
  });
  const search = Effect.fn("AgentWorkspace.search")(function* (
    scope: McpInvocationScope,
    input: AgentWorkspaceSearchInput,
  ) {
    const permit = yield* start(scope, input, "workspace.search", "paths");
    const result = yield* entries
      .search({ cwd: permit.root, query: input.query, limit: input.limit ?? 100 })
      .pipe(Effect.mapError(failed));
    const page: ProjectEntry[] = [];
    let omitted = false;
    for (const entry of result.entries.toSorted((a, b) => a.path.localeCompare(b.path))) {
      if (!validAgentRelativePath(entry.path)) {
        omitted = true;
        continue;
      }
      const valid = yield* checkPath(permit.root, entry.path).pipe(Effect.isSuccess);
      if (!valid || !withinBudget({ entries: [...page, entry] })) {
        omitted = true;
        continue;
      }
      page.push(entry);
    }
    yield* finish(scope, input, permit, "workspace.search", "paths");
    return { entries: page, truncated: result.truncated || omitted };
  });
  const write = Effect.fn("AgentWorkspace.write")(function* (
    scope: McpInvocationScope,
    input: AgentWorkspaceWriteInput,
  ) {
    const permit = yield* access.authorize(scope, input, "filesystem:write");
    if (!validAgentRelativePath(input.path)) return yield* failed();
    const target = yield* checkPath(permit.root, input.path, true);
    const authorizeAtPublish = access
      .authorize(scope, input, "filesystem:write")
      .pipe(
        Effect.flatMap((current) =>
          samePermit(current, permit)
            ? Effect.void
            : Effect.fail(Access.denied("The workspace changed before saving.")),
        ),
      );
    yield* ToolAccess.admit({
      ...input,
      destination: { ...permit, canonicalRoot: target.root, canonicalPath: target.path },
    });
    const auditId = Audit.newAccessAuditId();
    yield* audit.append(
      scope,
      "workspace.write",
      `${permit.projectId}/${input.path}`,
      "requested",
      auditId,
    );
    const loaded =
      input.expectedVersion === null
        ? undefined
        : yield* files
            .readFilePage({ cwd: permit.root, path: input.path, maxBytes: AGENT_TEXT_MAX_BYTES })
            .pipe(Effect.mapError(failed));
    if (loaded && (!loaded.exists || loaded.version !== input.expectedVersion))
      return yield* new OrchestratorMcpFailure({
        code: "conflict",
        message: "The file changed or was deleted. Read it again before saving.",
      });
    if (
      loaded?.textFormat?.encoding === "unsupported" ||
      loaded?.textFormat?.lineEnding === "mixed"
    )
      return yield* Access.invalid("This text format cannot be saved safely.");
    const textFormat = input.textFormat ?? loaded?.textFormat;
    const result = yield* files
      .writeFile({
        cwd: permit.root,
        relativePath: input.path,
        contents: input.contents,
        ...(input.expectedVersion === null
          ? { createOnly: true }
          : { expectedVersion: input.expectedVersion }),
        ...(textFormat === undefined ? {} : { textFormat }),
        maxBytes: AGENT_TEXT_MAX_BYTES,
        authorizeAtPublish,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "OrchestratorMcpFailure"
            ? error
            : error._tag === "WorkspaceFileChangedOnDiskError" ||
                error._tag === "WorkspaceFileDeletedOnDiskError"
              ? new OrchestratorMcpFailure({
                  code: "conflict",
                  message: "The file changed or was deleted; no bytes were replaced.",
                })
              : Access.invalid(
                  "The file could not be saved safely. Check its path, encoding and encoded size.",
                ),
        ),
      );
    yield* audit.append(
      scope,
      "workspace.write",
      `${permit.projectId}/${input.path}`,
      "completed",
      auditId,
    );
    if (!result.version)
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        reason: "outcome_unknown",
        message: "The saved file has no version. Read it before another write.",
      });
    return { path: result.relativePath, version: result.version };
  });
  return AgentWorkspaceMcpService.of({ list, search, read, write });
});
export const layer = Layer.effect(AgentWorkspaceMcpService, make);
