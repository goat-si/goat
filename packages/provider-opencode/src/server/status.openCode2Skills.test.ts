import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import {
  checkOpenCodeProviderStatus,
  loadOpenCode2GlobalSkills,
  type OpenCode2Workspace,
} from "./status.ts";

const settings = Schema.decodeSync(OpenCodeSettings)({ enabled: true });
const builtinSkills: OpenCode2Workspace["skills"] = [
  { id: "opencode", name: "OpenCode", path: "skill://opencode/SKILL.md" },
  { id: "report", name: "Report", path: "skill://report/SKILL.md" },
];

const checkOpenCode2 = (
  skills: Effect.Effect<OpenCode2Workspace["skills"], OpenCodeRuntime.OpenCodeRuntimeError>,
) =>
  checkOpenCodeProviderStatus(
    settings,
    process.cwd(),
    Effect.succeed({ generation: "v2", version: "2.2.7" }),
    Effect.succeed([
      { providerID: "opencode", id: "big-pickle", name: "Big Pickle", variants: [] },
    ]),
    skills,
  ).pipe(
    Effect.provideService(
      OpenCodeRuntime.OpenCodeRuntime,
      {} as OpenCodeRuntime.OpenCodeRuntime["Service"],
    ),
    Effect.provideService(
      OpenCodeServerOwner.OpenCodeServerOwner,
      {} as OpenCodeServerOwner.OpenCodeServerOwner["Service"],
    ),
  );

it.effect("lists OpenCode 2 global skills on the provider without a workspace snapshot", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCode2(
      Effect.succeed([
        {
          id: "review",
          name: "Review",
          path: "/Users/test/.agents/skills/review/SKILL.md",
          description: "Review a change.",
        },
      ]),
    );

    NodeAssert.deepEqual(snapshot.skills, [
      {
        name: "review",
        path: "/Users/test/.agents/skills/review/SKILL.md",
        enabled: true,
        displayName: "Review",
        description: "Review a change.",
        shortDescription: "Review a change.",
      },
    ]);
  }),
);

it.effect("keeps OpenCode 2 ready when its skill list fails", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkOpenCode2(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "skill.list",
          detail: "The OpenCode server could not list its skills.",
        }),
      ),
    );

    NodeAssert.equal(snapshot.status, "ready");
    NodeAssert.deepEqual(snapshot.skills, []);
  }),
);

it.effect("reads OpenCode 2 global skills again while a cold server is still scanning", () =>
  Effect.gen(function* () {
    const reads: Array<OpenCode2Workspace["skills"]> = [[], builtinSkills];
    const load = yield* loadOpenCode2GlobalSkills(Effect.sync(() => reads.shift() ?? [])).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("250 millis");
    NodeAssert.deepEqual(yield* Fiber.join(load), builtinSkills);
  }),
);
