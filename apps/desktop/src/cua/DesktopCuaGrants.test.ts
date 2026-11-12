import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

import { ComputerUseHelperError } from "./ComputerUseHelper.ts";
import { fixture, HELPER_BUNDLE, HELPER_ID } from "./DesktopCuaDriver.testkit.ts";

/** The grant read lines a test's driver logged, in order, and the fields of the spans around them. */
function grantReadLog() {
  const lines: unknown[] = [];
  const spans: Tracer.Span[] = [];
  const logger = Logger.make(({ message }) => {
    const [text, line] = Array.isArray(message) ? message : [message];
    if (text === "Computer use grant read changed") lines.push(line);
  });
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      if (span.name === "desktop.cua.grantRead") spans.push(span);
      return span;
    },
  });
  return {
    lines,
    spanFields: () => spans.map((span) => Object.fromEntries(span.attributes)),
    layer: Layer.merge(
      Logger.layer([logger], { mergeWithExisting: false }),
      Layer.succeed(Tracer.Tracer, tracer),
    ),
  };
}

describe("DesktopCuaDriver grants for setup", () => {
  it.effect("reports the helper's own grants for setup, never GOAT's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // GOAT holds no grants and the helper holds both: setup must see the helper's answer.
        const helper = yield* fixture({
          platform: "darwin",
          denyPermissions: true,
          helper: { granted: true },
        });
        const grants = yield* helper.grants;
        assert.deepEqual(grants, {
          principal: "helper",
          name: "GOAT Computer Use",
          bundlePath: HELPER_BUNDLE,
          bundleId: HELPER_ID,
          accessibility: true,
          screenRecording: true,
        });
        // Read without prompting, from a fresh helper each time.
        yield* helper.grants;
        assert.deepEqual(helper.helperProbes, [
          { bundleId: HELPER_ID, prompt: false },
          { bundleId: HELPER_ID, prompt: false },
        ]);

        const broken = yield* fixture({ platform: "darwin", helper: "unusable" });
        assert.deepEqual(yield* broken.grants, {
          principal: "unusable",
          message: "GOAT Computer Use at /Helpers cannot be used (EACCES).",
        });

        // A development build without the helper still runs as GOAT, so GOAT's grants are the ones
        // to set up. A packaged macOS build without it has no computer use at all (#1618).
        const app = yield* fixture({
          platform: "darwin",
          denyPermissions: true,
          isPackaged: false,
        });
        const own = yield* app.grants;
        const packaged = yield* fixture({ platform: "darwin", denyPermissions: true });
        assert.equal((yield* packaged.grants).principal, "unusable");
        assert.equal(own.principal, "app");
        assert.isFalse(own.principal === "app" && own.accessibility);
        assert.isEmpty(app.helperProbes);
      }),
    ),
  );

  it.effect("reports a helper that answers as another app or garbled as unusable for good", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mismatched = yield* fixture({
          platform: "darwin",
          helper: {
            granted: true,
            fails: new ComputerUseHelperError(
              "bundle_mismatch",
              "GOAT Computer Use is si.goat.desktop.dev.computer-use, expected si.goat.desktop.computer-use.",
            ),
          },
        });
        assert.deepEqual(yield* mismatched.grants, {
          principal: "unusable",
          message:
            "GOAT Computer Use cannot be used: GOAT Computer Use is si.goat.desktop.dev.computer-use, expected si.goat.desktop.computer-use.",
        });

        // decodeGrants throws a plain schema error for an answer of the wrong shape.
        const malformed = yield* fixture({
          platform: "darwin",
          helper: { granted: true, fails: new Error('Expected boolean, got "yes"') },
        });
        assert.deepEqual(yield* malformed.grants, {
          principal: "unusable",
          message:
            "GOAT Computer Use cannot be used: its answer about permissions could not be read.",
        });
      }),
    ),
  );

  it.effect.each([
    ["no_hello", "noHello", "it did not answer when started"],
    ["helper_exited", "stopped", "it stopped before it answered"],
    ["timeout", "tookTooLong", "it took too long"],
    ["untrusted_parent", "refused", "it refused GOAT"],
  ] as const)(
    "reports a helper whose read fails with %s as not answering, with the reason, never as a permission that is off",
    ([code, unanswered, words]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform: "darwin",
            helper: {
              granted: true,
              fails: new ComputerUseHelperError(code, "The helper said so."),
            },
          });
          assert.deepEqual(yield* test.grants, {
            principal: "unusable",
            message: `GOAT Computer Use did not answer: ${words}.`,
            unanswered,
          });
        }),
      ),
  );

  it.effect(
    "logs one line when what a grant read found changes, naming the copy asked, and none per poll",
    () => {
      const log = grantReadLog();
      const asked = { channel: "stable", bundlePath: HELPER_BUNDLE, bundleId: HELPER_ID };
      return Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({ platform: "darwin", helper: { granted: false } });
          yield* test.grants;
          yield* test.grants;
          const off = { read: "setup", ...asked, accessibility: false, screenRecording: false };
          assert.deepEqual(log.lines, [off]);
          yield* test.answerAsHelper({
            granted: true,
            fails: new ComputerUseHelperError("no_hello", "GOAT Computer Use did not answer."),
          });
          yield* test.grants;
          yield* test.grants;
          assert.deepEqual(log.lines, [off, { read: "setup", ...asked, error: "no_hello" }]);

          // The panel beside System Settings and the readiness check are told apart from setup.
          const target = yield* test.grantTarget;
          assert.equal(target.kind, "helper");
          if (target.kind !== "helper") return;
          yield* Effect.exit(target.read("panel"));
          yield* Effect.exit(target.read("panel"));
          yield* test.verify;
          yield* test.answerAsHelper({ granted: true });
          yield* Effect.exit(target.read("panel"));
          assert.deepEqual(log.lines.slice(2), [
            { read: "panel", ...asked, error: "no_hello" },
            { read: "verification", ...asked, error: "no_hello", failedStep: "grants" },
            { read: "panel", ...asked, accessibility: true, screenRecording: true },
          ]);
          // The span carries the same fields, so the local trace has them whatever logger runs.
          assert.deepEqual(log.spanFields(), log.lines);
        }),
      ).pipe(Effect.provide(log.layer));
    },
  );

  it.effect(
    "logs a fixed code for a helper error it does not know, so no text the helper chose reaches the line",
    () => {
      const log = grantReadLog();
      const leaked = "/Users/someone/Documents/taxes.pdf: permission denied";
      return Effect.scoped(
        Effect.gen(function* () {
          const test = yield* fixture({
            platform: "darwin",
            helper: { granted: true, fails: new ComputerUseHelperError(leaked, leaked) },
          });
          yield* test.grants;
          yield* test.verify;
          const target = yield* test.grantTarget;
          if (target.kind === "helper") yield* Effect.exit(target.read("panel"));
          assert.deepEqual(
            log.lines.map((line) => (line as { error?: string }).error),
            ["unknown_helper_error", "unknown_helper_error", "unknown_helper_error"],
          );
          for (const fields of [...log.lines, ...log.spanFields()])
            assert.notInclude(Object.values(fields as object).join(" "), "someone");
        }),
      ).pipe(Effect.provide(log.layer));
    },
  );
});
