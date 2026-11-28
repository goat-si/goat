import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isLocalEnvironmentDisabled } from "./localEnvironment";

describe("isLocalEnvironmentDisabled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("memoizes the sync bridge read for the same desktop bridge function", () => {
    const getLocalEnvironmentEnabled = vi.fn(() => false);
    vi.stubGlobal("window", {
      desktopBridge: { getLocalEnvironmentEnabled },
    });

    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(isLocalEnvironmentDisabled()).toBe(true);
    expect(getLocalEnvironmentEnabled).toHaveBeenCalledTimes(1);
  });

  it("re-reads when a different desktop bridge function is installed", () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => true);

    vi.stubGlobal("window", {
      desktopBridge: { getLocalEnvironmentEnabled: first },
    });
    expect(isLocalEnvironmentDisabled()).toBe(true);

    vi.stubGlobal("window", {
      desktopBridge: { getLocalEnvironmentEnabled: second },
    });
    expect(isLocalEnvironmentDisabled()).toBe(false);
    expect(isLocalEnvironmentDisabled()).toBe(false);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("returns false when desktopBridge is absent", () => {
    vi.stubGlobal("window", {});
    expect(isLocalEnvironmentDisabled()).toBe(false);
  });
});
