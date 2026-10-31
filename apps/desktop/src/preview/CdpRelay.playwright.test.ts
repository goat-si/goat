// @effect-diagnostics nodeBuiltinImport:off - a loopback CDP socket and Playwright's browser path are Node APIs.
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";

interface Socket {
  readonly send: (data: string) => void;
  readonly on: (event: "message", listener: (data: unknown) => void) => void;
  readonly once: (event: "open", listener: () => void) => void;
  readonly close: () => void;
}
interface SocketServer {
  readonly address: () => { readonly port: number };
  readonly on: (event: "connection", listener: (socket: Socket) => void) => void;
  readonly once: (event: "listening", listener: () => void) => void;
  readonly close: () => void;
}

const require = NodeModule.createRequire(import.meta.url);
// Playwright ships ws without types; the relay needs a real CDP WebSocket on both sides.
const { ws: WebSocket, wsServer: WebSocketServer } = require("playwright-core/lib/utilsBundle") as {
  readonly ws: new (url: string) => Socket;
  readonly wsServer: new (options: { port: number; host: string }) => SocketServer;
};

/** Whether chromium-headless-shell is installed; Linux CI installs it, a Mac checkout often has not. */
const headlessShellInstalled = (() => {
  const packageRoot = NodePath.dirname(require.resolve("playwright-core/package.json"));
  const { browsers } = require(NodePath.join(packageRoot, "browsers.json")) as {
    readonly browsers: ReadonlyArray<{ readonly name: string; readonly revision: string }>;
  };
  const revision = browsers.find((browser) => browser.name === "chromium-headless-shell")?.revision;
  const platform = HostProcess.Platform.defaultValue();
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (platform === "darwin"
      ? NodePath.join(NodeOS.homedir(), "Library", "Caches", "ms-playwright")
      : platform === "win32"
        ? NodePath.join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
        : NodePath.join(
            process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache"),
            "ms-playwright",
          ));
  return (
    revision !== undefined &&
    NodeFS.existsSync(NodePath.join(cache, `chromium_headless_shell-${revision}`))
  );
})();

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as NodeNet.AddressInfo;
      server.close(() => resolve(port));
    });
  });

describe.skipIf(!headlessShellInstalled)("CDP relay under Playwright", () => {
  // Snapshot, evaluate and fetch mask cookie values read through context.cookies().
  it("lets Playwright read the tab's cookies, HttpOnly ones included, and evaluate in it", async () => {
    const port = await freePort();
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`],
    });
    const sockets: Array<{ close: () => void }> = [];
    try {
      const context = await browser.newContext();
      const value = `sid_${NodeCrypto.randomUUID()}`;
      await context.addCookies([
        { name: "sid", value, url: "http://cookies.test", httpOnly: true },
        { name: "other", value: "elsewhere", url: "http://other.test" },
      ]);
      await context.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: "<title>Relay</title>" }),
      );
      const page = await context.newPage();
      await page.goto("http://cookies.test/");
      const { targetInfo } = await (await context.newCDPSession(page)).send("Target.getTargetInfo");
      const tab = {
        id: targetInfo.targetId,
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetInfo.targetId}`,
      };

      // The tab's own debugger, as Electron's webContents.debugger is.
      const debuggee = new WebSocket(tab.webSocketDebuggerUrl);
      sockets.push(debuggee);
      await new Promise<void>((resolve) => debuggee.once("open", resolve));
      const pending = new Map<
        number,
        { resolve: (value: unknown) => void; reject: (cause: Error) => void }
      >();
      let sequence = 0;
      let relay: CdpRelayConnection | undefined;
      debuggee.on("message", (data) => {
        const message = JSON.parse(String(data)) as {
          id?: number;
          method?: string;
          params?: unknown;
          sessionId?: string;
          result?: unknown;
          error?: { message: string };
        };
        if (message.id === undefined) {
          relay?.event(message.method ?? "", message.params, message.sessionId ?? "");
          return;
        }
        const reply = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reply?.reject(new Error(message.error.message));
        else reply?.resolve(message.result);
      });
      const send = (
        method: string,
        params: Record<string, unknown>,
        sessionId: string | undefined,
      ) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++sequence;
          pending.set(id, { resolve, reject });
          debuggee.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
          );
        });

      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      sockets.push(server);
      await new Promise<void>((resolve) => server.once("listening", resolve));
      server.on("connection", (socket) => {
        relay = createCdpRelayConnection(
          {
            send,
            targetId: async () => tab.id,
            url: () => page.url(),
            title: () => "Relay",
            userAgent: () => "Electron",
            setDownloadDirectory: () => {},
          },
          (message) => socket.send(message),
          () => socket.close(),
        );
        socket.on("message", (data) => relay?.receive(String(data)));
      });

      const remote = await chromium.connectOverCDP(`ws://127.0.0.1:${server.address().port}/`);
      const relayed = remote.contexts().flatMap((each) => each.pages())[0];
      if (relayed === undefined) throw new Error("The relayed page is missing.");
      expect(await relayed.evaluate(() => document.title)).toBe("Relay");
      const cookies = await relayed.context().cookies(["http://cookies.test/"]);
      expect(
        cookies.map(({ name, value: read, httpOnly }) => ({
          name,
          matches: read === value,
          httpOnly,
        })),
      ).toEqual([{ name: "sid", matches: true, httpOnly: true }]);
    } finally {
      for (const socket of sockets) socket.close();
      await browser.close();
    }
  });
});
