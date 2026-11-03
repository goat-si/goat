import {
  PreviewAutomationFillSecretInput,
  SecretRequestError,
  type PreviewAutomationRequest,
  type CardDetails,
  type ThreadId,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CDPSession } from "playwright-core";
import { fillCard } from "./ServerBrowserCardFill.ts";
import type { SecretFillTab } from "./ServerBrowserSecretFill.ts";
import type { LoginDelivery } from "../secrets/SecretRequests.ts";
import type { SecretRequests } from "../secrets/SecretRequests.ts";
import { makeActionChannel } from "./actionChannel.ts";
import { ServerBrowserOperationError } from "./browserOperationError.ts";
import { SessionControl } from "./SessionControl.ts";

const decode = Schema.decodeUnknownOption(PreviewAutomationFillSecretInput);
const refusal = (message: string) =>
  new ServerBrowserOperationError("PreviewAutomationSecretFillRefusedError", message, {
    beforeInput: true,
  });
type Field = { readonly objectId: string; readonly value: string };
type Card = CardDetails;
type Gate = ((destination: string) => Promise<void>) & {
  readonly isFenced: () => boolean;
  readonly blockedFrame: () => boolean;
  readonly signal?: AbortSignal | undefined;
};
type RecordAction<T> = <A>(tab: T, action: string, run: () => Promise<A>) => Promise<A>;
export type CardFillResult = Awaited<ReturnType<typeof fillCard>>;

export const makeCardOperation =
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
      run: (card: Card) => Promise<LoginDelivery>,
    ) => Promise<LoginDelivery>;
  }) =>
  async <T extends SecretFillTab>(
    tab: T,
    request: PreviewAutomationRequest,
    deadlineMs: number,
    record: RecordAction<T>,
    checkBlocked: Gate,
    around: <A>(run: () => Promise<A>) => Promise<A> = (run) => run(),
  ): Promise<CardFillResult> => {
    const input = Option.getOrUndefined(decode(request.input));
    if (!input) throw refusal("Pass a card secretRef.");
    if (deps.debugLogging(process.env.DEBUG))
      throw refusal("Browser debug logging is on, so GOAT will not type secrets.");
    SessionControl.requireAgentSession(request);
    return record(tab, "fillCard", () =>
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
              if (remaining <= 0) throw new DOMException("Card fill timed out.", "TimeoutError");
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
                worldName: "goat-card-fill",
              });
              let result: CardFillResult | undefined;
              let notSent = false;
              let uncertain = false;
              await deps.use(
                { ref: input.secretRef, threadId: request.threadId, origin },
                async (card) => {
                  let dispatched = false;
                  const send = async (
                    method: string,
                    params: Record<string, unknown>,
                    onDispatch?: () => void,
                  ) => {
                    if (performance.now() >= deadlineMs)
                      throw new DOMException("Card fill timed out.", "TimeoutError");
                    if (method === "Runtime.releaseObject")
                      return channel.send("Runtime.releaseObject", params as { objectId: string });
                    if (method === "Runtime.callFunctionOn")
                      return channel.call(() => {
                        onDispatch?.();
                        return Reflect.apply(tab.cdp.send, tab.cdp, [method, params]) as Promise<{
                          result?: { objectId?: string; value?: unknown };
                          exceptionDetails?: unknown;
                        }>;
                      });
                    throw new Error("Unsupported card fill operation.");
                  };
                  const run = fillCard({
                    send,
                    contextId: world.executionContextId,
                    origin,
                    card,
                    canDispatch: () => {
                      try {
                        return new URL(tab.page.url()).origin === origin;
                      } catch {
                        return false;
                      }
                    },
                    register: (value) => deps.register(tab, request.threadId, value),
                    protect: (field) => deps.protect(tab, request.threadId, origin, tab.cdp, field),
                    onDispatch: () => {
                      dispatched = true;
                    },
                  });
                  let onAbort: (() => void) | undefined;
                  const aborted = new Promise<never>((_, reject) => {
                    onAbort = () => reject(signal.reason);
                    if (signal.aborted) onAbort();
                    else signal.addEventListener("abort", onAbort, { once: true });
                  });
                  try {
                    const output = await Promise.race([run, aborted]);
                    result = output;
                    if (output.verdict !== "refused")
                      return output.numberFilled && output.cvcFilled && !("code" in output)
                        ? "complete"
                        : "partial";
                    return "none";
                  } catch {
                    if (dispatched) {
                      uncertain = true;
                      return "uncertain";
                    }
                    notSent = true;
                    return "none";
                  } finally {
                    if (onAbort) signal.removeEventListener("abort", onAbort);
                  }
                },
              );
              if (notSent) throw refusal("Card fill stopped before any input was sent.");
              if (uncertain) throw new Error("Card delivery is uncertain. Request a new card.");
              if (!result) throw new Error("Card fill did not return a result.");
              return result;
            }),
          ),
        deadlineMs,
      ),
    );
  };

export const makeCardOperationWithStore = (
  deps: Omit<Parameters<typeof makeCardOperation>[0], "use">,
  secrets: SecretRequests["Service"],
  runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) =>
  makeCardOperation({
    ...deps,
    use: (input, run) =>
      runPromise(
        secrets.useCard(input, (card) =>
          Effect.tryPromise({
            try: () => run(card),
            catch: () => new SecretRequestError({ reason: "consume_failed" }),
          }),
        ),
      ),
  });
