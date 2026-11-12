import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import type { EnvironmentAuth } from "./EnvironmentAuth.ts";

import {
  type ConnectionContext,
  type PenPeer,
  registerSourceForTest,
} from "./connectionContext.ts";

export const MAIN_LISTENER: ConnectionContext = { kind: "main" };

/** A fake request built as a plain object has no source; give it one to key the context on. */
const sourceOf = (request: HttpServerRequest.HttpServerRequest): object => {
  const current: unknown = (request as { readonly source?: unknown }).source;
  if (typeof current === "object" && current !== null) return current;
  const source = {};
  Object.defineProperty(request, "source", { value: source, configurable: true });
  return source;
};

export const onConnection = <R extends HttpServerRequest.HttpServerRequest>(
  request: R,
  context: ConnectionContext,
): R => {
  registerSourceForTest(sourceOf(request), context);
  return request;
};

/** Puts a test request on the main listener, as the real server does for its own accepts. */
export const onMainListener = <R extends HttpServerRequest.HttpServerRequest>(request: R): R =>
  onConnection(request, MAIN_LISTENER);

export const penConnection = (
  peer: PenPeer,
  options?: { readonly connectionId?: string; readonly generation?: number },
) => {
  let open = true;
  return {
    context: {
      kind: "pen",
      peer,
      connectionId: options?.connectionId ?? "pen-connection-1",
      generation: options?.generation ?? 1,
      alive: () => open,
    } satisfies ConnectionContext,
    close: () => {
      open = false;
    },
  };
};

/** A web handler standing in for the main listener: each request it receives arrives on it. */
export const onMainListenerWeb = <A extends ReadonlyArray<unknown>, R>(web: {
  readonly handler: (request: Request, ...rest: A) => R;
  readonly dispose: () => Promise<void>;
}) => ({
  dispose: web.dispose,
  handler: (request: Request, ...rest: A): R => {
    registerSourceForTest(request, MAIN_LISTENER);
    return web.handler(request, ...rest);
  },
});

type Auth = EnvironmentAuth["Service"];
type AfterConnection<P> = P extends readonly [unknown, unknown, ...infer Rest] ? Rest : never;

/** EnvironmentAuth as the main listener sees it: every request and credential arrives there. */
export const onMainListenerAuth = (auth: Auth) => ({
  ...auth,
  authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
    auth.authenticateHttpRequest(onMainListener(request)),
  authenticateWebSocketUpgrade: (
    request: HttpServerRequest.HttpServerRequest,
    use: Parameters<Auth["authenticateWebSocketUpgrade"]>[1],
  ) => auth.authenticateWebSocketUpgrade(onMainListener(request), use),
  authenticateMcpClient: (request: HttpServerRequest.HttpServerRequest) =>
    auth.authenticateMcpClient(onMainListener(request)),
  getSessionState: (request: HttpServerRequest.HttpServerRequest) =>
    auth.getSessionState(onMainListener(request)),
  authenticateBrowserSession: (request: HttpServerRequest.HttpServerRequest) =>
    auth.authenticateBrowserSession(onMainListener(request)),
  createBrowserSession: (
    credential: string,
    ...rest: AfterConnection<Parameters<Auth["createBrowserSession"]>>
  ) => auth.createBrowserSession(credential, MAIN_LISTENER, ...rest),
  exchangeBootstrapCredentialForAccessToken: (
    credential: string,
    ...rest: AfterConnection<Parameters<Auth["exchangeBootstrapCredentialForAccessToken"]>>
  ) => auth.exchangeBootstrapCredentialForAccessToken(credential, MAIN_LISTENER, ...rest),
  consumeMcpApprovalCode: (
    code: string,
    ...rest: AfterConnection<Parameters<Auth["consumeMcpApprovalCode"]>>
  ) => auth.consumeMcpApprovalCode(code, MAIN_LISTENER, ...rest),
});
