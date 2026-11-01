import * as Deferred from "effect/Deferred";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { type NoteThreadLink, type ThreadResult } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import { type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadResults from "../threadResults/ThreadResultService.ts";

export class NoteResults extends Context.Service<
  NoteResults,
  {
    readonly remember: (link: NoteThreadLink, result: ThreadResult) => Effect.Effect<void>;
    readonly latest: (link: NoteThreadLink) => Effect.Effect<ThreadResult | null>;
    readonly subscribeChanges: Effect.Effect<Stream.Stream<NoteThreadLink>, never, Scope.Scope>;
    readonly scope: McpInvocationScope;
  }
>()("goat/notes/NoteResults") {}

const make = Effect.gen(function* () {
  const local = yield* ThreadResults.ThreadResultService;
  const hosts = yield* HostThreads.HostThreadsMcpService;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const scope: McpInvocationScope = {
    environmentId,
    capabilities: new Set(["orchestration"]),
    issuedAt: yield* Clock.currentTimeMillis,
    requestNamespace: "notes",
    thread: undefined,
    client: { sessionId: "notes", label: "GOAT Notes", access: "full-access" },
  };
  const serviceScope = yield* Effect.scope;
  const remoteSlots = yield* Semaphore.make(4);
  const pending = new Map<string, Deferred.Deferred<ThreadResult | null>>();
  const observed = new Map<string, ThreadResult>();
  const key = (link: NoteThreadLink) => JSON.stringify([link.host, link.threadId]);
  return NoteResults.of({
    remember: (link, result) =>
      Effect.sync(() => {
        if (link.host === null) return;
        if (observed.size >= 1000) observed.delete(observed.keys().next().value!);
        observed.set(key(link), result);
      }),
    scope,
    subscribeChanges: local.subscribeReports.pipe(
      Effect.map((changes) =>
        changes.pipe(Stream.map((threadId) => ({ threadId, host: null, lastResult: null }))),
      ),
    ),
    latest: (link) =>
      Effect.gen(function* () {
        // A local event must read after its commit, rather than reuse a pre-event SQL snapshot.
        if (link.host === null)
          return yield* local.forRun(link.threadId).pipe(Effect.orElseSucceed(() => null));
        const id = key(link);
        const running = pending.get(id);
        if (running) return yield* Deferred.await(running);
        const completed = yield* Deferred.make<ThreadResult | null>();
        pending.set(id, completed);
        const lookup = remoteSlots
          .withPermits(1)(hosts.readThread(scope, { host: link.host, threadId: link.threadId }))
          .pipe(
            Effect.map((read) => {
              if (read.result) return read.result;
              const previous = observed.get(id);
              return previous && read.thread.latestRunId === previous.runId ? previous : null;
            }),
            Effect.timeoutOption("2 seconds"),
            Effect.map((result) => (result._tag === "Some" ? result.value : null)),
            Effect.orElseSucceed(() => null),
          );
        yield* lookup.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              pending.delete(id);
              yield* Deferred.done(completed, exit);
            }),
          ),
          Effect.forkIn(serviceScope),
        );
        return yield* Deferred.await(completed);
      }),
  });
});
export const layer = Layer.effect(NoteResults, make);
