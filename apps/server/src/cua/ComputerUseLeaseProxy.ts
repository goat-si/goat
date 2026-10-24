/**
 * The stdio MCP server a leased (unattended, approved) thread's provider runs instead of the
 * raw `cua-driver mcp`. It forwards to the driver while the thread's admission is live and
 * acts on its own when it ends, whether or not the agent makes another call:
 *
 * - every tools/call waits for the server to confirm the lease, then checks the deadline;
 * - the deadline is a timer here, and the server pushes revocation over a streamed response;
 * - on expiry, revocation or a lost connection it refuses new calls, sends MCP cancellation for
 *   every outstanding request, kills its `cua-driver mcp` child, answers the provider, and only
 *   then revokes the driver sessions the agent named, in the background.
 *
 * Killing the child is what stops nested work. Against the pinned 0.37.0 driver, MCP
 * cancellation and `cua-driver revoke --session` both leave a running run_script going, while
 * closing its transport stops it after the action already dispatched (ADR-0020). The rest is
 * protocol hygiene and covers drivers that honour them.
 *
 * @module ComputerUseLeaseProxy
 */
// JSON-RPC lines pass through unchanged; only the fields the proxy acts on are read.
// @effect-diagnostics preferSchemaOverJson:off
import { ComputerUseLeaseUpdate } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

import { admitDriverReplyScreenshots, cancelledRequestKey } from "./ComputerUseDriverReply.ts";

export type LeaseEnd = "expired" | "revoked" | "disabled" | "lost";

export const LEASE_END_MESSAGES: Readonly<Record<LeaseEnd, string>> = {
  expired: `Computer use for this thread ended at its approved time. Ask again with ${goatCallText("computer_use.request")} if the work needs more time.`,
  revoked: "A person ended computer use for this thread.",
  disabled: "Computer use was turned off on this host.",
  lost: "GOAT could not confirm this thread's computer use approval, so computer use stopped.",
};

export interface LeaseProxyDriver {
  readonly send: (line: string) => Effect.Effect<void>;
  readonly lines: Stream.Stream<string>;
  readonly kill: Effect.Effect<void>;
}

export interface LeaseProxyOptions<EU, ED> {
  readonly handoffId: string;
  readonly expiresAt: DateTime.Utc;
  /** Lines the provider writes. The proxy stops when this ends. */
  readonly input: Stream.Stream<string>;
  readonly output: (line: string) => Effect.Effect<void>;
  /** The server's view of this thread's lease, newest last. Ending or failing ends the lease. */
  readonly leaseUpdates: Stream.Stream<ComputerUseLeaseUpdate, EU>;
  readonly startDriver: Effect.Effect<LeaseProxyDriver, ED, Scope.Scope>;
  /** Deny-only revocation of the driver sessions this connection named. */
  readonly revokeSessions: (sessions: ReadonlyArray<string>) => Effect.Effect<void>;
}

type JsonRpcId = string | number;
interface Envelope {
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: {
    readonly name?: unknown;
    readonly arguments?: { readonly session?: unknown };
  };
  readonly result?: { readonly structuredContent?: { readonly session?: unknown } };
  readonly error?: unknown;
}

const parse = (line: string): Envelope | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Envelope)
      : undefined;
  } catch {
    return undefined;
  }
};

const decodeUpdate = Schema.decodeUnknownOption(ComputerUseLeaseUpdate);

const refusal = (id: JsonRpcId, method: string | undefined, message: string) =>
  JSON.stringify(
    method === "tools/call"
      ? {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: message }], isError: true },
        }
      : { jsonrpc: "2.0", id, error: { code: -32000, message } },
  );

