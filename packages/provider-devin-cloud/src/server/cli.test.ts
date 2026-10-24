import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { ProviderSessionId } from "@goat/contracts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@goat/provider-core/server/failure";
import { ProviderAdapterOpenSessionError } from "@goat/provider-core/server/ProviderAdapter";
import { DRIVER } from "./capabilities.ts";
import { cloudVersionSupported, DevinCloudCliError, probeCli, type CliResult } from "./cli.ts";

it("gates exact numeric version and rejects malformed/prerelease output", () => {
  assert.isFalse(cloudVersionSupported("3000.10.21 (old)"));
  assert.isFalse(cloudVersionSupported("3000.11.0"));
  assert.isTrue(cloudVersionSupported("3000.11.1 (stable)"));
  assert.isTrue(cloudVersionSupported("3000.11.3 (installed)"));
  assert.isTrue(cloudVersionSupported("3000.12.0"));
  assert.isFalse(cloudVersionSupported("3000.11.1-beta"));
  assert.isFalse(cloudVersionSupported("unrecognized"));
  assert.isTrue(cloudVersionSupported("devin 3000.11.3 (build-fixture)"));
  assert.isTrue(cloudVersionSupported("devin 3001.0.0 (build-fixture)"));
  assert.isFalse(cloudVersionSupported("devin 3000.11.0 (build-fixture)"));
  assert.isFalse(cloudVersionSupported("devin 3000.11.1-beta (build-fixture)"));
});
it.effect("readiness invokes only version/help/auth and ignores account output", () =>
  Effect.gen(function* () {
    const calls: ReadonlyArray<string>[] = [];
    const results: CliResult[] = [
      { exitCode: 0, stdout: "devin 3000.11.3 (build-fixture)", stderr: "" },
      { exitCode: 0, stdout: "--cloud Relay", stderr: "" },
      {
        exitCode: 0,
        stdout: "Logged in (via Devin).\n\nUser:\n  Email:             example@acme.example",
        stderr: "",
      },
    ];
    const readiness = yield* probeCli((args) =>
      Effect.sync(() => {
        calls.push(args);
        return results[calls.length - 1]!;
      }),
    );
    assert.deepEqual(readiness, { version: "3000.11.3", email: "example@acme.example" });
    assert.deepEqual(calls, [["--version"], ["acp", "--help"], ["auth", "status"]]);
  }),
);
it.effect("old selected binary stops before auth or any relay invocation", () =>
  Effect.gen(function* () {
    const calls: ReadonlyArray<string>[] = [];
    const result = yield* Effect.result(
      probeCli((args) =>
        Effect.sync(() => {
          calls.push(args);
          return { exitCode: 0, stdout: "3000.10.21", stderr: "" };
        }),
      ),
    );
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.equal(result.failure.stage, "version");
    assert.deepEqual(calls, [["--version"]]);
  }),
);
it.effect("missing relay flag and unauthenticated status fail closed", () =>
  Effect.gen(function* () {
    for (const mode of ["missing-cloud", "signed-out"] as const) {
      let call = 0;
      const result = yield* Effect.result(
        probeCli(() =>
          Effect.sync(() => {
            call++;
            if (call === 1) return { exitCode: 0, stdout: "3000.11.3", stderr: "" };
            if (call === 2)
              return {
                exitCode: 0,
                stdout: mode === "missing-cloud" ? "acp local" : "--cloud",
                stderr: "",
              };
            return { exitCode: 1, stdout: "Not logged in", stderr: "" };
          }),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.equal(result.failure.stage, mode === "missing-cloud" ? "relay" : "auth");
      assert.equal(call, mode === "missing-cloud" ? 2 : 3);
    }
  }),
);

it.effect("nonzero exit and unexpected auth output fail without exposing process output", () =>
  Effect.gen(function* () {
    for (const failedCall of [1, 2, 3]) {
      let call = 0;
      const result = yield* Effect.result(
        probeCli(() =>
          Effect.sync(() => {
            call++;
            const stdout =
              call === 1
                ? "devin 3000.11.3 (fixture)"
                : call === 2
                  ? "--cloud"
                  : "Logged in (via Devin).";
            return {
              exitCode: call === failedCall ? 1 : 0,
              stdout,
              stderr: "Synthetic sensitive diagnostic",
            };
          }),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(
          result.failure.stage,
          failedCall === 1 ? "version" : failedCall === 2 ? "relay" : "auth",
        );
        assert.notInclude(result.failure.message, "Synthetic sensitive diagnostic");
      }
      assert.equal(call, failedCall);
    }
    let call = 0;
    const unexpected = yield* Effect.result(
      probeCli(() =>
        Effect.sync(() => {
          call++;
          return {
            exitCode: 0,
            stdout:
              call === 1
                ? "devin 3000.11.3"
                : call === 2
                  ? "--cloud"
                  : "Account: example@acme.example",
            stderr: "",
          };
        }),
      ),
    );
    assert.isTrue(Result.isFailure(unexpected));
    if (Result.isFailure(unexpected)) {
      assert.equal(unexpected.failure.stage, "auth");
      assert.notInclude(unexpected.failure.message, "example@acme.example");
    }
  }),
);

it("a launch that cannot open Devin Cloud reports the CLI's own reason, never raw relay text", () => {
  const opened = (cause: DevinCloudCliError) =>
    new ProviderAdapterOpenSessionError({
      driver: DRIVER,
      providerSessionId: ProviderSessionId.make("session-fixture"),
      cause,
    });
  // ProviderTurnStartService shows this message when opening the session fails.
  assert.equal(
    knownProviderFailureMessage(opened(new DevinCloudCliError({ stage: "auth" }))),
    "Sign in to Devin to use Devin Cloud.",
  );
  assert.equal(
    knownProviderFailureMessage(opened(new DevinCloudCliError({ stage: "version" }))),
    "Update the Devin CLI to 3000.11.1 or newer.",
  );
  assert.equal(
    makeProviderFailure({ cause: opened(new DevinCloudCliError({ stage: "auth" })) }).message,
    "Sign in to Devin to use Devin Cloud.",
  );
  // Relay details can carry the vendor's own error text.
  assert.isUndefined(
    knownProviderFailureMessage(
      opened(new DevinCloudCliError({ stage: "relay", detail: "vendor token=fixture-secret" })),
    ),
  );
  // Only known CLI stages count; a decoded error without one is not trusted.
  assert.isUndefined(
    knownProviderFailureMessage({
      _tag: "DevinCloudCliError",
      message: "vendor /fixture/private-path",
    }),
  );
});
