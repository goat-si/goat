import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProviderCommandNotFoundError } from "@goat/provider-core/server/snapshotProbe";
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

it.effect("does not report an EIO spawn error as missing when the path contains enoent", () =>
  Effect.gen(function* () {
    const error = new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "runOpenCodeCommand",
      detail: "spawn /tmp/enoent/opencode EIO",
      cause: { spawnCwd: process.cwd(), cause: { code: "EIO" } },
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
  }),
);

it.effect("reports structured Windows command-not-found evidence as missing", () =>
  Effect.gen(function* () {
    const error = new OpenCodeRuntime.OpenCodeRuntimeError({
      operation: "runOpenCodeCommand",
      detail: "command could not be found",
      cause: new ProviderCommandNotFoundError({
        binaryPath: "opencode.cmd",
        exitCode: 9009,
        stdoutLength: 0,
        stderrLength: 1,
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
    expect(snapshot.installed).toBe(false);
  }),
);
