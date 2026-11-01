import { authorizeClaimBind, type PendingBrowserBind } from "./ComputerUseClaimBindAuthority.ts";
import type { ComputerUseLeaseUpdate } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { OutstandingCall } from "./ComputerUseLeaseProxyOptions.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import { refusal, type JsonRpcId } from "./ComputerUseLeaseResponses.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const replaceCallArguments = (line: string, args: Readonly<Record<string, unknown>>): string => {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || !isRecord(value.params)) throw new Error("Invalid tool call envelope.");
  return JSON.stringify({ ...value, params: { ...value.params, arguments: args } });
};

export const manifestApplied = (state: unknown, expectedSha256: string): boolean =>
  /^[a-f0-9]{64}$/u.test(expectedSha256) &&
  isRecord(state) &&
  isRecord(state.capability_manifest) &&
  state.capability_manifest.sha256 === expectedSha256 &&
  state.capability_manifest.file_sha256 === expectedSha256 &&
  state.capability_manifest.reload_error === null;

export const supportsBrowserClaims = (result: unknown): boolean => {
  if (!isRecord(result) || !Array.isArray(result.tools)) return false;
  const tool = result.tools.find(
    (entry: unknown) => isRecord(entry) && entry.name === "get_browser_state",
  );
  if (!isRecord(tool) || !isRecord(tool.inputSchema) || !isRecord(tool.inputSchema.properties))
    return false;
  return Object.hasOwn(tool.inputSchema.properties, "origin_scope");
};

/** The driver session a claim's bind mints its target in; its page calls must use the same one. */
export const browserClaimSession = (claimId: string) => `goat-claim:${claimId}`;

export interface ProxyBrowserClaim {
  readonly claimId: string;
  readonly claimGeneration: number;
  readonly pid: number;
  readonly windowId: number;
  readonly tabId: string;
  readonly targetId: string;
  readonly origins: ReadonlyArray<string>;
}

export type BrowserClaimReport =
  | { readonly browserClaimsSupported: boolean }
  | {
      readonly browserClaimEnded: {
        readonly claimId: string;
        readonly claimGeneration: number;
        readonly reason: "origin_changed";
      };
    };

export const browserReplyOutsideClaim = (result: unknown, claim: ProxyBrowserClaim): boolean => {
  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > 12 || !isRecord(value)) return false;
    if (value.code === "browser_origin_outside_scope") return true;
    if (value.tab_id === claim.tabId) {
      // A semantic snapshot reports its page as page.url beside the tab id.
      const urls = [value.url, isRecord(value.page) ? value.page.url : undefined];
      for (const url of urls) {
        if (url === undefined) continue;
        if (typeof url !== "string") return true;
        try {
          if (!claim.origins.includes(new URL(url).origin)) return true;
        } catch {
          return true;
        }
      }
    }
    return Object.values(value).some((entry) =>
      Array.isArray(entry)
        ? entry.some((item) => inspect(item, depth + 1))
        : inspect(entry, depth + 1),
    );
  };
  return inspect(result, 0);
};

const scopedBrowserTools = new Set([
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_pointer",
  "browser_select",
  "browser_dialog",
]);
const isBrowserTool = (name: unknown) =>
  typeof name === "string" &&
  (name.startsWith("browser_") || name === "get_browser_state" || name === "page");

export const scopeBrowserCall = (
  name: unknown,
  args: unknown,
  claims: ReadonlyArray<ProxyBrowserClaim>,
) => {
  if (
    name === "run_steps" &&
    isRecord(args) &&
    Array.isArray(args.steps) &&
    args.steps.some((step: unknown) => isRecord(step) && isBrowserTool(step.tool))
  )
    return { refused: true as const };
  if (!isBrowserTool(name)) return { unchanged: true as const };
  if (
    typeof name !== "string" ||
    !scopedBrowserTools.has(name) ||
    !isRecord(args) ||
    typeof args.tab_id !== "string"
  )
    return { refused: true as const };
  const claim = claims.find((candidate) => candidate.tabId === args.tab_id);
  if (
    claim === undefined ||
    claim.origins.length === 0 ||
    (args.pid !== undefined && args.pid !== claim.pid) ||
    (args.window_id !== undefined && args.window_id !== claim.windowId)
  )
    return { refused: true as const };
  return {
    args: {
      ...args,
      target_id: claim.targetId,
      session: browserClaimSession(claim.claimId),
      origin_scope: claim.origins,
    },
    claimId: claim.claimId,
    claimGeneration: claim.claimGeneration,
  };
};

