import { ProviderDriverKind, type ProviderSessionId } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

export type CodexSessionEventQueue = Queue.Queue<
  ProviderAdapter.ProviderAdapterV2Event,
  ProviderAdapter.ProviderAdapterEventStreamError
>;

export const makeCodexSessionEventQueue: Effect.Effect<CodexSessionEventQueue> = Queue.unbounded<
  ProviderAdapter.ProviderAdapterV2Event,
  ProviderAdapter.ProviderAdapterEventStreamError
>();

/**
 * The app-server can exit without GOAT asking, for example when `ocx sync --restart-codex` stops
 * it. Every thread on an instance shares one session, so a kept handle would fail every later run.
 * Failing the event queue reports the exit to ProviderSessionManager, which releases the session;
 * the next open spawns a fresh app-server. Events queued before the exit still drain first.
 */
export const failEventsOnAppServerExit = (
  client: CodexClient.CodexAppServerClient["Service"],
  events: CodexSessionEventQueue,
  providerSessionId: ProviderSessionId,
) =>
  client.terminated.pipe(
    Effect.flatMap((cause) =>
      Queue.fail(
        events,
        new ProviderAdapter.ProviderAdapterEventStreamError({
          driver: ProviderDriverKind.make("codex"),
          providerSessionId,
          cause,
        }),
      ),
    ),
    Effect.forkScoped,
  );
