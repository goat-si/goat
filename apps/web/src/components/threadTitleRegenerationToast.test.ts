import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { titleRegenerationToast } from "./threadTitleRegenerationToast";

const renamed = AsyncResult.success({ status: "renamed" as const });
const kept = AsyncResult.success({ status: "unchanged" as const });
const failed = AsyncResult.success({ status: "failed" as const, message: "model unavailable" });

describe("titleRegenerationToast", () => {
  it("stays quiet for a rename, an unknown outcome and an interrupted request", () => {
    expect(titleRegenerationToast([renamed])).toBeNull();
    expect(titleRegenerationToast([AsyncResult.success(null)])).toBeNull();
    expect(titleRegenerationToast([AsyncResult.failure(Cause.interrupt())])).toBeNull();
  });

  it("reports a failed generation with the server's reason", () => {
    expect(titleRegenerationToast([failed])).toMatchObject({
      type: "error",
      title: "Failed to regenerate thread title",
      description: "model unavailable",
    });
    expect(
      titleRegenerationToast([
        renamed,
        AsyncResult.failure(Cause.fail(new Error("denied"))),
        failed,
      ]),
    ).toMatchObject({
      type: "error",
      title: "Failed to regenerate 2 of 3 thread titles",
      description: "denied",
    });
  });

  it("says when the model kept the current titles", () => {
    expect(titleRegenerationToast([kept])).toMatchObject({ type: "info", title: "Title kept" });
    expect(titleRegenerationToast([kept, kept])).toMatchObject({ title: "Titles kept" });
    expect(titleRegenerationToast([kept, renamed])).toMatchObject({ title: "Kept 1 of 2 titles" });
  });
});
