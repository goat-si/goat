import { entry } from "../entry.ts";

const common = {
  resource: "terminal",
  toolkit: "terminal",
  hostRoutable: false,
  requires: "either",
  dryRun: "unsupported",
  humanSteps: [],
  annotations: { idempotentHint: false, openWorldHint: false },
} as const;
const mutation = {
  ...common,
  effect: "destructive",
  capability: "terminal.operate",
  idempotency: "key",
  keyRequired: true,
  reconcile: "terminal.list",
} as const;
export const terminalEntries = {
  "terminal.list": entry({
    ...common,
    effect: "read",
    verb: "list",
    name: "goat_terminal_list",
    summary: "List terminals in this caller's bound thread without starting a process.",
    description:
      "List up to 100 terminals in your thread with explicit terminal:read and Agent tools policy. Outside clients need a human-created thread binding in Settings → Connections. Handles identify terminals; owned=false means you cannot mutate them. Connect directly to the destination MCP; no host argument.",
  }),
  "terminal.read": entry({
    ...common,
    effect: "read",
    verb: "read",
    name: "goat_terminal_read",
    summary: "Read bounded terminal output without spawning or resizing.",
    description:
      "Read a terminal handle with terminal:read. Default 8192/max 32768 UTF-8 bytes. Continue with nextCursor; eof means caught up to current output. gap reports eviction or a reset. Clear/restart change generations; expired handles after a server restart require a fresh terminal.list. This read never starts or resizes a process.",
  }),
  "terminal.open": entry({
    ...mutation,
    verb: "open",
    name: "goat_terminal_open",
    summary: "Open an agent-owned terminal in this caller's bound thread.",
    description:
      "Open a terminal with explicit terminal:operate, Operate policy and full-access mode. Outside clients need a human-created thread binding. The server chooses the handle and workspace. clientRequestId is required. Shell commands use the server's OS file/network authority; the starting directory is not a sandbox. Only this opener may mutate it.",
  }),
  "terminal.write": entry({
    ...mutation,
    verb: "write",
    name: "goat_terminal_write",
    summary: "Send input to a terminal opened by this caller.",
    description:
      "Send up to 16 KiB to your own terminal handle with terminal:operate and full-access mode. Include newline to submit a command. clientRequestId is required; retries with the same key do not send input again. A supplied handle grants nothing beyond current scope, policy, binding and opener ownership.",
  }),
  "terminal.clear": entry({
    ...mutation,
    verb: "clear",
    name: "goat_terminal_clear",
    summary: "Clear your own terminal and return a replacement handle.",
    description:
      "Clear an agent-owned terminal's retained output. Requires terminal:operate, full-access mode and clientRequestId. Returns a new-generation handle; use it for later mutations. Existing read cursors report a gap. User-owned or another opener's terminals cannot be cleared.",
  }),
  "terminal.restart": entry({
    ...mutation,
    verb: "restart",
    name: "goat_terminal_restart",
    summary: "Restart your own terminal and return a replacement handle.",
    description:
      "Restart your agent-owned terminal in its workspace with terminal:operate and full-access mode. clientRequestId is required. Clears output and returns a new-generation handle. No arbitrary cwd or environment overrides. Inspect the result before sending more input.",
  }),
  "terminal.close": entry({
    ...mutation,
    verb: "close",
    name: "goat_terminal_close",
    summary: "Close one terminal opened by this caller.",
    description:
      "Close exactly one agent-owned terminal with terminal:operate, full-access mode and clientRequestId. User terminals and other callers' terminals cannot be closed. No close-all or delete-history option. Reusing the same request key can reconcile this close without closing anything else.",
  }),
} as const;
