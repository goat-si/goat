import { EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  CONNECT_HUB_COPY,
  finishHubPairing,
  resolveConnectHubIntent,
  selectHubEnvironmentId,
} from "./connectHubIntent";

const oldHub = EnvironmentId.make("hub-a");
const newHub = EnvironmentId.make("hub-c");

describe("resolveConnectHubIntent", () => {
  it("connects the first hub on a phone without saved local environments", () => {
    expect(resolveConnectHubIntent({ savedEnvironmentCount: 0 })).toBe("hub");
  });

  it("changes the hub by default even when Advanced servers are saved", () => {
    expect(resolveConnectHubIntent({ savedEnvironmentCount: 2 })).toBe("change-hub");
  });

  it.each(["hub", "change-hub", "add-server"])("keeps explicit %s intent", (intent) => {
    expect(resolveConnectHubIntent({ intent, savedEnvironmentCount: 2 })).toBe(intent);
  });

  it("lets add-route win over an explicit change-hub intent", () => {
    expect(
      resolveConnectHubIntent({ routeFor: oldHub, intent: "change-hub", savedEnvironmentCount: 2 }),
    ).toBe("add-route");
    expect(CONNECT_HUB_COPY["add-route"].title).toBe("Add route");
  });

  it.each([0, 2])("ignores unknown intents with %s saved environments", (savedEnvironmentCount) => {
    expect(resolveConnectHubIntent({ intent: "unknown", savedEnvironmentCount })).toBe(
      savedEnvironmentCount === 0 ? "hub" : "change-hub",
    );
  });

  it("selects the first local environment when migrating without a stored hub", () => {
    expect(selectHubEnvironmentId([{ environmentId: oldHub }, { environmentId: newHub }])).toBe(
      oldHub,
    );
    expect(selectHubEnvironmentId([])).toBeNull();
  });
});

describe("finishHubPairing", () => {
  it("preserves a re-paired hub with the same id", async () => {
    const removeEnvironment = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      finishHubPairing({
        pairedEnvironmentId: oldHub,
        intent: "change-hub",
        replaceEnvironmentId: oldHub,
        removeEnvironment,
      }),
    ).resolves.toEqual({ removed: false, removalFailed: false });
    expect(removeEnvironment).not.toHaveBeenCalled();
  });

  it("removes only the old hub after pairing a different id", async () => {
    const removeEnvironment = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      finishHubPairing({
        pairedEnvironmentId: newHub,
        intent: "change-hub",
        replaceEnvironmentId: oldHub,
        removeEnvironment,
      }),
    ).resolves.toEqual({ removed: true, removalFailed: false });
    expect(removeEnvironment.mock.calls).toEqual([[oldHub]]);
  });

  it("waits for removal to finish", async () => {
    let finishRemoval = (_result: AsyncResult.AsyncResult<unknown, unknown>) => {};
    const pending = new Promise<AsyncResult.AsyncResult<unknown, unknown>>((resolve) => {
      finishRemoval = resolve;
    });
    let finished = false;
    const completion = finishHubPairing({
      pairedEnvironmentId: newHub,
      intent: "change-hub",
      replaceEnvironmentId: oldHub,
      removeEnvironment: () => pending,
    }).then((result) => {
      finished = true;
      return result;
    });
    expect(finished).toBe(false);
    finishRemoval(AsyncResult.success(undefined));
    await expect(completion).resolves.toEqual({ removed: true, removalFailed: false });
  });

  it("reports failed removal so the caller keeps the screen open", async () => {
    const removeEnvironment = vi.fn(async () =>
      AsyncResult.failure(Cause.fail(new Error("Offline"))),
    );
    await expect(
      finishHubPairing({
        pairedEnvironmentId: newHub,
        intent: "change-hub",
        replaceEnvironmentId: oldHub,
        removeEnvironment,
      }),
    ).resolves.toEqual({ removed: false, removalFailed: true });
  });

  it("reports a rejected removal", async () => {
    await expect(
      finishHubPairing({
        pairedEnvironmentId: newHub,
        intent: "change-hub",
        replaceEnvironmentId: oldHub,
        removeEnvironment: () => Promise.reject(new Error("Offline")),
      }),
    ).resolves.toEqual({ removed: false, removalFailed: true });
  });

  it.each(["hub", "add-server", "add-route"] as const)("never removes for %s", async (intent) => {
    const removeEnvironment = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      finishHubPairing({
        pairedEnvironmentId: newHub,
        intent,
        replaceEnvironmentId: oldHub,
        removeEnvironment,
      }),
    ).resolves.toEqual({ removed: false, removalFailed: false });
    expect(removeEnvironment).not.toHaveBeenCalled();
  });

  it("does not remove when there is no previous hub", async () => {
    const removeEnvironment = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      finishHubPairing({
        pairedEnvironmentId: newHub,
        intent: "change-hub",
        replaceEnvironmentId: null,
        removeEnvironment,
      }),
    ).resolves.toEqual({ removed: false, removalFailed: false });
    expect(removeEnvironment).not.toHaveBeenCalled();
  });
});
