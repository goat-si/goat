import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OpenCodeSettings } from "../settings.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";
import { checkOpenCodeProviderStatus } from "./status.ts";

const settings = Schema.decodeSync(OpenCodeSettings);

it.effect("reports a missing version probe cwd instead of a missing OpenCode executable", () =>
  Effect.gen(function* () {
    const cwd = "/goat-test-missing-opencode-cwd-498";
    const error = new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "runOpenCodeCommand",
      detail: "spawn opencode ENOENT",
      cause: Object.assign(new Error("spawn opencode ENOENT"), {
        spawnCwd: cwd,
        cause: { code: "ENOENT" },
      }),
    });
    const snapshot = yield* checkOpenCodeProviderStatus(
      settings({ enabled: true }),
      process.cwd(),
      Effect.fail(error),
      Effect.succeed([]),
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
    expect(snapshot.installed).toBe(true);
    expect(snapshot.message).toContain(cwd);
  }),
);

it.effect("reports a missing executable from the nested spawn cause", () =>
  Effect.gen(function* () {
    const error = new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "runOpenCodeCommand",
      detail: "could not start process",
      cause: { spawnCwd: process.cwd(), cause: { code: "ENOENT" } },
    });
    const snapshot = yield* checkOpenCodeProviderStatus(
      settings({ enabled: true }),
      process.cwd(),
      Effect.fail(error),
      Effect.succeed([]),
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
    expect(snapshot.installed).toBe(false);
  }),
);