/**
 * The server's own judgement of a browser call at reservation, from its live claims: the proxy's
 * copy can trail a revoke, so a call scoped to a claim that has ended is refused here.
 */
export const serverAdmitsBrowserCall = (
  name: unknown,
  args: unknown,
  snapshot: {
    readonly claims: ReadonlyArray<ProxyBrowserClaim>;
    readonly bindings: ReadonlyArray<PendingBrowserBind>;
  },
): boolean => {
  const scoped = scopeBrowserCall(name, args, snapshot.claims);
  if ("unchanged" in scoped) return true;
  if ("refused" in scoped)
    return authorizeClaimBind("claimBind", name, args, snapshot.bindings) !== undefined;
  if (!isRecord(args)) return false;
  return (
    args.target_id === scoped.args.target_id &&
    args.session === scoped.args.session &&
    Array.isArray(args.origin_scope) &&
    JSON.stringify(args.origin_scope) === JSON.stringify(scoped.args.origin_scope)
  );
};

const desktopTools = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "select_text",
  "get_window_state",
  "get_accessibility_tree",
  "verify_state",
  "zoom",
  "move_cursor",
  "bring_to_front",
  "set_window_frame",
  "invoke_menu",
  "kill_app",
]);

export const refusesClaimedBrowserDesktopCall = (
  name: unknown,
  args: unknown,
  claimedPids: ReadonlyArray<number>,
): boolean => {
  if (claimedPids.length === 0 || typeof name !== "string") return false;
  const containsPid = (value: unknown, depth: number): boolean => {
    if (depth > 8) return true;
    if (Array.isArray(value)) return value.some((entry) => containsPid(entry, depth + 1));
    if (!isRecord(value)) return false;
    return (
      (typeof value.pid === "number" && claimedPids.includes(value.pid)) ||
      Object.values(value).some((entry) => containsPid(entry, depth + 1))
    );
  };
  return (desktopTools.has(name) || name === "run_steps") && containsPid(args, 0);
};

export interface SelectedClaim {
  readonly claimId: string;
  readonly claimGeneration: number;
  readonly origins: string;
  readonly pid: number | undefined;
  readonly binding?: PendingBrowserBind;
}

