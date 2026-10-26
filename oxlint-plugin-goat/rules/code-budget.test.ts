import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const linesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`).join("\n") +
  "\n";

const baseline = {
  "apps/demo/src/Big.ts": { lines: 1200 },
  "apps/demo/src/Lookup.ts": { nonNull: 1 },
};

const harness = (filename: string) =>
  createOxlintRuleHarness("goat/code-budget", { filename, ruleOptions: [{ baseline }] });

const twoLookups = `export const sum = (map: Map<string, number>) => map.get("a")! + map.get("b")!;\n`;
const anyCast = ["export const loose = (value: unknown) => (value as", "any).name;\n"].join(" ");
const parenthesizedAnyCast = [
  "export const loose = (value: unknown) => (value as",
  "(any)).name;\n",
].join(" ");

describe("goat/code-budget", () => {
  harness("apps/demo/src/Big.ts").valid(
    "allows a recorded file at its recorded length",
    linesOf(1200),
  );

  harness("apps/demo/src/Big.ts").invalid(
    "reports a recorded file that grows past its recorded length",
    linesOf(1201),
    (output) => assert.match(output, /may not grow past its recorded 1200/),
  );

  harness("apps/demo/src/New.ts").invalid(
    "reports an unrecorded file over 1000 lines",
    linesOf(1001),
    (output) => assert.match(output, /files may not exceed 1000/),
  );

  harness("apps/demo/src/schema.gen.ts").valid("skips generated files", linesOf(1001));

  harness("apps/demo/src/Lookup.ts").invalid(
    "reports non-null assertions beyond the recorded count",
    twoLookups,
    (output) => assert.match(output, /has 2 non-null assertions .*allows 1/),
  );

  harness("apps/demo/src/Lookup.test.ts").valid("allows non-null assertions in tests", twoLookups);

  harness("apps/demo/src/Lookup.test.ts").invalid(
    "reports a new cast to any, in tests too",
    anyCast,
    (output) => assert.match(output, /New casts to `any` are not allowed/),
  );

  harness("apps/demo/src/Loose.ts").invalid(
    "reports a parenthesized cast to any",
    parenthesizedAnyCast,
    (output) => assert.match(output, /New casts to `any` are not allowed/),
  );
});
