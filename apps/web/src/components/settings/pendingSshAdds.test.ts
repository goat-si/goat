import { EnvironmentId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import {
  type PendingSshAddOutcome,
  type PendingSshAddRequest,
  dismissPendingSshAdd,
  pendingSshAddsAtom,
  retryPendingSshAdd,
  startPendingSshAdd,
} from "./pendingSshAdds";

const progress = {
  operationId: "fixture-add",
  phase: "uploading" as const,
  hostAnswered: true,
  remainingMs: 600000,
};

function setup() {
  const registry = AtomRegistry.make();
  const attempts: Array<{
    report: (value: typeof progress) => void;
    settle: (outcome: PendingSshAddOutcome) => void;
    fail: (cause: unknown) => void;
  }> = [];
  const onConnected = vi.fn();
  const request: PendingSshAddRequest = {
    key: "primary:fixture-vps",
    environmentId: EnvironmentId.make("primary"),
    target: { alias: "fixture-vps", hostname: "example.invalid", username: null, port: null },
    label: "fixture-vps",
    routeEnvironmentId: null,
    run: (report) =>
      new Promise((settle, fail) => {
        attempts.push({ report, settle, fail });
      }),
    onConnected,
  };
  const list = () => registry.get(pendingSshAddsAtom);
  return { registry, attempts, onConnected, request, list };
}

it("lists a failed add with its message until Retry connects it, then removes it", async () => {
  const { registry, attempts, onConnected, request, list } = setup();
  const first = startPendingSshAdd(registry, request);
  attempts[0]!.report(progress);
  expect(list()[0]?.progress?.phase).toBe("uploading");
  attempts[0]!.settle({ _tag: "failed", message: "Permission denied" });
  await first;
  expect(list()).toMatchObject([{ error: "Permission denied", progress: null }]);

  const retry = retryPendingSshAdd(registry, request.key);
  expect(attempts).toHaveLength(2);
  expect(list()).toMatchObject([{ error: null }]);
  attempts[1]!.settle({ _tag: "connected" });
  await retry;
  expect(list()).toEqual([]);
  expect(onConnected).toHaveBeenCalledOnce();
});

it("does not start a second add for a host whose add is still running", () => {
  const { registry, attempts, request, list } = setup();
  expect(startPendingSshAdd(registry, request)).not.toBeNull();
  expect(startPendingSshAdd(registry, request)).toBeNull();
  expect(retryPendingSshAdd(registry, request.key)).toBeNull();
  dismissPendingSshAdd(registry, request.key);
  expect(attempts).toHaveLength(1);
  expect(list()).toHaveLength(1);
});

it("ignores progress reports that arrive after an attempt failed or was dismissed", async () => {
  const { registry, attempts, request, list } = setup();
  const settled = startPendingSshAdd(registry, request);
  attempts[0]!.settle({ _tag: "failed", message: "Timed out" });
  await settled;
  attempts[0]!.report(progress);
  expect(list()[0]?.progress).toBeNull();

  dismissPendingSshAdd(registry, request.key);
  attempts[0]!.report(progress);
  expect(list()).toEqual([]);
});

it("drops a superseded add silently and lists a rejected run as a failure", async () => {
  const { registry, attempts, onConnected, request, list } = setup();
  const dropped = startPendingSshAdd(registry, request);
  attempts[0]!.settle({ _tag: "dropped" });
  await dropped;
  expect(list()).toEqual([]);

  const rejected = startPendingSshAdd(registry, request);
  attempts[1]!.fail(new Error("bridge closed"));
  await rejected;
  expect(list()).toMatchObject([{ error: "Failed to connect SSH host." }]);
  expect(onConnected).not.toHaveBeenCalled();
});
