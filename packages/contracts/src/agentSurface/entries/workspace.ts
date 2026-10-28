import { entry } from "../entry.ts";

const common = {
  resource: "workspace",
  toolkit: "workspace",
  effect: "read",
  hostRoutable: false,
  requires: "either",
  dryRun: "unsupported",
  humanSteps: [],
  annotations: { idempotentHint: false, openWorldHint: false },
} as const;
export const workspaceEntries = {
  "workspace.write": entry({
    ...common,
    effect: "destructive",
    capability: "workspace.write",
    verb: "write",
    name: "goat_workspace_write",
    summary: "Conditionally save a live workspace file.",
    description:
      "Save UTF-8 workspace text with filesystem:write and an edit-permitting mode. expectedVersion must match a complete read, or be null for create-only. Maximum encoded size is 32768 bytes. Conflicts preserve existing bytes. clientRequestId is required; reuse it only for the same request. No force overwrite, delete or host forwarding.",
    idempotency: "key",
    keyRequired: true,
    reconcile: "workspace.read",
  }),
  "workspace.list": entry({
    ...common,
    verb: "list",
    name: "goat_workspace_list",
    summary: "List live workspace entries within a registered project or thread.",
    description:
      "List one workspace directory with an explicit filesystem:read grant and Agent tools policy. Use projectId or threadId; GOAT threads default to their own workspace. Paths stay inside that workspace. Pass nextCursor with the same target. Connect directly to the destination MCP; host forwarding is unsupported.",
  }),
  "workspace.search": entry({
    ...common,
    verb: "search",
    name: "goat_workspace_search",
    summary: "Search live workspace file names and paths.",
    description:
      "Search file names and paths in a registered workspace with filesystem:read. This is path search, including uncommitted files. Results are bounded; truncated means more may exist. GOAT threads stay in their own workspace. Connect to the destination MCP directly.",
  }),
  "workspace.read": entry({
    ...common,
    verb: "read",
    name: "goat_workspace_read",
    summary: "Read bounded UTF-8 text from a live workspace file.",
    description:
      "Read live UTF-8 workspace text with filesystem:read and Agent tools policy. Pass projectId or threadId, relative path, and optional byte offset/maxBytes (default 8192, max 32768). Continue at nextOffset until eof. A version is returned only for a complete file read from offset zero. Paths cannot escape the workspace or enter .git.",
  }),
} as const;
