import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { loadOpenCode2Workspace, type OpenCode2Workspace } from "./status.ts";

const builtinCommands = [
  { name: "init", description: "guided AGENTS.md setup" },
  { name: "review", description: "review changes [commit|branch|pr], defaults to uncommitted" },
];
const builtinSkills = [
  { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md" },
  { id: "report", name: "Report", path: "/builtin/report.md" },
];
const scanned: OpenCode2Workspace = {
  commands: [...builtinCommands, { name: "hello", description: "Say hello to the workspace" }],
  skills: [
    ...builtinSkills,
    {
      id: "greet",
      name: "greet",
      path: "/work/.opencode/skills/greet/SKILL.md",
      description: "Greets the user with the secret word MANGO.",
    },
  ],
};

it.effect(
  "reads a loaded OpenCode 2 directory listing no commands again once its scan has ended",
  () =>
    Effect.gen(function* () {
      const reads: Array<OpenCode2Workspace> = [{ commands: [], skills: [] }, scanned];
      const scanEnded = yield* Deferred.make<void>();
      const firstRead = yield* Deferred.make<void>();
      const load = yield* loadOpenCode2Workspace(
        Effect.sync(() => reads.shift()!).pipe(
          Effect.tap(() => Deferred.succeed(firstRead, undefined)),
        ),
        Deferred.await(scanEnded),
        Effect.succeed(true),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstRead);
      NodeAssert.equal(reads.length, 1);
      yield* Deferred.succeed(scanEnded, undefined);
      NodeAssert.deepEqual(yield* Fiber.join(load), scanned);
    }),
);

it.effect("waits for the scan of a cold OpenCode 2 directory that first lists only built-ins", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const reads: Array<OpenCode2Workspace> = [
      { commands: builtinCommands, skills: builtinSkills },
      scanned,
    ];
    const workspace = yield* loadOpenCode2Workspace(
      Effect.sync(() => (calls.push("read"), reads.shift()!)),
      Effect.sync(() => void calls.push("scanned")),
      Effect.sync(() => (calls.push("loaded"), false)),
    );
    NodeAssert.deepEqual(workspace, scanned);
    NodeAssert.deepEqual(calls, ["loaded", "read", "scanned", "read"]);
  }),
);

it.effect("reads an already loaded OpenCode 2 directory once without waiting for a scan", () =>
  Effect.gen(function* () {
    const calls: Array<string> = [];
    const workspace = yield* loadOpenCode2Workspace(
      Effect.sync(() => (calls.push("read"), scanned)),
      Effect.sync(() => void calls.push("scanned")),
      Effect.succeed(true),
    );
    NodeAssert.deepEqual(workspace, scanned);
    NodeAssert.deepEqual(calls, ["read"]);
  }),
);