export const makeProxyBrowserClaims = (report?: (value: BrowserClaimReport) => void) => {
  let pids: ReadonlyArray<number> = [];
  let claims: ReadonlyArray<ProxyBrowserClaim> = [];
  let pending: ReadonlyArray<PendingBrowserBind> = [];
  const invalid = new Set<string>();
  const key = (claim: ProxyBrowserClaim) => JSON.stringify([claim.claimId, claim.claimGeneration]);
  const update = (value: ComputerUseLeaseUpdate) => {
    if (value.state !== "active") return;
    pids = value.claimedBrowserPids ?? [];
    claims = value.browserClaims ?? [];
    pending = value.browserClaimBindings ?? [];
  };
  const gate = (id: JsonRpcId, line: string, message: Envelope, authority?: "claimBind") => {
    if (authority !== undefined) {
      const binding = authorizeClaimBind(
        authority,
        message.params?.name,
        message.params?.arguments,
        pending,
      );
      if (!binding)
        return {
          refused: refusal(
            id,
            message.method,
            "outside_manifest",
            "This browser bind has no approved pending claim.",
          ),
        };
      return {
        line,
        message,
        selected: {
          claimId: binding.claimId,
          claimGeneration: 0,
          origins: JSON.stringify([binding.origin]),
          pid: binding.pid,
          binding,
        },
      };
    }
    const untrustedArgs: unknown = message.params?.arguments;
    if (isRecord(untrustedArgs) && untrustedArgs.authority === "claimBind")
      return {
        refused: refusal(
          id,
          message.method,
          "outside_manifest",
          "Claim bind authority is host-only.",
        ),
      };
    const browser = scopeBrowserCall(
      message.params?.name,
      message.params?.arguments,
      claims.filter((claim) => !invalid.has(key(claim))),
    );
    if ("refused" in browser)
      return {
        refused: refusal(
          id,
          message.method,
          "outside_manifest",
          "This browser call has no approved claim.",
        ),
      };
    if (browser.args !== undefined) {
      const selected: SelectedClaim = {
        claimId: browser.claimId,
        claimGeneration: browser.claimGeneration,
        origins: JSON.stringify(browser.args.origin_scope),
        pid: claims.find((claim) => claim.claimId === browser.claimId)?.pid,
      };
      line = replaceCallArguments(line, browser.args);
      message = { ...message, params: { ...message.params, arguments: browser.args } };
      if (refusesClaimedBrowserDesktopCall(message.params?.name, message.params?.arguments, pids))
        return {
          refused: refusal(
            id,
            message.method,
            "outside_manifest",
            "Desktop access to a claimed browser is not permitted.",
          ),
        };
      return { line, message, selected };
    }
    if (refusesClaimedBrowserDesktopCall(message.params?.name, message.params?.arguments, pids))
      return {
        refused: refusal(
          id,
          message.method,
          "outside_manifest",
          "Desktop access to a claimed browser is not permitted.",
        ),
      };
    return { line, message, selected: undefined };
  };
  const allowed = (selected: SelectedClaim | undefined, message: Envelope) =>
    (selected === undefined ||
      (selected.binding !== undefined
        ? pending.some(
            (binding) =>
              binding.claimId === selected.binding?.claimId &&
              binding.pid === selected.binding.pid &&
              binding.windowId === selected.binding.windowId &&
              binding.origin === selected.binding.origin,
          )
        : claims.some(
            (claim) =>
              !invalid.has(key(claim)) &&
              claim.claimId === selected.claimId &&
              claim.claimGeneration === selected.claimGeneration &&
              JSON.stringify(claim.origins) === selected.origins,
          ))) &&
    !refusesClaimedBrowserDesktopCall(message.params?.name, message.params?.arguments, pids);
  const selectedClaim = (selected: SelectedClaim | undefined) =>
    selected === undefined
      ? undefined
      : claims.find(
          (claim) =>
            claim.claimId === selected.claimId &&
            claim.claimGeneration === selected.claimGeneration,
        );
  const outside = (result: unknown, claim: ProxyBrowserClaim | undefined) => {
    if (claim === undefined || !browserReplyOutsideClaim(result, claim)) return false;
    invalid.add(key(claim));
    report?.({
      browserClaimEnded: {
        claimId: claim.claimId,
        claimGeneration: claim.claimGeneration,
        reason: "origin_changed",
      },
    });
    return true;
  };
  const refuseReply = Effect.fn("ComputerUseLeaseProxyBrowserClaims.refuseReply")(function* (
    request: OutstandingCall,
    key: string,
    outstanding: Map<string, OutstandingCall>,
    gone: () => boolean,
    release: (request: OutstandingCall, completed: true, notSent: boolean) => Effect.Effect<void>,
  ) {
    yield* release(request, true, true);
    if (gone()) return;
    outstanding.delete(key);
    yield* request.sink.answer(
      refusal(
        request.id,
        request.method,
        "outside_manifest",
        "The browser claim ended because the origin changed.",
      ),
      "settled",
    );
  });
  const attach = (
    request: OutstandingCall,
    selected: SelectedClaim | undefined,
  ): OutstandingCall => {
    const claim = selectedClaim(selected);
    return claim === undefined ? request : { ...request, browserClaim: claim };
  };
  const unsupported = Effect.fn("ComputerUseLeaseProxyBrowserClaims.unsupported")(function* (
    selected: SelectedClaim | undefined,
    supported: () => Effect.Effect<boolean>,
    id: JsonRpcId,
    method: string | undefined,
  ) {
    if (selected === undefined || (yield* supported())) return undefined;
    return refusal(id, method, "outside_manifest", "This driver does not support browser claims.");
  });
  return { update, gate, allowed, outside, refuseReply, attach, unsupported, report };
};
