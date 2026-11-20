import * as Effect from "effect/Effect";
import { GitManagerError } from "@goat/contracts";

const MAX_BRANCH_CHANGES_DEMAND_CWDS = 10_000;

export function makeBranchChangesDemand() {
  const branchChangesDemand = new Map<string, number>();
  const wantsBranchChanges = (cwd: string) => branchChangesDemand.has(cwd);
  const acquireBranchChangesDemand = (cwd: string) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (
          !branchChangesDemand.has(cwd) &&
          branchChangesDemand.size >= MAX_BRANCH_CHANGES_DEMAND_CWDS
        ) {
          return Effect.fail(
            new GitManagerError({
              operation: "VcsStatusBroadcaster.branchChangesDemand",
              cwd,
              detail: "Too many active status subscriptions.",
            }),
          );
        }
        return Effect.sync(() => {
          branchChangesDemand.set(cwd, (branchChangesDemand.get(cwd) ?? 0) + 1);
        });
      }),
      () =>
        Effect.sync(() => {
          const count = (branchChangesDemand.get(cwd) ?? 1) - 1;
          if (count > 0) branchChangesDemand.set(cwd, count);
          else branchChangesDemand.delete(cwd);
        }),
    );

  return { wantsBranchChanges, acquireBranchChangesDemand };
}
