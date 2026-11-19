import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { makeCodexSkillsPool } from "./CodexSkillsPool.ts";
import { codexSkillsIdentity } from "./CodexSkillsProbe.ts";

it("keys helpers by binary, home, profile, environment and routing, not workspace", () => {
  const input = {
    binaryPath: "/bin/codex-a",
    homePath: "/home/a",
    launchArgs: "--profile one",
    cwd: "/work/a",
    environment: { TOKEN: "one", PATH: "/bin" },
  };
  const key = codexSkillsIdentity(input, ["-c", "model_provider=openai"]);
  assert.equal(
    key,
    codexSkillsIdentity({ ...input, cwd: "/work/b", environment: { PATH: "/bin", TOKEN: "one" } }, [
      "-c",
      "model_provider=openai",
    ]),
  );
  for (const changed of [
    { ...input, binaryPath: "/bin/codex-b" },
    { ...input, homePath: "/home/b" },
    { ...input, launchArgs: "--profile two" },
    { ...input, environment: { TOKEN: "two", PATH: "/bin" } },
  ])
    assert.notEqual(key, codexSkillsIdentity(changed, ["-c", "model_provider=openai"]));
  assert.notEqual(key, codexSkillsIdentity(input, ["-c", "model_provider=other"]));
});

it.effect(
  "reuses a helper across workspaces, separates launch identities and expires idle helpers",
  () =>
    Effect.gen(function* () {
      const opened: Array<{ identity: string; closed: boolean }> = [];
      const scope = yield* Scope.make();
      const pool = yield* makeCodexSkillsPool((identity: string) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const helper = { identity, closed: false };
            opened.push(helper);
            return helper;
          }),
          (helper) =>
            Effect.sync(() => {
              helper.closed = true;
            }),
        ),
      ).pipe(Scope.provide(scope));
      assert.equal(
        yield* pool("home-a:profile-1", (helper) => Effect.succeed(`${helper.identity}:/a`)),
        "home-a:profile-1:/a",
      );
      assert.equal(
        yield* pool("home-a:profile-1", (helper) => Effect.succeed(`${helper.identity}:/b`)),
        "home-a:profile-1:/b",
      );
      assert.equal(opened.length, 1);
      yield* pool("home-b:profile-1", () => Effect.void);
      assert.equal(opened.length, 2);
      assert.isTrue(opened[0]!.closed);
      yield* TestClock.adjust("30 seconds");
      assert.isTrue(opened[1]!.closed);
      yield* pool("home-b:profile-1", () => Effect.void);
      assert.equal(opened.length, 3);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(opened[2]!.closed);
    }),
);

it.effect("retires a failed helper and retries with a fresh one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let spawns = 0;
      const pool = yield* makeCodexSkillsPool((_identity: string) => Effect.sync(() => ++spawns));
      const value = yield* pool("same", (generation) =>
        generation === 1 ? Effect.fail("exited") : Effect.succeed(generation),
      );
      assert.equal(value, 2);
      assert.equal(spawns, 2);
    }),
  ),
);
