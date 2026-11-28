import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { delegatedWorktreeBase } from "./DelegatedWorktreeBase.ts";

it.effect("uses the parent branch only when it still points to the parent commit", () =>
  Effect.gen(function* () {
    const git = {
      resolveCommit: ({ revision }: { revision: string }) =>
        Effect.succeed({ commitSha: revision === "refs/heads/current" ? "abc" : "other" }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    expect((yield* delegatedWorktreeBase(git, "/repo", "current", "abc")).baseRef).toBe("current");
    expect((yield* delegatedWorktreeBase(git, "/repo", "moved", "abc")).baseRef).toBe("abc");
    expect((yield* delegatedWorktreeBase(git, "/repo", null, "abc")).baseRef).toBe("abc");
  }),
);