export const runLeaseProxy = Effect.fn("ComputerUseLeaseProxy.run")(function* <EU, ED>(
  options: LeaseProxyOptions<EU, ED>,
) {
  const driver = yield* options.startDriver;
  const scope = yield* Effect.scope;
  const confirmed = yield* Deferred.make<void>();
  const ended = yield* Deferred.make<LeaseEnd>();
  let deadline = DateTime.toEpochMillis(options.expiresAt);
  let finished: LeaseEnd | undefined;
  const outstanding = new Map<string, { readonly id: JsonRpcId; readonly method: string }>();
  const sessions = new Set<string>();

  const end = Effect.fn("ComputerUseLeaseProxy.end")(function* (reason: LeaseEnd) {
    if (finished !== undefined) return;
    finished = reason;
    yield* Deferred.succeed(ended, reason);
    const pending = [...outstanding.values()];
    outstanding.clear();
    for (const request of pending)
      yield* driver.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: request.id, reason: LEASE_END_MESSAGES[reason] },
        }),
      );
    // The transport kill is what stops nested work, so nothing runs before it that could wait.
    yield* driver.kill;
    for (const request of pending)
      yield* options.output(refusal(request.id, request.method, LEASE_END_MESSAGES[reason]));
    // Best effort and deny-only; a slow or stuck revoke cannot hold anything up.
    if (sessions.size > 0)
      yield* options.revokeSessions([...sessions]).pipe(Effect.ignoreCause, Effect.forkIn(scope));
  }, Effect.uninterruptible);

  // The server is the authority: the first word for this handoff confirms it, anything else ends.
  yield* options.leaseUpdates.pipe(
    Stream.runForEach((update) =>
      update.state === "active" && update.handoffId === options.handoffId
        ? Effect.gen(function* () {
            const expiresAt = DateTime.make(update.expiresAt);
            if (Option.isSome(expiresAt))
              deadline = Math.min(deadline, DateTime.toEpochMillis(expiresAt.value));
            yield* Deferred.succeed(confirmed, undefined);
          })
        : end(
            update.state === "ended"
              ? update.reason === "expired"
                ? "expired"
                : update.reason === "disabled"
                  ? "disabled"
                  : update.reason === "revoked"
                    ? "revoked"
                    : "lost"
              : "lost",
          ),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.andThen(end("lost")),
    Effect.forkScoped,
  );

  // Held here, not in the agent's calls: expiry acts while a call is outstanding or none comes.
  yield* Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) {
        yield* end("expired");
        // Fires even when another end got there first: the driver is gone by the deadline.
        return yield* driver.kill;
      }
      yield* Effect.sleep(deadline - now);
    }
  }).pipe(Effect.forkScoped);

  yield* driver.lines.pipe(
    Stream.runForEach((line) =>
      Effect.gen(function* () {
        if (finished !== undefined) return;
        const message = parse(line);
        if (message?.id !== undefined && message.id !== null && message.method === undefined) {
          const request = outstanding.get(JSON.stringify(message.id));
          // A reply to a request the provider cancelled, or never made, is stale.
          if (request === undefined) return;
          outstanding.delete(JSON.stringify(message.id));
          const session = message.result?.structuredContent?.session;
          if (request?.method === "tools/call" && typeof session === "string")
            sessions.add(session);
        }
        yield* options.output(admitDriverReplyScreenshots(line));
      }),
    ),
    // A driver that exits on its own cannot be trusted with the rest of the lease.
    Effect.andThen(end("lost")),
    Effect.forkScoped,
  );

  const handle = Effect.fn("ComputerUseLeaseProxy.forward")(function* (line: string) {
    const message = parse(line);
    const id = message?.id;
    const isRequest = id !== undefined && id !== null && message?.method !== undefined;
    if (finished !== undefined) {
      if (isRequest)
        yield* options.output(refusal(id, message?.method, LEASE_END_MESSAGES[finished]));
      return;
    }
    if (isRequest && message?.method === "tools/call") {
      yield* Effect.raceFirst(Deferred.await(confirmed), Deferred.await(ended).pipe(Effect.asVoid));
      if (finished === undefined && (yield* Clock.currentTimeMillis) >= deadline)
        yield* end("expired");
      if (finished !== undefined)
        return yield* options.output(refusal(id, message.method, LEASE_END_MESSAGES[finished]));
      const session = message.params?.arguments?.session;
      if (typeof session === "string" && session.length > 0) sessions.add(session);
    }
    if (isRequest) outstanding.set(JSON.stringify(id), { id, method: message!.method! });
    const cancelled = cancelledRequestKey(line);
    if (cancelled !== undefined) outstanding.delete(cancelled);
    yield* driver.send(line);
  });

  yield* options.input.pipe(Stream.runForEach(handle));
  // The provider closed its end: nothing more to serve, and the driver child goes with it.
  if (finished === undefined) {
    finished = "lost";
    yield* driver.kill;
  }
  return finished;
});

/** Parses one NDJSON chunk stream from the lease route into updates, dropping unknown lines. */
export const leaseUpdateLines = <E>(lines: Stream.Stream<string, E>) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.map((line) => {
      const parsed = parse(line);
      return parsed === undefined ? Option.none() : decodeUpdate(parsed);
    }),
    Stream.filter(Option.isSome),
    Stream.map((update) => update.value),
  );
