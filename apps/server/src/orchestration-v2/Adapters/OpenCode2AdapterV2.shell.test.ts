import { assert, it } from "@effect/vitest";
import type { ProviderReplayEntry } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeProviderReplayGate } from "@goat/provider-testing/replayGate";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import {
  CHILD,
  SESSION,
  WORK,
  backgroundLaunch,
  event,
  out,
  promptAccepted,
  providerTurnId,
  reply,
  resumed,
  threadId,
  withLineage,
} from "./OpenCode2AdapterV2.fixtures.testkit.ts";

it.layer(McpProviderSessions.layer)("OpenCode2 native shells", (it) => {
  const watchBackgroundTurn = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
    Effect.gen(function* () {
      const attached = yield* Deferred.make<void>();
      const terminal = yield* runtime.events.pipe(
        Stream.tap((event) =>
          event.type === "subagent.updated" && event.subagent.childThreadId !== null
            ? Deferred.succeed(attached, undefined)
            : Effect.void,
        ),
        Stream.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        ),
        Stream.runHead,
        Effect.map(Option.getOrUndefined),
        Effect.forkScoped,
      );
      return { attached: Deferred.await(attached), terminal: Fiber.join(terminal) };
    });
  it.effect.each([false, true, "thread", "failed", "burst", "poll"] as const)(
    "tracks native background shells through launch, retained output, stop=%s",
    (stop) =>
      Effect.gen(function* () {
        const stopped = stop === true || stop === "thread" || stop === "poll";
        const exitCode = stop === "failed" ? 7 : 0;
        const shellID = "sh_background";
        const tool = {
          sessionID: SESSION,
          assistantMessageID: "msg_assistant",
          id: "call-shell",
        };
        const gate = makeProviderReplayGate(["shell-exit"]);
        const { runtime, thread } = yield* resumed(
          [
            out("session.prompt", { sessionID: SESSION, text: "<any>" }),
            promptAccepted,
            event("session.execution.started", { sessionID: SESSION }),
            event("session.tool.input.started", { ...tool, name: "shell" }),
            event("session.tool.called", {
              ...tool,
              name: "shell",
              input: { command: "echo retained", background: true },
              executed: false,
            }),
            event(
              "session.tool.success",
              {
                ...tool,
                content: [{ type: "text", text: "Launched" }],
                metadata: { shellID },
                executed: false,
              },
              undefined,
              2,
            ),
            out("shell.output", "<any>"),
            reply("shell.output", {
              location: { directory: WORK },
              data: { output: "retained\n", cursor: 9, size: 9, truncated: false },
            }),
            ...(stop === "poll"
              ? [out("shell.output", "<any>"), reply("shell.output", "<hang>")]
              : []),
            event("session.execution.succeeded", { sessionID: SESSION }),
            ...(stopped
              ? []
              : [
                  event(
                    "shell.exited",
                    { id: shellID, exit: exitCode, status: "exited" },
                    "shell-exit",
                  ),
                ]),
            ...(stop === "burst"
              ? Array.from({ length: 5 }, (_, page) => [
                  out("shell.output", { cursor: String(9 + page * 65536) }),
                  reply("shell.output", {
                    location: { directory: WORK },
                    data: {
                      output:
                        page === 4 ? "x".repeat(65519) + "FINAL DIAGNOSTIC\n" : "x".repeat(65536),
                      cursor: 9 + (page + 1) * 65536,
                      size: 9 + 5 * 65536,
                      truncated: false,
                    },
                  }),
                ]).flat()
              : [
                  out("shell.output", "<any>"),
                  reply("shell.output", {
                    location: { directory: WORK },
                    data: { output: "", cursor: 9, size: 9, truncated: false },
                  }),
                ]),
            ...(stopped
              ? [
                  out("shell.remove", { id: shellID, "location[directory]": WORK }),
                  event("shell.exited", { id: shellID, exit: 143, status: "exited" }),
                  reply("shell.remove", null),
                ]
              : []),
          ],
          { replayGate: gate },
        );
        const items: Array<import("@goat/contracts").OrchestrationV2TurnItem> = [];
        const shellStarted = yield* Deferred.make<void>();
        const terminal = yield* runtime.events.pipe(
          Stream.tap((e) =>
            Effect.gen(function* () {
              if (e.type !== "turn_item.updated") return;
              items.push(e.turnItem);
              if (e.turnItem.type === "command_execution" && e.turnItem.output === "retained\n")
                yield* Deferred.succeed(shellStarted, undefined);
            }),
          ),
          Stream.filter((e) => e.type === "turn.terminal"),
          Stream.runHead,
          Effect.forkScoped,
        );
        yield* runtime.startTurn(withLineage(thread));
        if (stop === "poll") {
          yield* Deferred.await(shellStarted);
          yield* TestClock.adjust("2 seconds");
        }
        yield* Fiber.join(terminal);
        assert.isTrue(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        const settled = yield* runtime.events.pipe(
          Stream.tap((e) =>
            Effect.sync(() => {
              if (e.type === "turn_item.updated") items.push(e.turnItem);
            }),
          ),
          Stream.filter(
            (e) =>
              e.type === "provider_thread.updated" &&
              e.providerThread.pendingBackgroundTasks?.length === 0,
          ),
          Stream.runHead,
          Effect.forkScoped,
        );
        if (stop === "thread")
          yield* runtime.interruptTurn({
            providerThread: thread,
            providerTurnId: yield* providerTurnId,
            requestRuntimeRestart: true,
          });
        else if (stopped) yield* runtime.stopTask!({ providerThread: thread, taskId: shellID });
        else gate.release("shell-exit");
        yield* Fiber.join(settled);
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
        assert.deepInclude(items.filter((i) => i.type === "command_execution").at(-1), {
          type: "command_execution",
          status: stopped ? "interrupted" : stop === "failed" ? "failed" : "completed",
          ...(stop === "failed" ? { exitCode: 7 } : {}),
          output: stop === "burst" ? "x".repeat(262127) + "FINAL DIAGNOSTIC\n" : "retained\n",
        });
        assert.isFalse(items.some((i) => i.type === "subagent"));
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    "shell",
    "job",
    "fallback",
    "descendant",
    "settled",
    "exited",
    "anchored",
  ] as const)("recovers only owned native shells using %s inventory", (discovery) =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2.pipe(Effect.provide(IdAllocator.layer));
      const id = "sh_recovered";
      const info = {
        id,
        command: "sleep 600",
        status: discovery === "settled" ? "exited" : "running",
        ...(discovery === "settled" ? { exit: 0 } : {}),
        cwd: WORK,
        shell: "/bin/sh",
        file: "/remote/output",
        metadata: { sessionID: SESSION },
        time: { started: 1 },
      };
      const response = (data: unknown) => ({ location: { directory: WORK }, data });
      const inventory: Array<ProviderReplayEntry> =
        discovery === "shell"
          ? []
          : [
              out("job.list", { sessionID: SESSION, kind: "shell", descendants: "true" }),
              reply(
                "job.list",
                discovery === "fallback"
                  ? { status: 404, body: {} }
                  : {
                      data: [
                        {
                          kind: "shell",
                          shellID: id,
                          sessionID: discovery === "descendant" ? "ses_descendant" : SESSION,
                          command: info.command,
                          status: discovery === "settled" ? "completed" : "running",
                        },
                      ],
                    },
              ),
            ];
      if (discovery === "shell" || discovery === "fallback")
        inventory.push(
          out("shell.list", "<any>"),
          reply(
            "shell.list",
            response([info, { ...info, id: "sh_other", metadata: { sessionID: "ses_other" } }]),
          ),
        );
      inventory.push(
        out("shell.get", { id }),
        reply("shell.get", response(info)),
        out("shell.output", { id, cursor: "0" }),
        reply(
          "shell.output",
          response({ output: "retained", cursor: 8, size: 8, truncated: false }),
        ),
      );
      const gate = makeProviderReplayGate(["recovered-exit"]);
      const { runtime, thread } = yield* resumed(
        discovery === "settled"
          ? []
          : [
              ...(discovery === "exited"
                ? [event("shell.exited", { id, exit: 0, status: "exited" }, "recovered-exit")]
                : []),
              out("shell.output", { id, cursor: "8" }),
              reply(
                "shell.output",
                response({
                  output: discovery === "exited" ? " finished" : "",
                  cursor: discovery === "exited" ? 17 : 8,
                  size: discovery === "exited" ? 17 : 8,
                  truncated: false,
                }),
              ),
              ...(discovery === "exited"
                ? []
                : [out("shell.remove", { id }), reply("shell.remove", null)]),
            ],
        {
          version: discovery === "shell" ? "2.2.1" : "2.2.6",
          shellRecovery: inventory,
          external: true,
          ...(discovery === "anchored" ? { lastRunOrdinal: 7 } : {}),
          replayGate: gate,
        },
      );
      const items: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const shellEnded = yield* Deferred.make<void>();
      const rosterEnded = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (
              event.type === "provider_thread.updated" &&
              event.sessionScoped === true &&
              event.providerThread.pendingBackgroundTasks?.length === 0
            )
              yield* Deferred.succeed(rosterEnded, undefined);
            if (event.type !== "turn_item.updated" || event.turnItem.type !== "command_execution")
              return;
            items.push(event);
            if (event.turnItem.status !== "running") yield* Deferred.succeed(shellEnded, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      assert.deepEqual(
        thread.pendingBackgroundTasks ?? [],
        discovery === "settled" ? [] : [{ taskId: id, kind: "command", description: info.command }],
      );
      assert.equal(
        yield* runtime.hasPendingBackgroundWorkForThread!(thread),
        discovery !== "settled",
      );
      yield* runtime.stopTask!({ providerThread: thread, taskId: "sh_other" });
      assert.equal(
        yield* runtime.hasPendingBackgroundWorkForThread!(thread),
        discovery !== "settled",
      );
      if (discovery === "exited") gate.release("recovered-exit");
      else yield* runtime.stopTask!({ providerThread: thread, taskId: id });
      yield* Deferred.await(shellEnded);
      yield* Deferred.await(rosterEnded);
      assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      const item = items;
      const projected = item.at(0);
      const stopped = item.at(-1);
      if (stopped?.type === "turn_item.updated" && stopped.turnItem.type === "command_execution") {
        assert.equal(
          stopped.turnItem.status,
          discovery === "settled" || discovery === "exited" ? "completed" : "interrupted",
        );
        assert.equal(
          stopped.turnItem.output,
          discovery === "exited" ? "retained finished" : "retained",
        );
        assert.equal(
          stopped.turnItem.id,
          projected?.type === "turn_item.updated" ? projected.turnItem.id : undefined,
        );
      }
      assert.equal(projected?.type, "turn_item.updated");
      if (projected?.type === "turn_item.updated") {
        assert.isTrue(
          item.every(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.runId ===
                (discovery === "anchored"
                  ? idAllocator.derive.run({ threadId, ordinal: 7 })
                  : null),
          ),
        );
        assert.deepInclude(projected.turnItem, {
          type: "command_execution",
          input: info.command,
          output: "retained",
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect.each(["remove", "lookup", "output", "timeout"] as const)(
    "continues recovering and stopping native work when shell %s fails",
    (failure) =>
      Effect.gen(function* () {
        const ids = ["sh_unreachable", "sh_stoppable"];
        const info = (id: string) => ({
          id,
          command: "sleep 600",
          status: "running",
          cwd: WORK,
          shell: "/bin/sh",
          file: "/remote/output",
          metadata: { sessionID: SESSION },
          time: { started: 1 },
        });
        const response = (data: unknown) => ({ location: { directory: WORK }, data });
        const output = (id: string) => [
          out("shell.output", { id }),
          reply("shell.output", response({ output: "", cursor: 0, size: 0, truncated: false })),
        ];
        const gate = makeProviderReplayGate(["recovery-pending", "polled"]);
        const recovery = yield* resumed(
          [
            ...backgroundLaunch(CHILD),
            ...output(ids[0]!),
            out("shell.remove", { id: ids[0] }),
            reply("shell.remove", failure === "remove" ? { status: 500, body: {} } : null),
            ...output(ids[1]!),
            out("shell.remove", { id: ids[1] }),
            reply("shell.remove", null),
            out("session.interrupt", { sessionID: CHILD }),
            reply("session.interrupt", { interrupted: true }),
            out("session.interrupt", { sessionID: SESSION }),
            reply("session.interrupt", { interrupted: true }),
            event("session.execution.interrupted", { sessionID: SESSION }),
            ...(failure === "remove"
              ? [
                  ...output(ids[0]!),
                  out("shell.remove", { id: ids[0] }),
                  reply("shell.remove", null),
                ]
              : []),
          ],
          {
            version: "2.2.1",
            replayGate: gate,
            shellRecovery: [
              out("shell.list", "<any>"),
              reply("shell.list", response(ids.map(info))),
              ...(failure === "timeout"
                ? [
                    out("shell.get", { id: ids[0] }),
                    reply("shell.get", "<hang>"),
                    event(
                      "session.execution.succeeded",
                      { sessionID: "ses_unrelated" },
                      "recovery-pending",
                    ),
                    ...ids.map((id) => out("shell.output", { id })),
                    ...ids.map(() =>
                      reply(
                        "shell.output",
                        response({ output: "", cursor: 0, size: 0, truncated: false }),
                      ),
                    ),
                    event("session.execution.succeeded", { sessionID: "ses_unrelated" }, "polled"),
                  ]
                : ids.flatMap((id) => [
                    out("shell.get", { id }),
                    reply(
                      "shell.get",
                      id === ids[0] && failure === "lookup"
                        ? { status: 500, body: {} }
                        : response(info(id)),
                    ),
                    ...(id === ids[0] && failure === "lookup"
                      ? []
                      : id === ids[0] && failure === "output"
                        ? [
                            out("shell.output", { id }),
                            reply("shell.output", { status: 500, body: {} }),
                          ]
                        : output(id)),
                  ])),
            ],
          },
        ).pipe(Effect.forkScoped);
        if (failure === "timeout") {
          yield* Effect.promise(() => gate.waitForReached("recovery-pending"));
          yield* TestClock.adjust("5 seconds");
        }
        const { runtime, thread } = yield* Fiber.join(recovery);
        const recovered = yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.pendingBackgroundTasks?.length === 2,
          ),
          Stream.runCollect,
        );
        assert.sameMembers(
          recovered.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
              ? [event.turnItem.nativeItemRef?.nativeId]
              : [],
          ),
          ids,
        );
        if (failure === "timeout") {
          gate.release("recovery-pending");
          yield* Effect.promise(() => gate.waitForReached("polled"));
          gate.release("polled");
        }
        const watch = yield* watchBackgroundTurn(runtime);
        yield* runtime.startTurn(withLineage(thread));
        yield* watch.attached;
        yield* runtime.interruptTurn({
          providerThread: thread,
          providerTurnId: yield* providerTurnId,
          requestRuntimeRestart: true,
        });
        assert.equal((yield* watch.terminal)?.status, "interrupted");
        assert.equal(
          yield* runtime.hasPendingBackgroundWorkForThread!(thread),
          failure === "remove",
        );
        if (failure === "remove")
          yield* runtime.stopTask!({ providerThread: thread, taskId: ids[0]! });
        assert.isFalse(yield* runtime.hasPendingBackgroundWorkForThread!(thread));
      }).pipe(Effect.scoped),
  );
});
