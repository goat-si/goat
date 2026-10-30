// @effect-diagnostics preferSchemaOverJson:off -- The provider's JSON-RPC line keeps its opaque fields.
/**
 * Under an app list the proxy gives an unscoped run_steps or run_script the control's approved
 * apps as its `app_scope` (ComputerUseScope then admits it). A driver whose tool list lacks
 * `app_scope` could ignore one and run the batch unscoped, so a scope goes only to a child that
 * itself listed `app_scope`: a replacement child, even of the same install, is asked again.
 */
import * as Effect from "effect/Effect";

import {
  supportsBrowserClaims,
  type BrowserClaimReport,
} from "./ComputerUseLeaseProxyBrowserClaims.ts";
import { isBatchTool, MAX_BATCH_SCOPE_APPS } from "./ComputerUseBatchScope.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import type { Running } from "./ComputerUseLeaseProxyLifecycle.ts";
import { type JsonRpcId, refusal } from "./ComputerUseLeaseResponses.ts";

export const BATCH_SCOPE_UNSUPPORTED =
  "This version of GOAT Computer Use cannot keep run_steps or run_script to the apps in app_scope, so the call did not run. Make the calls one at a time, each with the pid and window_id of an approved app's window.";

type Send = (line: string) => Effect.Effect<void>;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** Whether a tools/list result gives the tool an `app_scope` input. */
const acceptsAppScope = (toolList: unknown, name: string): boolean => {
  const listed = record(toolList)?.tools;
  if (!Array.isArray(listed)) return false;
  const tool = listed.map(record).find((entry) => entry?.name === name);
  return record(record(record(tool?.inputSchema)?.properties)?.app_scope) !== undefined;
};

export const makeProxyBatchScope = (
  handshake: {
    readonly listTools: (send: Send) => Effect.Effect<unknown>;
    readonly remember: (method: string, message: Envelope) => void;
  },
  current: () => Running | undefined,
  report?: (value: BrowserClaimReport) => void,
) => {
  /** The apps the control's grant names, as it spells them; undefined for the whole screen. */
  let grantApps: ReadonlyArray<string> | undefined;
  /** Each child's own tool list, once it gave one: to the provider's tools/list or a probe. */
  const listed = new WeakMap<Running, unknown>();
  let lastCapability: boolean | undefined;
  const rememberList = (child: Running, tools: unknown) => {
    listed.set(child, tools);
    const browserClaimsSupported = supportsBrowserClaims(tools);
    if (lastCapability !== browserClaimsSupported) {
      lastCapability = browserClaimsSupported;
      report?.({ browserClaimsSupported });
    }
  };
  /** A handshake answer from a child, kept for the handshake and, for tools/list, for that child. */
  const remember = (child: Running, method: string, message: Envelope) => {
    handshake.remember(method, message);
    if (method === "tools/list" && message.result !== undefined)
      rememberList(child, message.result);
  };
  /** The call as the driver should get it, or the proxy's refusal (notSent while it has no child). */
  const scope = Effect.fn("ComputerUseLeaseProxy.scopeBatch")(function* (
    id: JsonRpcId,
    line: string,
    message: Envelope,
    notSent: () => string,
  ) {
    const unchanged = { line, message };
    const name = message.params?.name;
    if (!isBatchTool(name)) return unchanged;
    const args = record(message.params?.arguments) ?? {};
    const named = args.app_scope !== undefined && args.app_scope !== null;
    const apps = grantApps;
    // Without a list the batch may act anywhere; past the driver's limit it stays refused.
    if (!named && (apps === undefined || apps.length > MAX_BATCH_SCOPE_APPS)) return unchanged;
    const child = current();
    // Without a child nothing can be sent; a scope must not reach one that was never asked.
    if (child === undefined) return named ? { refused: notSent() } : unchanged;
    // Only a batch that names a scope waits for the child's tool list; one GOAT would scope gets
    // the scope once this child has listed it, and is refused as before until then.
    if (named && !listed.has(child)) {
      const tools = yield* handshake.listTools(child.driver.send);
      if (tools !== undefined) rememberList(child, tools);
      // The answer speaks for the child that gave it only.
      if (current() !== child) return { refused: notSent() };
    }
    if (!acceptsAppScope(listed.get(child), name))
      return named
        ? { refused: refusal(id, message.method, "outside_manifest", BATCH_SCOPE_UNSUPPORTED) }
        : unchanged;
    if (named || apps === undefined) return unchanged;
    const appScope = { apps, delivery: "background" };
    const raw = record(JSON.parse(line)) ?? {};
    const params = record(raw.params) ?? {};
    const rawArgs = record(params.arguments) ?? {};
    return {
      line: JSON.stringify({
        ...raw,
        params: { ...params, arguments: { ...rawArgs, app_scope: appScope } },
      }),
      message: {
        ...message,
        params: { ...message.params, arguments: { ...args, app_scope: appScope } },
      } as Envelope,
    };
  });
  const browserSupported = Effect.fn("ComputerUseLeaseProxy.browserSupported")(function* () {
    const child = current();
    if (child === undefined) return false;
    if (!listed.has(child)) {
      const tools = yield* handshake.listTools(child.driver.send);
      if (tools !== undefined) rememberList(child, tools);
    }
    return current() === child && supportsBrowserClaims(listed.get(child));
  });
  const grant = (apps: ReadonlyArray<string> | undefined) => {
    grantApps = apps;
  };
  return { scope, remember, grant, browserSupported };
};
