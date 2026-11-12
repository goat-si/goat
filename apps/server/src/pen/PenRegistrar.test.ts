// @effect-diagnostics nodeBuiltinImport:off -- a scratch fake pen executable stands in for the real one.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { register } from "./PenRegistrar.ts";

const scratch = (script: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-pen-register-"));
      const executablePath = NodePath.join(dir, "pen");
      await NodeFSP.writeFile(executablePath, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      return { dir, executablePath };
    }),
    ({ dir }) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );

const HOLDS = [
  'printf "%s\\n" "$*" > "$PEN_HOME/argv"',
  'env > "$PEN_HOME/env"',
  'IFS= read -r key; printf "%s" "$key" > "$PEN_HOME/key"',
  "echo 'pen-service v1 registered goat abcdefghijklmnopqrstuvwxyz'",
  "cat > /dev/null",
].join("\n");

it.live("registers as goat with K on stdin only and lets go when its scope closes", () =>
  Effect.gen(function* () {
    const { dir, executablePath } = yield* scratch(HOLDS);
    const key = NodeCrypto.randomBytes(32);
    const scope = yield* Scope.make();
    const registration = yield* register({ executablePath, stateDir: dir, port: 4321, key }).pipe(
      Scope.provide(scope),
    );
    expect(registration.id).toBe("abcdefghijklmnopqrstuvwxyz");
    const read = (name: string) =>
      Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, name), "utf8"));
    expect(yield* read("argv")).toBe("service register goat --port 4321\n");
    expect(yield* read("key")).toBe(key.toString("base64url"));
    const env = yield* read("env");
    expect(env).toContain(`PEN_HOME=${dir}`);
    expect(env).not.toContain(key.toString("base64url"));
    expect(env).not.toMatch(/^GOAT_/mu);
    expect(yield* Deferred.isDone(registration.lost)).toBe(false);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(registration.lost);
  }).pipe(Effect.scoped),
);

it.live(
  "reports a refusal or a wrong answer, and marks the registration lost when its child exits",
  () =>
    Effect.gen(function* () {
      const refused = yield* scratch("echo 'pen service: no pen daemon is running' >&2\nexit 2");
      const error = yield* register({
        executablePath: refused.executablePath,
        stateDir: refused.dir,
        port: 4321,
        key: NodeCrypto.randomBytes(32),
      }).pipe(Effect.flip);
      expect(error.reason).toBe("pen service: no pen daemon is running");
      const exiting = yield* scratch(
        [
          "IFS= read -r key",
          "echo 'pen-service v1 registered goat abc'",
          "IFS= read -r wait_for_release",
          "exit 3",
        ].join("\n"),
      );
      const wrong = yield* scratch(
        "IFS= read -r key\necho 'pen-service v1 registered other abc'\ncat > /dev/null",
      );
      expect(
        (yield* register({
          executablePath: wrong.executablePath,
          stateDir: wrong.dir,
          port: 4321,
          key: NodeCrypto.randomBytes(32),
        }).pipe(Effect.flip)).reason,
      ).toBe("pen answered something other than its registered line");
      const scope = yield* Scope.make();
      const registration = yield* register({
        executablePath: exiting.executablePath,
        stateDir: exiting.dir,
        port: 4321,
        key: NodeCrypto.randomBytes(32),
      }).pipe(Scope.provide(scope));
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(registration.lost);
    }).pipe(Effect.scoped),
);
