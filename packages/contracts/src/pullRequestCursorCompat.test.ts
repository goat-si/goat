import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { PullRequestListInput, PullRequestListState } from "./pullRequest.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Cursor fields from git show 7898e25ad0a:packages/contracts/src/pullRequest.ts.
const previous = Schema.Struct({
  state: PullRequestListState,
  cursors: Schema.optional(
    Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
  ),
});
it("accepts old and current encoded cursors on both client generations", () => {
  const old = Schema.decodeUnknownSync(previous);
  const current = Schema.decodeUnknownSync(PullRequestListInput);
  for (const cursor of ["2026-07-02T00:00:00Z|1|", "2026-07-02T00:00:00Z|1|3,4"]) {
    const wire = { state: "open", cursors: { "github.com acme/web": cursor } };
    expect(old(wire).cursors?.["github.com acme/web"]).toBe(cursor);
    expect(current(wire).cursors?.["github.com acme/web"]).toBe(cursor);
  }
});
