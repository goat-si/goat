import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { publishSlowCrash } from "./DesktopBackendSlowCrash.ts";

it.effect("a failed notice records the pattern and its delivery failure", () =>
  Effect.gen(function* () {
    const records: Array<{ message: string; level: string; details?: string }> = [];
    const history = [0, 1, 2, 3].map((n) => ({ at: n * 60_000, outcome: "code=1" }));
    yield* publishSlowCrash(
      { label: "local", logPath: "/logs", history },
      (record) =>
        Effect.sync(() => {
          records.push(record);
        }),
      (_info, failed) => failed("unsupported"),
    );
    assert.equal(records[0]?.message, "backend slow crash pattern");
    assert.include(records[0]?.details ?? "", "intervalsMin=[1,1,1]");
    assert.include(records[0]?.details ?? "", "logPath=/logs");
    assert.equal(records[1]?.message, "backend slow crash notice not shown");
    assert.equal(records[1]?.level, "WARN");
    assert.equal(records[1]?.details, "unsupported");
  }),
);
