import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@goat/shared/HostProcess";
import { makeCodexSkillsProbe } from "./CodexSkillsProbe.ts";
function makeFakeCodexAppServers() {
  const helpers: Array<{
    readonly codexHome: unknown;
    readonly crash: Effect.Effect<void>;
    readonly requests: Array<unknown>;
    closed: boolean;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const crash = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(1)).pipe(
        Effect.andThen(Queue.end(output)),
        Effect.asVoid,
      );
      const helper = {
        codexHome: command._tag === "StandardCommand" ? command.options.env?.CODEX_HOME : undefined,
        crash,
        requests: [] as Array<unknown>,
        closed: false,
      };
      helpers.push(helper);
      yield* Effect.addFinalizer(() => Effect.sync(() => (helper.closed = true)));
      const respond = (id: unknown, result: unknown) =>
        Queue.offer(output, new TextEncoder().encode(`${JSON.stringify({ id, result })}\n`));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_000 + helpers.length),
        exitCode: Deferred.await(exited),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () => crash,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: string | Uint8Array) =>
          Effect.forEach(
            (typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
              .split("\n")
              .filter(Boolean),
            (line) => {
              const frame = JSON.parse(line) as {
                readonly id?: number;
                readonly method: string;
                readonly params?: { readonly cwds: ReadonlyArray<string> };
              };
              if (frame.id === undefined) return Effect.void;
              if (frame.method === "initialize") {
                return respond(frame.id, {
                  codexHome: "/codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                  userAgent: "codex/0.0.0",
                });
              }
              helper.requests.push(frame.params);
              return respond(frame.id, {
                data: (frame.params?.cwds ?? []).map((cwd) => ({
                  cwd,
                  errors: [],
                  skills: [
                    {
                      name: `skill-in-${cwd}`,
                      path: `${cwd}/SKILL.md`,
                      enabled: true,
                      description: "",
                      scope: "repo",
                    },
                  ],
                })),
              });
            },
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { helpers, spawner };
}

it.effect("reuses one Codex skills helper per launch until it idles out", () =>
  Effect.gen(function* () {
    const { helpers, spawner } = makeFakeCodexAppServers();
    const providerScope = yield* Scope.make();
    const probe = yield* makeCodexSkillsProbe().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Scope.provide(providerScope),
    );
    const read = (cwd: string, homePath = "/home-a") =>
      probe({ binaryPath: "codex", homePath, cwd, environment: {} }).pipe(
        Effect.map((skills) => skills.map((skill) => skill.name)),
      );

    assert.deepStrictEqual(yield* read("/alpha"), ["skill-in-/alpha"]);
    assert.deepStrictEqual(yield* read("/beta"), ["skill-in-/beta"]);
    assert.strictEqual(helpers.length, 1);
    assert.deepStrictEqual(helpers[0]!.requests, [
      { cwds: ["/alpha"], forceReload: true },
      { cwds: ["/beta"], forceReload: true },
    ]);

    // Another home is another launch identity; the previous helper retires at once.
    assert.deepStrictEqual(yield* read("/alpha", "/home-b"), ["skill-in-/alpha"]);
    assert.strictEqual(helpers.length, 2);
    assert.strictEqual(helpers[0]!.closed, true);
    assert.strictEqual(helpers[1]!.codexHome, "/home-b");

    // A helper that exits is replaced within the same read.
    yield* helpers[1]!.crash;
    assert.deepStrictEqual(yield* read("/beta", "/home-b"), ["skill-in-/beta"]);
    assert.strictEqual(helpers.length, 3);

    yield* TestClock.adjust("29 seconds");
    assert.strictEqual(helpers[2]!.closed, false);
    yield* TestClock.adjust("1 second");
    assert.strictEqual(helpers[2]!.closed, true);
    assert.deepStrictEqual(yield* read("/alpha", "/home-b"), ["skill-in-/alpha"]);
    assert.strictEqual(helpers.length, 4);

    yield* Scope.close(providerScope, Exit.void);
    assert.strictEqual(helpers[3]!.closed, true);
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);
