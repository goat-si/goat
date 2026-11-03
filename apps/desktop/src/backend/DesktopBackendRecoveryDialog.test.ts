import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeRecoveryDialog } from "./DesktopBackendRecoveryDialog.ts";
it.effect("Retry, Stop, Open logs and dismissal preserve their distinct outcomes", () =>
  Effect.gen(function* () {
    for (const response of [0, 1, 2, 3]) {
      const outcomes: string[] = [];
      const show = makeRecoveryDialog(
        {
          showMessageBox: () => Effect.succeed({ response, checkboxChecked: false }),
        },
        (path) =>
          Effect.sync(() => {
            outcomes.push(path);
          }),
      );
      yield* show({
        label: "Test server",
        reason: "crash-loop",
        retry: Effect.sync(() => {
          outcomes.push("retry");
        }),
        stop: Effect.sync(() => {
          outcomes.push("stop");
        }),
        logPath: "/isolated/logs",
      });
      assert.deepEqual(
        outcomes,
        response === 3 ? [] : [["retry"], ["stop"], ["/isolated/logs"]][response],
      );
    }
  }),
);

it.effect("slow crash information opens logs only when requested", () =>
  Effect.gen(function* () {
    for (const response of [0, 1]) {
      const opened: string[] = [];
      const show = makeRecoveryDialog(
        {
          showMessageBox: (options) => {
            assert.deepEqual(options.buttons, ["Open logs", "Close"]);
            assert.equal(options.type, "info");
            return Effect.succeed({ response, checkboxChecked: false });
          },
        },
        (path) =>
          Effect.sync(() => {
            opened.push(path);
          }),
      );
      yield* show({
        label: "Test",
        reason: "slow-crash",
        history: [{ at: 0, outcome: "exit" }],
        retry: Effect.die("unexpected"),
        stop: Effect.die("unexpected"),
        logPath: "/logs",
      });
      assert.deepEqual(opened, response === 0 ? ["/logs"] : []);
    }
  }),
);

it.effect("separate servers can show their recovery dialogs in sequence", () =>
  Effect.gen(function* () {
    const shown: string[] = [];
    const dialog = {
      showMessageBox: (options: { readonly message?: string }) =>
        Effect.sync(() => {
          shown.push(options.message ?? "");
          return { response: 1, checkboxChecked: false };
        }),
    };
    const first = makeRecoveryDialog(dialog, () => Effect.void);
    const second = makeRecoveryDialog(dialog, () => Effect.void);
    for (const [label, show] of [
      ["one", first],
      ["two", second],
    ] as const) {
      yield* show({
        label,
        reason: "slow-crash",
        history: [{ at: 0, outcome: "exit" }],
        retry: Effect.void,
        stop: Effect.void,
        logPath: "/logs",
      });
    }
    assert.deepEqual(shown, [
      "one: the server keeps restarting",
      "two: the server keeps restarting",
    ]);
  }),
);
