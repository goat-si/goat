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
