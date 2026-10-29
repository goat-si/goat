import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { EnvironmentId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { finishHubPairing, resolveConnectHubIntent } from "../features/connection/connectHubIntent";

import {
  findLinkedRoute,
  restoreDraftLinkState,
  shouldHandleAppLink,
  withoutPairingTarget,
} from "./appLinking";

describe("pairing links", () => {
  it.each([
    ["pair", "Pair", ""],
    ["connections/new", "ConnectionsNew", "?pairingUrl=example&autoConnect=1"],
    [
      "settings/environment-new",
      "SettingsEnvironmentNew",
      "?routeFor=old&intent=change-hub&replaceEnvironmentId=old&pairingUrl=example&autoConnect=1",
    ],
  ])("does not remove the existing hub after %s%s completes", async (path, name, query) => {
    const require = NodeModule.createRequire(import.meta.url);
    const nativeRequire = NodeModule.createRequire(require.resolve("@react-navigation/native"));
    const { getStateFromPath } = await import(
      NodeURL.pathToFileURL(nativeRequire.resolve("@react-navigation/core")).href
    );
    const state = getStateFromPath(`${path}${query}`, {
      screens: {
        Pair: "pair",
        ConnectionsNew: "connections/new",
        SettingsEnvironmentNew: "settings/environment-new",
      },
    });
    const params = findLinkedRoute(withoutPairingTarget(state), [name])?.params as
      | { intent?: string; routeFor?: string; replaceEnvironmentId?: string }
      | undefined;
    const intent = resolveConnectHubIntent({
      intent: params?.intent,
      routeFor: params?.routeFor,
      savedEnvironmentCount: 1,
    });
    const removeEnvironment = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      finishHubPairing({
        pairedEnvironmentId: EnvironmentId.make("new"),
        intent,
        replaceEnvironmentId: EnvironmentId.make(params?.replaceEnvironmentId ?? "old"),
        removeEnvironment,
      }),
    ).resolves.toEqual({ removed: false, removalFailed: false });
    expect(removeEnvironment).not.toHaveBeenCalled();
  });
  it.each([
    ["pair", "Pair"],
    ["connections/new", "ConnectionsNew"],
    ["settings/environment-new", "SettingsEnvironmentNew"],
  ])("does not let %s target or replace a saved environment", async (path, name) => {
    const require = NodeModule.createRequire(import.meta.url);
    const nativeRequire = NodeModule.createRequire(require.resolve("@react-navigation/native"));
    const { getStateFromPath } = await import(
      NodeURL.pathToFileURL(nativeRequire.resolve("@react-navigation/core")).href
    );
    const state = getStateFromPath(
      `${path}?routeFor=saved&intent=change-hub&replaceEnvironmentId=saved&pairingUrl=example`,
      {
        screens: {
          Pair: "pair",
          ConnectionsNew: "connections/new",
          SettingsEnvironmentNew: "settings/environment-new",
        },
      },
    );
    expect(findLinkedRoute(withoutPairingTarget(state), [name])?.params).toEqual({
      pairingUrl: "example",
      intent: "add-server",
    });
  });

  it("preserves ordinary pairing parameters and sanitizes nested pairing routes", () => {
    const state = {
      routes: [
        { name: "Pair", params: { pairingUrl: "example" } },
        {
          name: "Nested",
          state: { routes: [{ name: "ConnectionsNew", params: { routeFor: "saved" } }] },
        },
      ],
    };
    const result = withoutPairingTarget(state);
    expect(result?.routes[0]?.params).toEqual({ pairingUrl: "example", intent: "add-server" });
    expect(findLinkedRoute(result, ["ConnectionsNew"])?.params).toEqual({ intent: "add-server" });
  });
});

describe("shouldHandleAppLink", () => {
  it.each(["goat://", "goat:///", "goat-dev://", "goat-preview://"])(
    "ignores scheme-only URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );

  it.each([
    "goat://threads/env-1/thread-1",
    "goat://pair?pairingUrl=x",
    "goat-dev://settings/usage?tab=limits",
    // Another app's bare scheme is not ours to swallow.
    "t3code://",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each(["goat://expo-development-client/?url=x", "goat://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url, true)).toBe(false);
    },
  );
});

describe("cloud-only deep links", () => {
  it.each([
    "t3code://connect-onboarding",
    "t3code-dev://connect-onboarding/?source=x",
    "t3code://settings/waitlist",
    "t3code://settings/auth",
    "exp://192.168.1.2:8081/--/settings/auth",
  ])("ignores %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(false);
    expect(shouldHandleAppLink(url, true)).toBe(true);
  });

  it.each([
    "t3code://settings",
    "t3code://settings/authors",
    "t3code://pair?next=settings/auth",
    "t3code://threads/env/thread/files/scripts/connect-onboarding",
    "t3code://new/draft/files/settings/auth",
    "exp://192.168.1.2:8081/--/threads/env/thread/files/settings/waitlist",
  ])("still handles %s without cloud config", (url) => {
    expect(shouldHandleAppLink(url, false)).toBe(true);
  });
});

describe("draft deep links", () => {
  it("opens the old draft URL on the thread screen with its draft identity", () => {
    const draft = { projectId: "project-1", environmentId: "env-1", draftId: "draft-1" };
    expect(
      restoreDraftLinkState(
        { routes: [{ name: "Home" }, { name: "Thread", params: draft }] },
        "/new/draft?draftId=draft-1",
      ),
    ).toEqual({
      index: 1,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft } }],
    });
  });

  it.each([
    ["environment", "NewTaskEnvironment"],
    ["branch", "NewTaskBranch"],
    ["files", "NewTaskFiles"],
    ["files/src/index.ts", "NewTaskFile"],
    ["attachments/attachment-1", "NewTaskAttachment"],
    ["settings", "NewTaskThreadSettings"],
  ])("restores a draft beneath its %s screen", (path, name) => {
    const params = { environmentId: "env-1", projectId: "project-1" };
    const target = { name, params };
    expect(
      restoreDraftLinkState({ routes: [{ name: "Home" }, target] }, `/new/draft/${path}`),
    ).toEqual({
      index: 2,
      routes: [{ name: "Home" }, { name: "Thread", params: { draft: params } }, target],
    });
  });

  it("leaves live-thread and project-selection links unchanged", () => {
    const state = { routes: [{ name: "Thread", params: { threadId: "thread-1" } }] };
    expect(restoreDraftLinkState(state, "/threads/env-1/thread-1")).toBe(state);
    expect(restoreDraftLinkState(state, "/new")).toBe(state);
    expect(restoreDraftLinkState(undefined, "/new/draft")).toBeUndefined();
  });
});

describe("settings link routes", () => {
  const settingsLink = {
    routes: [
      { name: "Home" },
      { name: "Settings" },
      { name: "SettingsEnvironmentNew", params: { pairingUrl: "x", autoConnect: "1" } },
    ],
  };

  it("finds a root settings route", () => {
    expect(findLinkedRoute(settingsLink, ["SettingsEnvironmentNew"])?.params).toEqual({
      pairingUrl: "x",
      autoConnect: "1",
    });
    expect(findLinkedRoute(settingsLink, ["ConnectionsNew"])).toBeUndefined();
  });
});
