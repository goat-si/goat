import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import {
  branchCheckoutRequestKey,
  makeNewTaskBranchCheckouts,
  type BranchCheckoutRequest,
  type BranchCheckoutResult,
} from "./new-task-branch-checkout";

const request = (flowKey: string, branch: string): BranchCheckoutRequest => ({
  flowKey,
  routeKey: flowKey,
  environmentId: null,
  workspaceRoot: "/repo",
  branch,
  worktreePath: null,
});
const success = (name: string): BranchCheckoutResult =>
  AsyncResult.success({ name, current: true, isDefault: false, worktreePath: null });
const failure: BranchCheckoutResult = AsyncResult.failure(Cause.fail(new Error("dirty tree")));

it("runs a request once across reader remounts and catalog gaps", async () => {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<BranchCheckoutResult>();
  const run = vi.fn(() => {
    started.resolve();
    return result.promise;
  });
  const checkouts = makeNewTaskBranchCheckouts({
    run,
    holdNavigation: () => {},
    onFailure: () => {},
  });
  const input = request("draft-a", "feature");
  const key = branchCheckoutRequestKey(input);
  const firstReader = checkouts.start(key);
  await started.promise;
  expect(checkouts.requestForFlow("draft-a")).toEqual(input);
  expect(checkouts.start(branchCheckoutRequestKey({ ...input }))).toBe(firstReader);
  result.resolve(success("feature"));
  await firstReader;
  expect(checkouts.start(key)).toBe(firstReader);
  expect(run).toHaveBeenCalledTimes(1);
  checkouts.release(key);
});

it("serializes different routes and ignores an abandoned route's failure", async () => {
  const startedA = Promise.withResolvers<void>();
  const startedB = Promise.withResolvers<void>();
  const settledA = Promise.withResolvers<BranchCheckoutResult>();
  const settledB = Promise.withResolvers<BranchCheckoutResult>();
  const holds: Promise<unknown>[] = [];
  const onFailure = vi.fn();
  const checkouts = makeNewTaskBranchCheckouts({
    run: (input) => {
      if (input.flowKey === "a") {
        startedA.resolve();
        return settledA.promise;
      }
      startedB.resolve();
      return settledB.promise;
    },
    holdNavigation: (operation) => {
      holds.push(operation);
    },
    onFailure,
  });
  const keyA = branchCheckoutRequestKey(request("a", "first"));
  const keyB = branchCheckoutRequestKey(request("b", "second"));
  const a = checkouts.start(keyA);
  const b = checkouts.start(keyB);
  await startedA.promise;
  checkouts.prune(new Set(["b"]));
  settledA.resolve(failure);
  await startedB.promise;
  expect(onFailure).not.toHaveBeenCalled();
  settledB.resolve(failure);
  await Promise.all([a, b]);
  expect(onFailure).not.toHaveBeenCalled();
  checkouts.release(keyB);
  await Promise.all(holds);
  expect(onFailure).toHaveBeenCalledTimes(1);
  expect(onFailure.mock.calls[0]?.[0]).toMatchObject({ flowKey: "b" });
});
