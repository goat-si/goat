// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- Desktop owns the listener and session expiry clock.
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@goat/shared/HostProcess";
import { guardErrors } from "@goat/shared/errorGuards";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopPenPin, DesktopPenRouteResult } from "@goat/contracts";
import * as DesktopPenMembers from "./DesktopPenMembers.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { getDesktopOrigin } from "../electron/ElectronProtocol.ts";
import { penStateDir } from "@goat/pen-protocol/snapshot";
import { PEN_VIEWER_ENABLED, type PenViewerPolicy } from "@goat/shared/penViewerGate";
import {
  decidePenGatewayRequest,
  filterPenResponseHeaders,
  isPublicPenDescriptor,
} from "./penGatewayPolicy.ts";
import { openPenPipe, resolvePenBinary, type PenPipeDeps } from "./penPipe.ts";
import { exchangePenResponse, mintPenSession } from "./penUpstream.ts";

const MINT_DEADLINE_MS = 30_000;
const UPGRADE_REFUSAL_BODY_CAP = 64 * 1024;
const EARLY_UPGRADE_BYTES = 64 * 1024;

interface Route {
  readonly pin: DesktopPenPin;
  readonly capability: string;
  readonly children: Set<Awaited<ReturnType<typeof openPenPipe>>>;
  readonly releasing: Map<Awaited<ReturnType<typeof openPenPipe>>, Promise<void>>;
  readonly dialing: Set<AbortController>;
  readonly settling: Set<Promise<void>>;
  readonly sockets: Map<NodeStream.Duplex, number>;
  readonly waiting: Array<{ resolve: () => void; reject: (error: Error) => void }>;
  closed: boolean;
  active: number;
  token?: { token: string; expiresAt: number } | undefined;
  flight?: Promise<{ token: string; expiresAt: number }> | undefined;
}
interface Dependencies {
  readonly membership: {
    readonly requireMember: (pin: DesktopPenPin) => Promise<DesktopPenMembers.NativePenMembership>;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly resolvePenBinary: () => Promise<string | undefined>;
  readonly spawn: PenPipeDeps["spawn"];
  readonly randomBytes: (size: number) => Uint8Array;
  readonly appOrigins: readonly string[];
  readonly now?: () => number;
  readonly stateDir?: string;
}

export function makePenGateway(deps: Dependencies) {
  const routes = new Map<string, Route>();
  const sockets = new Set<import("node:net").Socket>();
  let server: NodeHttp.Server | undefined;
  let listening: Promise<number> | undefined;
  let port = 0;
  let disposed = false;
  const opens = new Map<string, Promise<DesktopPenRouteResult>>();
  let children = 0;
  const key = (pin: DesktopPenPin) => `${pin.meshId}:${pin.nodeId}:${pin.noisePub}`;
  const endRoute = async (route: Route) => {
    route.closed = true;
    route.token = undefined;
    routes.delete(key(route.pin));
    for (const controller of route.dialing) controller.abort();
    for (const socket of route.sockets.keys()) socket.destroy();
    for (const waiter of route.waiting.splice(0)) waiter.reject(new Error("closed"));
    await Promise.all(route.settling);
    await Promise.all([...route.children].map((pipe) => release(route, pipe)));
    await Promise.all(route.releasing.values());
  };
  const unsubscribe = deps.membership.subscribe(() => {
    for (const route of routes.values())
      void deps.membership
        .requireMember(route.pin)
        .then((state) => {
          if (state === "not-member") return endRoute(route);
        })
        .catch(() => endRoute(route));
  });
  const wake = (route: Route) => {
    // A woken waiter checks its own limit again; a mint is not bound by the live-forward one.
    if (!route.closed && route.dialing.size < 6 && children < 128) route.waiting.shift()?.resolve();
  };
  const trackSocket = (route: Route, socket: NodeStream.Duplex) => {
    route.sockets.set(socket, (route.sockets.get(socket) ?? 0) + 1);
    return () => {
      const count = route.sockets.get(socket) ?? 0;
      if (count <= 1) route.sockets.delete(socket);
      else route.sockets.set(socket, count - 1);
    };
  };
  // A session mint is not held behind live forwards: sixteen open sockets must not starve it.
  const saturated = (route: Route, mint: boolean) =>
    (!mint && route.active >= 16) || route.dialing.size >= 6 || children >= 128;
  const untilAborted = <A>(start: () => Promise<A>, signal: AbortSignal) =>
    new Promise<A>((resolve, reject) => {
      const abort = () => reject(new Error("closed"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      start()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  const dial = async (route: Route, signal?: AbortSignal, mint = false) => {
    while (!route.closed && saturated(route, mint)) {
      if (route.waiting.length >= 8) throw new Error("busy");
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const index = route.waiting.indexOf(waiter);
          if (index >= 0) route.waiting.splice(index, 1);
          reject(new Error("closed"));
        };
        const waiter = {
          resolve: () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
          reject: (error: Error) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        };
        if (signal?.aborted) return reject(new Error("closed"));
        route.waiting.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (route.closed || signal?.aborted) throw new Error("closed");
    route.active++;
    children++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    route.dialing.add(controller);
    const settled = Promise.withResolvers<void>();
    route.settling.add(settled.promise);
    try {
      const pipe = await openPenPipe(route.pin, {
        spawn: deps.spawn,
        resolveBinary: deps.resolvePenBinary,
        ...(deps.stateDir ? { stateDir: deps.stateDir } : {}),
        requireMember: async (pin) =>
          !route.closed && (await deps.membership.requireMember(pin)) === "member",
        signal: controller.signal,
      });
      if (route.closed) {
        await pipe.kill();
        throw new Error("closed");
      }
      route.children.add(pipe);
      return pipe;
    } catch (error) {
      route.active--;
      children--;
      throw error;
    } finally {
      route.dialing.delete(controller);
      signal?.removeEventListener("abort", abort);
      route.settling.delete(settled.promise);
      settled.resolve();
      for (const item of routes.values()) wake(item);
    }
  };
  const release = (route: Route, pipe: Awaited<ReturnType<typeof openPenPipe>>): Promise<void> => {
    const previous = route.releasing.get(pipe);
    if (previous) return previous;
    if (!route.children.delete(pipe)) return Promise.resolve();
    const done = pipe.kill().finally(() => {
      route.active--;
      children--;
      route.releasing.delete(pipe);
      for (const item of routes.values()) wake(item);
    });
    route.releasing.set(pipe, done);
    return done;
  };
  const token = async (route: Route) => {
    if (route.token && route.token.expiresAt > (deps.now ?? Date.now)() + 60_000)
      return route.token;
    route.flight ??= (async () => {
      // One deadline for the whole mint, so requests waiting on it are answered.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), MINT_DEADLINE_MS);
      let pipe: Awaited<ReturnType<typeof openPenPipe>> | undefined;
      const expire = () => void pipe?.kill();
      deadline.signal.addEventListener("abort", expire, { once: true });
      try {
        pipe = await dial(route, deadline.signal, true);
        if (deadline.signal.aborted) throw new Error("closed");
        const session = await mintPenSession(pipe);
        if (route.closed || deadline.signal.aborted) throw new Error("closed");
        route.token = session;
        return session;
      } catch (error) {
        throw deadline.signal.aborted ? new Error("closed") : error;
      } finally {
        clearTimeout(timer);
        deadline.signal.removeEventListener("abort", expire);
        if (pipe) await release(route, pipe);
      }
    })().finally(() => {
      route.flight = undefined;
    });
    return route.flight;
  };
  const handle = async (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
    const decision = decidePenGatewayRequest({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      port,
      appOrigins: deps.appOrigins,
      routes: [...routes.values()],
    });
    if (decision.kind === "refuse") {
      res.writeHead(decision.status, decision.headers);
      res.end();
      return;
    }
    if (decision.kind === "preflight") {
      res.writeHead(204, decision.headers);
      res.end();
      return;
    }
    if (decision.kind === "upgrade") {
      res.writeHead(400, decision.responseHeaders);
      res.end();
      return;
    }
    const route = decision.route;
    const controller = new AbortController();
    const untrack = trackSocket(route, req.socket);
    res.once("close", () => {
      untrack();
      if (!res.writableFinished) controller.abort();
    });
    try {
      const state = await deps.membership.requireMember(route.pin);
      if (state !== "member") {
        if (state === "not-member") await endRoute(route);
        res.writeHead(503, decision.responseHeaders);
        res.end();
        return;
      }
      const session = isPublicPenDescriptor(req.method ?? "", decision.path)
        ? undefined
        : await untilAborted(() => token(route), controller.signal);
      if (res.destroyed) return;
      const pipe = await dial(route, controller.signal);
      if (res.destroyed) {
        await release(route, pipe);
        return;
      }
      const onClose = () => {
        if (!res.writableFinished) void release(route, pipe);
      };
      res.once("close", onClose);
      try {
        const length = req.headers["content-length"];
        const bodyLength = length === undefined ? undefined : Number(length);
        if (bodyLength !== undefined && (!Number.isSafeInteger(bodyLength) || bodyLength < 0))
          throw new Error("invalid length");
        const head = {
          method: req.method ?? "GET",
          target: decision.path,
          host: "goat",
          headers: [
            ...Object.entries(decision.headers),
            ...(session ? [["authorization", `Bearer ${session.token}`]] : []),
          ] as [string, string][],
          ...(bodyLength === undefined ? {} : { bodyLength }),
        };
        await exchangePenResponse(
          pipe,
          head,
          async (event) => {
            if (event.type === "head") {
              if (event.status === 401) route.token = undefined;
              if (event.status >= 300 && event.status < 400 && event.status !== 304)
                throw new Error("redirect refused");
              // A body that ends only when the pipe does cannot be told from a cut one.
              const framed = event.headers.some(
                ([name]) => name === "content-length" || name === "transfer-encoding",
              );
              const bodiless =
                req.method === "HEAD" || event.status === 204 || event.status === 304;
              if (!framed && !bodiless) throw new Error("unframed response");
              res.writeHead(
                event.status,
                filterPenResponseHeaders(event.headers, decision.responseHeaders),
              );
            } else if (event.type === "body") {
              if (!res.write(event.bytes))
                await new Promise<void>((resolve, reject) => {
                  const cleanup = () => {
                    res.removeListener("drain", drain);
                    res.removeListener("error", fail);
                    res.removeListener("close", closed);
                  };
                  const drain = () => {
                    cleanup();
                    resolve();
                  };
                  const fail = (error: Error) => {
                    cleanup();
                    reject(error);
                  };
                  const closed = () => fail(new Error("client closed"));
                  res.once("drain", drain);
                  res.once("error", fail);
                  res.once("close", closed);
                });
            } else res.end();
          },
          bodyLength ? { body: req } : {},
        );
      } finally {
        res.removeListener("close", onClose);
        await release(route, pipe);
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(
          error instanceof Error &&
            (error.message === "busy" ||
              error.message === "Pen membership unavailable" ||
              error.message === "closed")
            ? 503
            : 502,
          decision.responseHeaders,
        );
        res.end();
      }
    }
  };
  const handleUpgrade = async (
    req: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    initial: Buffer,
  ) => {
    const decision = decidePenGatewayRequest({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      port,
      appOrigins: deps.appOrigins,
      routes: [...routes.values()],
      upgrade: true,
    });
    const refuse = (status: number, headers: Record<string, string>) => {
      const fields = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.end(
        `HTTP/1.1 ${status} Refused\r\n${fields}Content-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    };
    if (decision.kind === "refuse") return refuse(decision.status, decision.headers);
    if (decision.kind !== "upgrade") return refuse(400, {});
    const route = decision.route;
    const controller = new AbortController();
    const untrack = trackSocket(route, socket);
    socket.once("close", () => {
      untrack();
      controller.abort();
    });
    // Reading keeps the departure of the client visible; what it sent early waits for the 101.
    const early: Buffer[] = initial.length ? [initial] : [];
    let earlyBytes = initial.length;
    const onEarly = (chunk: Buffer) => {
      early.push(chunk);
      earlyBytes += chunk.length;
      if (earlyBytes > EARLY_UPGRADE_BYTES) socket.destroy();
    };
    const onEnd = () => socket.destroy();
    socket.on("data", onEarly);
    socket.once("end", onEnd);
    const wsKey = decision.headers["sec-websocket-key"];
    const offered = decision.headers["sec-websocket-protocol"];
    const protocols = offered?.split(",").map((value) => value.trim());
    if (!wsKey || protocols?.some((value) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)))
      return refuse(400, decision.responseHeaders);
    const protocol = protocols?.[0];
    let pipe: Awaited<ReturnType<typeof openPenPipe>> | undefined;
    let handshakeWritten = false;
    let abandon: (() => void) | undefined;
    try {
      if ((await deps.membership.requireMember(route.pin)) !== "member")
        return refuse(503, decision.responseHeaders);
      const session = await untilAborted(() => token(route), controller.signal);
      pipe = await dial(route, controller.signal);
      // Until the socket owns the pipe, a client that leaves must not leave its child behind.
      const dialed = pipe;
      abandon = () => void release(route, dialed);
      socket.once("close", abandon);
      if (socket.destroyed) return;
      let response:
        | Extract<import("@goat/pen-protocol/client/http1").ResponseEvent, { type: "head" }>
        | undefined;
      let upgraded = false;
      const headers = Object.entries(decision.headers).filter(
        ([name]) => !name.startsWith("sec-websocket-"),
      );
      headers.push(["authorization", `Bearer ${session.token}`]);
      const upgradeHeaders: [string, string][] = [
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Key", wsKey],
        ["Sec-WebSocket-Version", decision.headers["sec-websocket-version"] ?? "13"],
      ];
      if (protocol) upgradeHeaders.push(["Sec-WebSocket-Protocol", protocol]);
      const result = await exchangePenResponse(
        pipe,
        { method: "GET", target: decision.path, host: "goat", headers },
        async (event) => {
          if (event.type === "head") response = event;
          if (event.type === "end" && event.delimiter === "upgrade") upgraded = true;
        },
        {
          bodyCap: UPGRADE_REFUSAL_BODY_CAP,
          upgrade: { key: wsKey, ...(protocol ? { protocol } : {}), headers: upgradeHeaders },
        },
      );
      if (!response || !upgraded) {
        if (response?.status === 401) route.token = undefined;
        const status = response?.status ?? 502;
        return refuse(
          status >= 300 && status < 400 && status !== 304 ? 502 : status,
          decision.responseHeaders,
        );
      }
      const allowed = response.headers.filter(([name]) =>
        ["upgrade", "connection", "sec-websocket-accept", "sec-websocket-protocol"].includes(name),
      );
      const fields = [...Object.entries(decision.responseHeaders), ...allowed]
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${fields}\r\n`);
      handshakeWritten = true;
      // An idle socket is normal once it is a WebSocket; the listener's idle limit is for requests.
      if ("setTimeout" in socket && typeof socket.setTimeout === "function") socket.setTimeout(0);
      if (result.leftover.length) socket.write(result.leftover);
      socket.removeListener("data", onEarly);
      socket.removeListener("end", onEnd);
      socket.pause();
      for (const chunk of early) await pipe.write(chunk);
      const active = pipe;
      const stdin = active.child.stdin;
      if (!stdin) throw new Error("Pen pipe is missing stdin");
      pipe = undefined;
      socket.removeListener("close", abandon);
      abandon = undefined;
      const done = () => {
        socket.destroy();
        void release(route, active);
      };
      NodeStream.pipeline(socket, stdin, done);
      NodeStream.pipeline(active.stdout, socket, done);
    } catch {
      if (handshakeWritten) socket.destroy();
      else refuse(502, decision.responseHeaders);
    } finally {
      if (abandon) socket.removeListener("close", abandon);
      if (pipe) await release(route, pipe);
    }
  };
  const listen = () => {
    if (listening) return listening;
    const attempt = new Promise<number>((resolve, reject) => {
      const instance = guardErrors(
        NodeHttp.createServer(
          { maxHeaderSize: 16 * 1024, insecureHTTPParser: false },
          (req, res) => {
            guardErrors(req, () => req.destroy());
            guardErrors(res, () => res.destroy());
            void handle(req, res).catch(() => res.destroy());
          },
        ),
        (error) => {
          reject(error);
          for (const socket of sockets) socket.destroy();
        },
      );
      server = instance;
      instance.maxConnections = 256;
      instance.headersTimeout = 5000;
      instance.requestTimeout = 600000;
      instance.keepAliveTimeout = 5000;
      instance.timeout = 120000;
      instance.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        guardErrors(socket, () => socket.destroy());
      });
      instance.on("timeout", (socket) => socket.destroy());
      instance.on("upgrade", (request, socket, initial) => {
        // Node takes its own idle timer off a socket it hands over; the handshake keeps one.
        if ("setTimeout" in socket && typeof socket.setTimeout === "function")
          socket.setTimeout(120000, () => socket.destroy());
        void handleUpgrade(request, socket, initial).catch(() => socket.destroy());
      });
      instance.on("clientError", (_error, socket) => {
        socket.end(
          "HTTP/1.1 400 Bad Request\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      });
      instance.listen(0, "127.0.0.1", () => {
        const address = instance.address();
        if (!address || typeof address === "string") return reject(new Error("no port"));
        port = address.port;
        resolve(port);
      });
    });
    listening = attempt;
    // A listener that failed to bind is not kept: the next open tries again.
    attempt.catch(() => {
      if (listening === attempt) listening = undefined;
    });
    return attempt;
  };
  return {
    open: (pin: DesktopPenPin): Promise<DesktopPenRouteResult> => {
      const routeKey = key(pin);
      const existing = opens.get(routeKey);
      if (existing) return existing;
      if (opens.size >= 64) return Promise.resolve({ kind: "refused", reason: "busy" });
      const opening = (async (): Promise<DesktopPenRouteResult> => {
        const membership = await deps.membership.requireMember(pin);
        if (membership !== "member") return { kind: "refused", reason: membership };
        const current = routes.get(routeKey);
        if (current && !current.closed && !disposed) {
          const base = `127.0.0.1:${port}/pen-route/${current.capability}`;
          return { kind: "open", httpBaseUrl: `http://${base}`, socketUrl: `ws://${base}` };
        }
        if (!(await deps.resolvePenBinary())) return { kind: "refused", reason: "no-pen-binary" };
        if (disposed) return { kind: "refused", reason: "unavailable" };
        const boundPort = await listen();
        if (disposed || (await deps.membership.requireMember(pin)) !== "member")
          return { kind: "refused", reason: "unavailable" };
        if (disposed) return { kind: "refused", reason: "unavailable" };
        let route = routes.get(routeKey);
        if (!route) {
          if (routes.size >= 64) return { kind: "refused", reason: "busy" };
          const bytes = deps.randomBytes(32);
          if (bytes.length !== 32) return { kind: "refused", reason: "unavailable" };
          const capability = Buffer.from(bytes).toString("base64url");
          if ([...routes.values()].some((item) => item.capability === capability))
            return { kind: "refused", reason: "unavailable" };
          route = {
            pin,
            capability,
            children: new Set(),
            releasing: new Map(),
            dialing: new Set(),
            settling: new Set(),
            sockets: new Map(),
            waiting: [],
            closed: false,
            active: 0,
          };
          routes.set(routeKey, route);
        }
        const base = `127.0.0.1:${boundPort}/pen-route/${route.capability}`;
        return { kind: "open", httpBaseUrl: `http://${base}`, socketUrl: `ws://${base}` };
      })()
        .catch((): DesktopPenRouteResult => ({ kind: "refused", reason: "unavailable" }))
        .finally(() => {
          opens.delete(routeKey);
        });
      opens.set(routeKey, opening);
      return opening;
    },
    close: async (pin: DesktopPenPin) => {
      const routeKey = key(pin);
      await opens.get(routeKey);
      const route = routes.get(routeKey);
      if (route) await endRoute(route);
    },
    dispose: async () => {
      disposed = true;
      unsubscribe();
      await Promise.allSettled(opens.values());
      await Promise.all([...routes.values()].map(endRoute));
      for (const socket of sockets) socket.destroy();
      const currentServer = server;
      if (currentServer?.listening)
        await new Promise<void>((resolve) => currentServer.close(() => resolve()));
    },
  };
}

export class PenGateway extends Context.Reference<ReturnType<typeof makePenGateway>>(
  "@goat/desktop/pen/PenGateway",
  {
    defaultValue: () => ({
      open: async () => ({ kind: "refused", reason: "unavailable" }),
      close: async () => {},
      dispose: async () => {},
    }),
  },
) {}

const layerOpen = Layer.effect(
  PenGateway,
  Effect.gen(function* () {
    const members = yield* DesktopPenMembers.DesktopPenMembers;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const platform = yield* HostProcess.Platform;
    const hostEnvironment = yield* HostProcess.Environment;
    const stateDir = penStateDir(hostEnvironment, environment.homeDirectory);
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const gateway = makePenGateway({
      membership: {
        requireMember: (pin) =>
          runPromise(members.requireMember?.(pin) ?? Effect.succeed("unavailable")),
        subscribe: (listener) => members.subscribeMembership?.(listener) ?? (() => {}),
      },
      resolvePenBinary: () => resolvePenBinary({ platform, path: hostEnvironment.PATH }),
      ...(stateDir ? { stateDir } : {}),
      spawn: (path, args, options) => NodeChildProcess.spawn(path, [...args], options),
      randomBytes: NodeCrypto.randomBytes,
      appOrigins: [getDesktopOrigin(environment.isDevelopment)],
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => gateway.dispose()));
    return gateway;
  }),
);

/** With the viewer closed nothing is provided: the reference's default refuses every open. */
export const layerWith = (policy: PenViewerPolicy) => (policy.enabled ? layerOpen : Layer.empty);

export const layer = layerWith({ enabled: PEN_VIEWER_ENABLED });
