// @effect-diagnostics nodeBuiltinImport:off -- exercise the real child process lifecycle.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as ProcessRunner from "./processRunner.ts";
import { makeTempDir } from "./git/testkit/fileFixtures.ts";

it.live("closes the child scope when a process rejects its stdin", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTempDir("goat-stdin-failure-");
    const marker = NodePath.join(cwd, "child.pid");
    const script = NodePath.join(cwd, "child.cjs");
    NodeFS.writeFileSync(
      script,
      "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], String(process.pid)); fs.closeSync(0); setInterval(() => {}, 1000);\n",
    );
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner
      .run({
        command: NodeProcess.execPath,
        args: [script, marker],
        cwd,
        stdin: "a".repeat(4_000_000),
      })
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.equal(result.failure._tag, "ProcessStdinError");
    const pid = Number(NodeFS.readFileSync(marker, "utf8"));
    assert.throws(() => NodeProcess.kill(pid, 0));
  }).pipe(Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer), Effect.scoped),
);
