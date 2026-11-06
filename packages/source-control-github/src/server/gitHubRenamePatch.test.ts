import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { decodePullRequestFilesJson } from "./gitHubPullRequestJson.ts";

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("GitHub rename patches", () => {
  it("preserves spaces and literal backslashes in both rename paths", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            previous_filename: String.raw` old\name.ts `,
            filename: String.raw` new\name.ts `,
            status: "renamed",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        String.raw`diff --git "a/ old\\name.ts " "b/ new\\name.ts "`,
        "similarity index 100%",
        String.raw`rename from " old\\name.ts "`,
        String.raw`rename to " new\\name.ts "`,
        String.raw`--- "a/ old\\name.ts "`,
        String.raw`+++ "b/ new\\name.ts "`,
        "",
      ].join("\n"),
    );
  });

  it("names both paths of a rename, counting its hunks against the old one", () => {
    const result = expectSuccess(
      decodePullRequestFilesJson(
        JSON.stringify([
          {
            filename: "src/new.ts",
            status: "renamed",
            previous_filename: "src/old.ts",
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      ),
    );

    expect(result.patch).toBe(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 0%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "--- a/src/old.ts",
        "+++ b/src/new.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    );
  });
});
