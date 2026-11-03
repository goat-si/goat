import {
  PreviewAutomationFillSecretInput,
  type PreviewAutomationRequest,
  type ThreadId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CDPSession } from "playwright-core";
import { fillLogin } from "./ServerBrowserLoginFill.ts";
import type { SecretFillTab } from "./ServerBrowserSecretFill.ts";
import { makeActionChannel } from "./actionChannel.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { SessionControl } from "./SessionControl.ts";

const decode = Schema.decodeUnknownOption(PreviewAutomationFillSecretInput);
const refusal = (message: string) =>
  new ServerBrowserOperationError("PreviewAutomationSecretFillRefusedError", message, {
    beforeInput: true,
  });
type Field = { readonly objectId: string; readonly value: string };
type Login = { readonly username: string; readonly password: string };
type Gate = ((destination: string) => Promise<void>) & {
  readonly isFenced: () => boolean;
  readonly blockedFrame: () => boolean;
  readonly signal?: AbortSignal | undefined;
};
type RecordAction<T> = <A>(tab: T, action: string, run: () => Promise<A>) => Promise<A>;
export type LoginFillResult = {
  readonly usernameFilled: boolean;
  readonly passwordFilled: boolean;
  readonly verdict: "confirmed" | "unverifiable" | "refused";
  readonly code?: string;
};

export const makeLoginOperation =
  (deps: {
    readonly debugLogging: (debug: string | undefined) => boolean;
    readonly reserve: <A>(tab: SecretFillTab, run: () => Promise<A>) => Promise<A>;
    readonly recording: (tab: SecretFillTab) => boolean;
    readonly register: (tab: SecretFillTab, thread: ThreadId, value: string) => void;
    readonly protect: (
      tab: SecretFillTab,
      thread: ThreadId,
      origin: string,
      session: CDPSession,
      field: Field,
    ) => () => void;
    readonly use: (
      input: {
        readonly ref: PreviewAutomationFillSecretInput["secretRef"];
        readonly threadId: ThreadId;
        readonly origin: string;
      },
      run: (login: Login) => Promise<boolean>,
      signal: AbortSignal,
    ) => Promise<boolean>;
  }) =>
  async <T extends SecretFillTab>(
    tab: T,
    request: PreviewAutomationRequest,
    deadlineMs: number,
    record: RecordAction<T>,
    checkBlocked: Gate,
    around: <A>(run: () => Promise<A>) => Promise<A> = (run) => run(),
  ): Promise<LoginFillResult> => {
    const input = Option.getOrUndefined(decode(request.input));
    if (!input) throw refusal("Pass a login secretRef.");
    if (deps.debugLogging(process.env.DEBUG))
      throw refusal("Browser debug logging is on, so GOAT will not type secrets.");
    SessionControl.requireAgentSession(request);
    return record(tab, "fillLogin", () =>
      tab.control.secret(
        request.agentSessionId,
        (fence) =>
          around(() =>
            deps.reserve(tab, async () => {
              checkBlocked.signal?.throwIfAborted();
              await checkBlocked(tab.page.url());
              fence.assertMayDispatch();
              if (deps.recording(tab))
                throw refusal("A tab that shares this tab's sign-ins is recording.");
              const origin = new URL(tab.page.url()).origin;
              if (!/^https?:\/\//u.test(origin)) throw refusal("The page has no web origin.");
              fence.hold();
              await checkBlocked(origin);
              const remaining = deadlineMs - performance.now();
              if (remaining <= 0) throw new DOMException("Login fill timed out.", "TimeoutError");
              const signals = [fence.signal, ...(checkBlocked.signal ? [checkBlocked.signal] : [])];
              if (Number.isFinite(remaining))
                signals.push(AbortSignal.timeout(Math.max(1, Math.ceil(remaining))));
              const signal = AbortSignal.any(signals);
              const channel = makeActionChannel({
                cdp: tab.cdp,
                page: tab.page,
                signal,
                controlGeneration: fence.assertMayDispatch,
                isFenced: checkBlocked.isFenced,
                blockedFrame: checkBlocked.blockedFrame,
              });
              const tree = await channel.send("Page.getFrameTree");
              const world = await channel.send("Page.createIsolatedWorld", {
                frameId: tree.frameTree.frame.id,
                worldName: "goat-login-fill",
              });
              let result: LoginFillResult | undefined;
              await deps.use(
                { ref: input.secretRef, threadId: request.threadId, origin },
                async (login) => {
                  const send = async (method: string, params: Record<string, unknown>) => {
                    if (performance.now() >= deadlineMs)
                      throw new DOMException("Login fill timed out.", "TimeoutError");
                    if (method === "Runtime.releaseObject")
                      return channel.send("Runtime.releaseObject", params as { objectId: string });
                    if (method === "Runtime.callFunctionOn")
                      return Reflect.apply(channel.send, undefined, [method, params]) as Promise<{
                        result?: { objectId?: string; value?: unknown };
                        exceptionDetails?: unknown;
                      }>;
                    throw new Error("Unsupported login fill operation.");
                  };
                  const output = await fillLogin({
                    send,
                    contextId: world.executionContextId,
                    origin,
                    login,
                    register: (value) => deps.register(tab, request.threadId, value),
                    protect: (field) => deps.protect(tab, request.threadId, origin, tab.cdp, field),
                  });
                  result = {
                    usernameFilled: output.usernameFilled,
                    passwordFilled: output.passwordFilled,
                    verdict: output.verdict,
                    ...(output.verdict === "refused" ? { code: output.code } : {}),
                  };
                  return output.usernameFilled && output.passwordFilled;
                },
                signal,
              );
              if (!result) throw new Error("Login fill did not return a result.");
              return result;
            }),
          ),
        deadlineMs,
      ),
    );
  };
