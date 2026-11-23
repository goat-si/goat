// @effect-diagnostics nodeBuiltinImport:off - Hands a real file on disk to a real desktop browser.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import { guardErrors } from "@goat/shared/errorGuards";
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
const launchChromium = chromium.launch.bind(chromium);
const launchPersistentChromium = chromium.launchPersistentContext.bind(chromium);
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    newPage: vi.fn(async () => ({ once: vi.fn() })),
    isClosed: () => closed,
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
    created: contexts,
    contexts: () => contexts.filter((context) => !context.isClosed()),
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
  it("closes the shared browser only after it holds no context for the idle period", async () => {
    vi.useFakeTimers();
    try {
      const first = makeBrowser();
      const second = makeBrowser();
      launches.launch
        .mockResolvedValueOnce(first as unknown as Browser)
        .mockResolvedValueOnce(second as unknown as Browser);
      const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
      const agent = await pool.contextFor("default", "agent");
      await pool.scratchPage();
      await agent.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await first.created[1]!.close();
      await vi.advanceTimersByTimeAsync(9);
      const next = await pool.contextFor("default", "next");
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await next.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).toHaveBeenCalledOnce();
      await pool.contextFor("default", "later");
      expect(launches.launch).toHaveBeenCalledTimes(2);
      expect(second.newContext).toHaveBeenCalledOnce();
      await pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a scratch context when creating its page fails", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const peer = await pool.contextFor("default", "peer");
    const context = await browser.newContext();
    const failure = new Error("newPage failed");
    browser.created[1]!.newPage.mockRejectedValueOnce(failure);
    browser.newContext.mockResolvedValueOnce(context);
    try {
      await expect(pool.scratchPage()).rejects.toBe(failure);
      expect(context.close).toHaveBeenCalledOnce();
      expect(browser.contexts()).toEqual([peer]);
      expect(peer.close).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    } finally {
      await pool.close();
    }
  });

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
    for (const context of browser.created) expect(context.close).toHaveBeenCalled();
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
    expect(browser.created[0]?.close).not.toHaveBeenCalled();
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
    const original = await pool.contextFor("work/team");
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
    const [, reopened] = await Promise.all([clearing, reopening]);
    expect(reopened).not.toBe(original);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it("finishes an already running profile open before clearing and reopening its storage", async () => {
    const order: string[] = [];
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    launches.rm.mockImplementationOnce(async () => {
      order.push("deleted");
    });
    const pool = new ServerBrowserContexts(options());
    const started = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const opening = pool.withProfile("work", async () => {
      started.resolve();
      await proceed.promise;
      const context = await pool.contextFor("work");
      context.on("close", () => {
        order.push("closed");
      });
      order.push("opened");
      return context;
    });
    await started.promise;
    const clearing = pool.clearProfile("work");
    proceed.resolve();
    const original = await opening;
    await clearing;
    const reopened = await pool.contextFor("work");
    expect(reopened).not.toBe(original);
    expect(order).toEqual(["opened", "closed", "deleted"]);
    await pool.close();
  });

  it("keeps an outside open behind the last clear when a profile open runs between clears", async () => {
    const order: string[] = [];
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    launches.rm
      .mockImplementationOnce(async () => {
        order.push("first delete");
      })
      .mockImplementationOnce(async () => {
        order.push("second delete");
      });
    const pool = new ServerBrowserContexts(options());
    const opened = Promise.withResolvers<BrowserContext>();
    const releaseOpen = Promise.withResolvers<void>();
    const firstClear = pool.clearProfile("work");
    const opening = pool.withProfile("work", async () => {
      const context = await pool.contextFor("work");
      context.on("close", () => {
        order.push("closed");
      });
      opened.resolve(context);
      await releaseOpen.promise;
    });
    const lastClear = pool.clearProfile("work");
    await firstClear;
    const middleContext = await opened.promise;
    const outside = pool.contextFor("work").then((context) => {
      order.push("outside opened");
      return context;
    });
    releaseOpen.resolve();
    await Promise.all([opening, lastClear]);
    const fresh = await outside;
    expect(fresh).not.toBe(middleContext);
    expect(order).toEqual(["first delete", "closed", "second delete", "outside opened"]);
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
    expect(browser.created[0]?.close).toHaveBeenCalled();
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
      name: "drops the desktop app's own and Electron's tokens, which sites read as a bot",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) GOATNightly/0.1.2-nightly.20261027.285 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36",
      product: "Chrome/152.0.7977.167",
      host: { platform: "darwin" as const, arch: "arm64", release: "27.2.0" },
      expectedUa:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      expectedPlatform: "macOS",
      expectedPlatformVersion: "27.0.0",
      expectedFullVersion: "152.0.7977.167",
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

  it("uploads a file over 50 MB to a desktop tab, which shares the server's filesystem", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-desktop-upload-"));
    const userDataDir = NodePath.join(directory, "profile");
    const pool = new ServerBrowserContexts(options());
    try {
      // Chromium can write DevToolsActivePort after Playwright's launch resolves, so the port is chosen here.
      const reserved = NodeHttp.createServer();
      await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
      const { port } = reserved.address() as NodeNet.AddressInfo;
      await new Promise((resolve) => reserved.close(resolve));
      const desktop = await launchPersistentChromium(userDataDir, {
        headless: true,
        args: [`--remote-debugging-port=${port}`],
      });
      try {
        const { browser, page } = await pool.connectDesktopPage(`http://127.0.0.1:${port}`);
        try {
          const file = NodePath.join(directory, "large.bin");
          NodeFS.writeFileSync(file, "");
          NodeFS.truncateSync(file, 51 * 1024 * 1024);
          await page.setContent(`<input type="file">`);
          await page.locator("input").setInputFiles(file);
          expect(
            await page.$eval("input", (input) =>
              Array.from(
                (input as unknown as { files: ArrayLike<{ name: string; size: number }> }).files,
                ({ name, size }) => ({ name, size }),
              ),
            ),
          ).toEqual([{ name: "large.bin", size: 51 * 1024 * 1024 }]);
        } finally {
          await browser.close();
        }
      } finally {
        await pool.close();
        await desktop.close();
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

it("sends one Chrome user agent from the page and from a service worker request", async () => {
  const listen = Promise.withResolvers<void>();
  const server = guardErrors(
    NodeHttp.createServer((request, response) => {
      if (request.url === "/worker.js") {
        response.writeHead(200, { "content-type": "text/javascript" }).end(`
          addEventListener("message", event => {
            event.waitUntil(fetch("/identity").then(response => response.text()).then(ua => event.ports[0].postMessage(ua)));
          });
        `);
      } else if (request.url === "/identity") {
        response.end(request.headers["user-agent"]);
      } else {
        response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html>");
      }
    }),
    listen.reject,
  );
  server.listen(0, "127.0.0.1", listen.resolve);
  await listen.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
  const probe = await launchChromium();
  const version = probe.version();
  await probe.close();
  launches.launch.mockImplementation((options: Parameters<BrowserType["launch"]>[0] = {}) => {
    const { executablePath: _path, ...bundled } = options;
    return launchChromium(bundled);
  });
  const pool = new ServerBrowserContexts({
    ...options(),
    env: { GOAT_SERVER_BROWSER_SANDBOX: "0", GOAT_SERVER_BROWSER_GPU: "0" },
    chromeVersion: version,
  });
  try {
    const context = await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    const page = await context.newPage();
    const platform = HostProcess.Platform.defaultValue();
    await presentAsChrome(await context.newCDPSession(page), {
      platform,
      arch: HostProcess.Architecture.defaultValue(),
    });
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const [pageAgent, workerAgent] = (await page.evaluate(`(async () => {
      await navigator.serviceWorker.register("/worker.js");
      const active = (await navigator.serviceWorker.ready).active;
      const channel = new MessageChannel();
      const fromWorker = new Promise((resolve) => { channel.port1.onmessage = event => resolve(event.data); });
      active.postMessage("identity", [channel.port2]);
      return [await fetch("/identity").then(response => response.text()), await fromWorker];
    })()`)) as [string, string];
    expect(pageAgent).toContain(`Chrome/${version.split(".")[0]}.0.0.0`);
    expect(workerAgent).toBe(pageAgent);
  } finally {
    await pool.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
