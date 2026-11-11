import { it as effectIt } from "@effect/vitest";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { FetchHttpClient } from "effect/http";

import { countingTracer } from "../observability/countingTracer.testkit.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const layerNoProc = FileSystem.layerNoop({});

const layerProbeFailure = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = layerNoProc,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystem,
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const LSOF_TEST_PORT = 43_123;

const processOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const ownedScanner = (processIds: ReadonlyArray<number> = [1234]) =>
  Effect.tap(PortScanner.PortDiscovery, (scanner) =>
    scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds,
    }),
  );

const layerLsofScanner = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly stdout?: () => string;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: input.stdout?.() ?? `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

effectIt.effect.each(["linux", "win32"] as const)(
  "disables listener discovery on %s while probing configured URLs (#2342)",
  (platform) => {
    const commands: string[] = [];
    const procReads: string[] = [];
    const requests: string[] = [];
    const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
    const missing = FileSystem.makeNoop({});
    const fileSystem = FileSystem.layerNoop({
      readFileString: (path) => {
        procReads.push(path);
        return missing.readFileString(path);
      },
      readDirectory: (path) => {
        procReads.push(path);
        return missing.readDirectory(path);
      },
      readLink: (path) => {
        procReads.push(path);
        return missing.readLink(path);
      },
    });
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          fileSystem,
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              commands.push(input.command);
              return processProbeFailure(input);
            },
          }),
          Layer.succeed(HostProcess.Platform, platform),
          Layer.succeed(HostProcess.Environment, { GOAT_PORT_DISCOVERY: "0" }),
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
        ),
      ),
    );
    return Effect.gen(function* () {
      const scanner = yield* ownedScanner();
      const servers = yield* scanner.scan([configuredUrl]);
      expect(commands).toEqual([]);
      expect(procReads).toEqual([]);
      expect(requests).toEqual([configuredUrl]);
      expect(servers.map((server) => ({ url: server.url, terminal: server.terminal }))).toEqual([
        { url: configuredUrl, terminal: null },
      ]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("keeps a full configured URL when the discovered server root fails", () => {
  const requests: string[] = [];
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === configuredUrl
        ? new Response("docs", { headers: { "content-type": "text/html" } })
        : new Response("not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes configured custom ports through a canonical loopback host", () => {
  const customPort = 43_124;
  const configuredUrl = `http://0.0.0.0:${customPort}/docs`;
  const expectedUrl = `http://localhost:${customPort}/docs`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.host).toBe("localhost");
    expect(servers[0]?.port).toBe(customPort);
    expect(servers[0]?.url).toBe(expectedUrl);
    expect(requests).toEqual([expectedUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("preserves explicit loopback hosts and bounds wildcard rewrites", () => {
  const ipv4Url = "https://127.0.0.1:43125/docs";
  const ipv6Url = "http://[::1]:43126/docs";
  const wildcardPrefix = "http://0.0.0.0/";
  const maximumWildcardUrl = `${wildcardPrefix}${"a".repeat(
    PREVIEW_URL_MAX_LENGTH - wildcardPrefix.length,
  )}`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([ipv4Url, ipv6Url, maximumWildcardUrl]);
    expect(servers.map((server) => server.url)).toEqual([ipv4Url, ipv6Url]);
    expect(requests).toEqual([ipv4Url, ipv6Url]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("projects configured paths independently for simultaneous subscribers", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  let ready = true;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    return Promise.resolve(
      ready && (url === docsUrl || url === adminUrl)
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    yield* scanner.subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    );
    yield* scanner.subscribe({ configuredUrls: [adminUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    );
    yield* scanner.retain;

    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);

    ready = false;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect(
  "keeps each subscriber's candidates when their combined union exceeds the per-client cap",
  () => {
    const firstSubscriberUrls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:${LSOF_TEST_PORT}/app-${index}`,
    );
    const secondSubscriberUrl = `http://localhost:${LSOF_TEST_PORT}/app-${CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS}`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(
        String(input) === secondSubscriberUrl
          ? new Response("app", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      )) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const secondSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
      yield* scanner.subscribe(
        { configuredUrls: firstSubscriberUrls, initialSnapshot: [] },
        () => Effect.void,
      );
      yield* scanner.subscribe(
        { configuredUrls: [secondSubscriberUrl], initialSnapshot: [] },
        (servers) => Effect.sync(() => secondSnapshots.push(servers)),
      );
      yield* scanner.retain;

      expect(secondSnapshots.at(-1)?.[0]?.url).toBe(secondSubscriberUrl);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

effectIt.effect("stops probing a subscriber's configured paths after its scope closes", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsScope = yield* Scope.make();
    yield* scanner
      .subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, () => Effect.void)
      .pipe(Effect.provideService(Scope.Scope, docsScope));
    yield* scanner.subscribe(
      { configuredUrls: [adminUrl], initialSnapshot: [] },
      () => Effect.void,
    );
    yield* scanner.retain;
    yield* Scope.close(docsScope, Exit.void);

    requests.length = 0;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(requests).toContain(adminUrl);
    expect(requests).not.toContain(docsUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("uses the current configured fragment when readiness comes from cache", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });
  const oldUrl = `http://localhost:${LSOF_TEST_PORT}/docs#old`;
  const newUrl = `http://localhost:${LSOF_TEST_PORT}/docs#new`;

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect((yield* scanner.scan([oldUrl]))[0]?.url).toBe(oldUrl);
    const requestCount = requests.length;
    expect((yield* scanner.scan([newUrl]))[0]?.url).toBe(newUrl);
    expect(requests).toHaveLength(requestCount);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "probes only a configured HTTPS URL, keeps it for an owned listener when the check fails, and does not follow redirects",
  () => {
    const configuredUrl = `https://localhost:${LSOF_TEST_PORT}/app`;
    const requests: Array<readonly [string, string | undefined]> = [];
    let respond = async () =>
      new Response(null, { status: 302, headers: { location: "https://example.com" } });
    const fetchFn = (async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      requests.push([String(input), init?.redirect]);
      return respond();
    }) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner();
      expect(yield* scanner.scan([configuredUrl])).toMatchObject([
        { pid: 1234, url: configuredUrl },
      ]);

      respond = async () => new Response("unavailable", { status: 503 });
      yield* TestClock.adjust(Duration.seconds(15));
      expect(yield* scanner.scan([configuredUrl])).toMatchObject([
        { pid: 1234, url: configuredUrl },
      ]);

      respond = () => Promise.reject(new TypeError("fetch failed"));
      yield* TestClock.adjust(Duration.seconds(15));
      expect(yield* scanner.scan([configuredUrl])).toMatchObject([
        { pid: 1234, url: configuredUrl },
      ]);
      expect(requests).toEqual(Array.from({ length: 3 }, () => [configuredUrl, "manual"]));
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("discovers owned listeners without sending HTTP or TLS probes", () => {
  const owned = `p1234\ncnode\nn[::1]:${LSOF_TEST_PORT}\n`;
  const unowned = `p5678\ncrpc\nn127.0.0.1:${LSOF_TEST_PORT}\n`;
  let stdout = unowned;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn, stdout: () => stdout });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    expect(yield* scanner.scan()).toHaveLength(0);
    stdout = `${owned}${unowned}`;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([]);

    stdout = owned;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([]);

    yield* scanner.unregisterTerminal({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
    });
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "excludes configured URLs answering with HTTP errors, non-navigation responses, or non-documents",
  () => {
    let pid = 1;
    let makeResponse = () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(makeResponse())) as typeof globalThis.fetch;
    const layer = layerLsofScanner({ pid: () => pid, fetch: fetchFn });
    const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/`;

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const scan = () => scanner.scan([configuredUrl]);
      expect(yield* scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      expect(yield* scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("ready", { status: 200, headers: { "content-type": "text/plain" } });
      expect(yield* scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 304, headers: { location: "/cached" } });
      expect(yield* scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response(null, { status: 204, headers: { "content-type": "text/html" } });
      expect(yield* scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 302 });
      expect(yield* scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("<html />", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        });
      expect(yield* scan()).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  },
);

const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:223D 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 20 4 30 10 -1
   3: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5005 1 0000000000000000 100 0 0 10 0
`;
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 100 0 0 10 0
`;

effectIt.effect(
  "prefers Linux /proc over installed lsof, and bounds repeated socket owner lookups",
  () => {
    let lsofSpawns = 0;
    const fdWalks: string[] = [];
    const procFiles: Record<string, string> = {
      "/proc/net/tcp":
        PROC_NET_TCP +
        PROC_NET_TCP.split("\n")[1]!
          .replace("0100007F:223D", "0101007F:1388")
          .replace("5001", "5007"),
      "/proc/net/tcp6": PROC_NET_TCP6,
      "/proc/4242/comm": "python3\n",
    };
    const procFds: Record<string, Record<string, string>> = {
      "4242": {
        "0": "/dev/null",
        "3": "socket:[5001]",
        "4": "socket:[5004]",
        "5": "socket:[5007]",
      },
      "77": { "5": "socket:[9999]" },
    };
    const missing = FileSystem.makeNoop({});
    const fileSystem = FileSystem.layerNoop({
      readFileString: (path) => {
        const content = procFiles[path];
        return content === undefined ? missing.readFileString(path) : Effect.succeed(content);
      },
      readDirectory: (path) => {
        if (path === "/proc") return Effect.succeed(["self", "77", "4242"]);
        const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
        const fds = pid === undefined ? undefined : procFds[pid];
        if (pid === undefined || fds === undefined) return missing.readDirectory(path);
        fdWalks.push(pid);
        return Effect.succeed(Object.keys(fds));
      },
      readLink: (path) => {
        const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path) ?? [];
        const target = pid && fd ? procFds[pid]?.[fd] : undefined;
        return target === undefined ? missing.readLink(path) : Effect.succeed(target);
      },
    });
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = layerProbeFailure(
      () => {
        lsofSpawns += 1;
        return Effect.succeed(processOutput("p4242\ncpython3\nn*:3001\nn*:8765\n"));
      },
      fetchFn,
      fileSystem,
    );

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner([4242]);
      const first = yield* scanner.scan();
      expect(
        first.map(({ port, pid, processName, url }) => ({ port, pid, processName, url })),
      ).toEqual([
        { port: 3001, pid: 4242, processName: "python3", url: "http://localhost:3001" },
        { port: 8765, pid: 4242, processName: "python3", url: "http://localhost:8765" },
      ]);
      yield* scanner.scan();
      expect(lsofSpawns).toBe(0);
      expect(fdWalks).toEqual(["77", "4242", "77", "4242"]);
      yield* scanner.scan();
      yield* scanner.scan();
      expect(fdWalks).toEqual(["77", "4242", "77", "4242", "77", "4242"]);
      procFds["77"]!["6"] = "socket:[5006]";
      procFiles["/proc/net/tcp6"] =
        PROC_NET_TCP6 + PROC_NET_TCP.split("\n")[1]!.replace("5001", "5006");
      expect((yield* scanner.scan()).map(({ port }) => port)).toEqual([3001]);
      const walksAfterCollision = fdWalks.length;
      procFiles["/proc/net/tcp"] = PROC_NET_TCP.split("\n")[0]!;
      procFiles["/proc/net/tcp6"] = PROC_NET_TCP6.split("\n")[0]!;
      expect(yield* scanner.scan()).toEqual([]);
      expect(lsofSpawns).toBe(0);
      expect(fdWalks).toHaveLength(walksAfterCollision);
      expect(requests).toEqual([]);

      procFiles["/proc/net/tcp"] = PROC_NET_TCP;
      procFiles["/proc/net/tcp6"] = PROC_NET_TCP6;
      expect((yield* scanner.scan()).map(({ pid }) => pid)).toEqual([4242, 4242]);
      yield* scanner.retain.pipe(Effect.scoped);
      procFds["77"] = procFds["4242"]!;
      delete procFds["4242"];
      procFiles["/proc/77/comm"] = "python3\n";
      yield* scanner.registerTerminalProcesses({
        threadId: "scanner-thread",
        terminalId: "scanner-terminal",
        processIds: [77],
      });
      expect((yield* scanner.scan()).map(({ port, pid }) => ({ port, pid }))).toEqual([
        { port: 3001, pid: 77 },
        { port: 8765, pid: 77 },
      ]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect.each([
  { mode: "missing", fallback: true },
  { mode: "denied", fallback: true },
  { mode: "invalid", fallback: true },
  { mode: "fd-unavailable", fallback: true },
  { mode: "fd-budget", fallback: true },
  { mode: "fd-budget-no-lsof", fallback: true },
  { mode: "ipv6-denied", fallback: true },
  { mode: "ipv6-absent", fallback: false },
  { mode: "empty", fallback: false },
  { mode: "darwin", fallback: true },
] as const)("uses lsof only if Linux /proc is unusable: $mode", ({ mode, fallback }) => {
  let lsofSpawns = 0;
  let procWalks = 0;
  const missing = FileSystem.makeNoop({});
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: (path) => {
            if (!path.startsWith("/proc/net/tcp") || mode === "missing") {
              return missing.readFileString(path);
            }
            if (mode === "denied" || (mode === "ipv6-denied" && path.endsWith("tcp6"))) {
              return Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "readFileString",
                }),
              );
            }
            if (mode === "ipv6-absent" && path.endsWith("tcp6")) {
              return missing.readFileString(path);
            }
            if (mode === "invalid") return Effect.succeed("unusable table");
            return Effect.succeed(
              mode === "fd-unavailable" || mode.startsWith("fd-budget")
                ? PROC_NET_TCP
                : PROC_NET_TCP.split("\n")[0]!,
            );
          },
          readDirectory: (path) => {
            if (!mode.startsWith("fd-budget")) return missing.readDirectory(path);
            if (path === "/proc") procWalks += 1;
            if (mode === "fd-budget-no-lsof") {
              if (path === "/proc") return Effect.succeed(["1234", "9999"]);
              if (path === "/proc/1234/fd") return Effect.succeed(["3"]);
            }
            return Effect.succeed(
              path === "/proc"
                ? ["1", "1234"]
                : Array.from({ length: 50_000 }, (_, i) => String(i)),
            );
          },
          readLink: (path) =>
            mode === "fd-budget-no-lsof" && path === "/proc/1234/fd/3"
              ? Effect.succeed("socket:[5001]")
              : mode.startsWith("fd-budget")
                ? Effect.succeed("/dev/null")
                : missing.readLink(path),
        }),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            lsofSpawns += 1;
            if (mode === "fd-budget-no-lsof") return processProbeFailure(input);
            return Effect.succeed(processOutput(`p1234\ncnode\nn*:${LSOF_TEST_PORT}\n`));
          },
        }),
        Layer.succeed(HostProcess.Platform, mode === "darwin" ? "darwin" : "linux"),
        FetchHttpClient.layer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    expect((yield* scanner.scan()).map(({ port }) => port)).toEqual(
      mode === "fd-budget-no-lsof" ? [8765] : fallback ? [LSOF_TEST_PORT] : [],
    );
    if (mode === "fd-budget-no-lsof") {
      for (let i = 0; i < 3; i += 1) {
        expect((yield* scanner.scan()).map(({ port }) => port)).toEqual([8765]);
      }
      expect(procWalks).toBe(4);
    }
    expect(lsofSpawns).toBe(fallback ? 1 : 0);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("ignores a partial Windows netstat snapshot when one query exits nonzero", () => {
  let ipv6Fails = true;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            if (input.command === "tasklist.exe") {
              return Effect.succeed(
                processOutput('"node.exe","1234","Console","1","50,000 K"\r\n'),
              );
            }
            const isIpv6 = input.args.includes("tcpv6");
            return Effect.succeed({
              stdout: isIpv6
                ? ""
                : "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234\r\n",
              stderr: "",
              code: isIpv6 && ipv6Fails ? ChildProcessSpawner.ExitCode(1) : null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
        Layer.succeed(HostProcess.Platform, "win32"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    ),
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds: [1234],
    });
    expect(yield* scanner.scan()).toEqual([]);
    ipv6Fails = false;
    expect(yield* scanner.scan()).toMatchObject([
      { port: 5173, pid: 1234, processName: "node", url: "http://localhost:5173" },
    ]);
    expect(requests).toEqual([]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("traces requested scans without spans for routine polling helpers", () => {
  const spans = new Map<string, number>();
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.scan();
    expect(spans.get("PortDiscovery.scan")).toBe(1);
    expect(spans.get("PortDiscovery.scanUnlocked") ?? 0).toBe(0);
    expect(spans.get("PortDiscovery.probeWebServers") ?? 0).toBe(0);
    expect(spans.get("PortDiscovery.scanSnapshot") ?? 0).toBe(0);
    expect(spans.get("PortDiscovery.pollTick") ?? 0).toBe(0);
  }).pipe(
    Effect.provide(layerProbeFailure(processProbeFailure)),
    Effect.withTracer(countingTracer(spans)),
  );
});
