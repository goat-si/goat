import {
  AGENT_RESPONSE_MAX_BYTES,
  OrchestratorMcpFailure,
  type AgentWorkspaceListInput,
  type AgentWorkspaceListResult,
  type AgentWorkspaceReadInput,
  type AgentWorkspaceReadResult,
  type AgentWorkspaceSearchInput,
  type AgentWorkspaceSearchResult,
  type ProjectEntry,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { agentWorkspacePath, validAgentRelativePath } from "../workspace/agentWorkspacePath.ts";
import * as Access from "./AgentWorkspaceTerminalAccess.ts";
import * as Audit from "./AgentWorkspaceTerminalAudit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const Cursor = Schema.Struct({ root: Schema.String, path: Schema.String, after: Schema.String });
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
    yield* audit.append(scope, action, `${permit.projectId}/${path}`, "requested");
    return permit;
  });
  const finish = Effect.fn("AgentWorkspace.finish")(function* (
    scope: McpInvocationScope,
    input: Access.AgentWorkspaceTarget,
    permit: Access.AgentWorkspacePermit,
    action: string,
    path: string,
  ) {
    const current = yield* access.authorize(scope, input, "filesystem:read");
    if (!samePermit(current, permit))
      return yield* Access.denied("The workspace changed during the operation.");
    yield* audit.append(scope, action, `${permit.projectId}/${path}`, "completed");
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
    const cursor =
      input.cursor === undefined
        ? undefined
        : yield* Effect.try({ try: () => decodeCursor(input.cursor), catch: failed });
    if (cursor && (cursor.root !== target.root || cursor.path !== path))
      return yield* Access.invalid("The cursor belongs to another workspace or directory.");
    const result = yield* entries
      .list({ cwd: permit.root, directoryPath: path })
      .pipe(Effect.mapError(failed));
    const ordered = result.entries
      .filter((entry) => validAgentRelativePath(entry.path))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .filter((entry) => cursor === undefined || entry.path > cursor.after);
    const page: ProjectEntry[] = [];
    for (const entry of ordered) {
      if (page.length >= (input.limit ?? 100) || !withinBudget({ entries: [...page, entry] }))
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
      nextCursor:
        truncated && last ? encodeCursor({ root: target.root, path, after: last.path }) : null,
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
  return AgentWorkspaceMcpService.of({ list, search, read });
});
export const layer = Layer.effect(AgentWorkspaceMcpService, make);
