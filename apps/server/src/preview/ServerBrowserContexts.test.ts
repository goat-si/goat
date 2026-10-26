import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@goat/contracts";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type CDPSession,
} from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    contexts,
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.contexts) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium" }),
    );
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { GOAT_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.contexts[0]?.close).toHaveBeenCalled();
  });

  it.each([
    {
      name: "enables hardware GPU and ignores SwiftShader on darwin by default",
      platform: "darwin" as const,
      env: {},
      expectDisableGpu: false,
      expectIgnoreSwiftShader: true,
    },
    {
      name: "enables hardware GPU and ignores SwiftShader on win32 by default",
      platform: "win32" as const,
      env: {},
      expectDisableGpu: false,
      expectIgnoreSwiftShader: true,
    },
    {
      name: "disables GPU on linux by default",
      platform: "linux" as const,
      env: {},
      expectDisableGpu: true,
      expectIgnoreSwiftShader: false,
    },
    {
      name: "honors GOAT_SERVER_BROWSER_GPU=0 on darwin",
      platform: "darwin" as const,
      env: { GOAT_SERVER_BROWSER_GPU: "0" },
      expectDisableGpu: true,
      expectIgnoreSwiftShader: false,
    },
    {
      name: "honors GOAT_SERVER_BROWSER_GPU=1 on linux",
      platform: "linux" as const,
      env: { GOAT_SERVER_BROWSER_GPU: "1" },
      expectDisableGpu: false,
      expectIgnoreSwiftShader: true,
    },
  ])("$name", async ({ platform, env, expectDisableGpu, expectIgnoreSwiftShader }) => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({ ...options(), platform, env });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    const call = launches.launch.mock.calls[0]?.[0];
    const ignoreDefaultArgs = Array.isArray(call?.ignoreDefaultArgs) ? call.ignoreDefaultArgs : [];
    expect(call?.args).toContain("--headless=new");
    expect(call?.args?.includes("--disable-gpu")).toBe(expectDisableGpu);
    expect(ignoreDefaultArgs).toContain("--enable-automation");
    expect(ignoreDefaultArgs).toContain("--headless");
    expect(ignoreDefaultArgs.includes("--enable-unsafe-swiftshader")).toBe(expectIgnoreSwiftShader);
    await pool.close();
  });
});

describe("presentAsChrome", () => {
  it.each([
    {
      name: "maps Darwin 24/25/27 and HeadlessChrome to reduced Chrome UA and full Sec-CH-UA metadata",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.8037.92 Safari/537.36",
      product: "HeadlessChrome/154.0.8037.92",
      host: { platform: "darwin" as const, arch: "arm64", release: "24.4.0" },
      expectedUa:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      expectedPlatform: "macOS",
      expectedPlatformVersion: "15.0.0",
      expectedFullVersion: "154.0.8037.92",
    },
    {
      name: "maps Darwin 25 to macOS 26.0.0 and preserves 4-part version from product when UA is already reduced",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      product: "Chrome/154.0.8037.92",
      host: { platform: "darwin" as const, arch: "arm64", release: "25.1.0" },
      expectedUa:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      expectedPlatform: "macOS",
      expectedPlatformVersion: "26.0.0",
      expectedFullVersion: "154.0.8037.92",
    },
    {
      name: "maps Darwin 27 to macOS 27.0.0",
      userAgent: "Mozilla/5.0 HeadlessChrome/154.0.8037.92",
      product: "HeadlessChrome/154.0.8037.92",
      host: { platform: "darwin" as const, arch: "arm64", release: "27.2.0" },
      expectedUa: "Mozilla/5.0 Chrome/154.0.0.0",
      expectedPlatform: "macOS",
      expectedPlatformVersion: "27.0.0",
      expectedFullVersion: "154.0.8037.92",
    },
    {
      name: "maps Windows 11 build >= 22000 to platformVersion 15.0.0",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) HeadlessChrome/154.0.8037.92",
      product: "HeadlessChrome/154.0.8037.92",
      host: { platform: "win32" as const, arch: "x64", release: "10.0.22631" },
      expectedUa: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0",
      expectedPlatform: "Windows",
      expectedPlatformVersion: "15.0.0",
      expectedFullVersion: "154.0.8037.92",
    },
    {
      name: "normalizes Linux kernel release to x.y.z",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/154.0.8037.92",
      product: "HeadlessChrome/154.0.8037.92",
      host: { platform: "linux" as const, arch: "x64", release: "6.8.0-45-generic" },
      expectedUa: "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0",
      expectedPlatform: "Linux",
      expectedPlatformVersion: "6.8.0",
      expectedFullVersion: "154.0.8037.92",
    },
  ])(
    "$name",
    async ({
      userAgent,
      product,
      host,
      expectedUa,
      expectedPlatform,
      expectedPlatformVersion,
      expectedFullVersion,
    }) => {
      const send = vi.fn(async (method: string) => {
        if (method === "Browser.getVersion") return { userAgent, product };
        return {};
      });
      await presentAsChrome({ send } as unknown as CDPSession, host);
      expect(send).toHaveBeenCalledWith("Emulation.setUserAgentOverride", {
        userAgent: expectedUa,
        userAgentMetadata: expect.objectContaining({
          platform: expectedPlatform,
          platformVersion: expectedPlatformVersion,
          fullVersionList: [
            { brand: "Chromium", version: expectedFullVersion },
            { brand: "Google Chrome", version: expectedFullVersion },
            { brand: "Not A(Brand", version: "99.0.0.0" },
          ],
        }),
      });
    },
  );
});
