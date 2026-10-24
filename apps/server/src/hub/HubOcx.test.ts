import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure, type HostThreadCounts } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Inventory from "../opencodex/OpenCodexInventory.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  countLinkTunnels,
  deviceScript,
  guardedSyncScript,
  healthScript,
  HubOcx,
  layer as hubOcxLayer,
  parseDeviceOutput,
  platformOf,
  SYNC_EXIT,
} from "./HubOcx.ts";

const services = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));
const CODE = "ocx_pair_Q0xJRU5UX1RFU1RfQ09ERV9GSVhUVVJFXzAwMDAwMDAwMDA";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("hub-fixture"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "hub-test",
  thread: undefined,
  client: { sessionId: "test", label: "Test client", access: "full-access" },
};

/** The device answers `goat_host_status` live with these thread counts. */
const deviceReporting = (threads: HostThreadCounts) =>
  hubOcxLayer.pipe(
    Layer.provide(
      Layer.mock(HostThreads.HostThreadsMcpService)({
        readOnHost: (_scope, input, decode) =>
          decode({
            hosts: [
              {
                host: null,
                reachability: "ok",
                metrics: {
                  sampledAt: 0,
                  cpuCount: 1,
                  cpuUtilization: 0,
                  totalMemoryBytes: 1,
                  availableMemoryBytes: 1,
                  loadAvg: null,
                  disk: null,
                  threads,
                  quotas: [],
                },
              },
            ],
          }).pipe(
            Effect.map((result) => ({ ...result, host: input.host })),
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Invalid fixture",
                }),
            ),
          ),
      }),
    ),
    Layer.provide(Layer.mock(ProcessRunner.ProcessRunner)({})),
    Layer.provide(Layer.mock(Inventory.OpenCodexInventory)({})),
    Layer.provide(Layer.mock(Dispatch.SshRemoteDispatch)({})),
    Layer.provide(NodeServices.layer),
  );

// ADR-0019's restart rung waits for these turns; a running subagent is work a restart interrupts.
it.effect.each([
  {
    name: "one subagent and no top-level turn",
    threads: { running: 0, subagentsRunning: 1 },
    expected: 1,
  },
  {
    name: "top-level and subagent turns",
    threads: { running: 2, subagentsRunning: 1 },
    expected: 3,
  },
  { name: "nothing running", threads: { running: 0, subagentsRunning: 0 }, expected: 0 },
  { name: "a host too old to report subagents", threads: { running: 0 }, expected: undefined },
])("counts running turns on a device with $name", ({ threads, expected }) =>
  Effect.gen(function* () {
    const ocx = yield* HubOcx;
    expect(yield* ocx.runningTurns("macmini-ts", scope)).toBe(expected);
  }).pipe(Effect.provide(deviceReporting({ waiting: 0, queued: 0, ...threads }))),
);

it.live("runs the Desktop ocx without letting it read the rest of the script", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-hub-ocx-" });
    const bin = path.join(home, ".opencodex-desktop", "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    // A greedy ocx that drains stdin would swallow the exit marker printed after it.
    yield* fs.writeFileString(
      path.join(bin, "ocx"),
      '#!/bin/sh\ncat >/dev/null; printf "%s|" "$@"; exit 3\n',
      { mode: 0o755 },
    );
    const output = yield* (yield* ProcessRunner.ProcessRunner).run({
      command: "sh",
      args: ["-s"],
      stdin: deviceScript(["link", "status", "--json"]),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    expect(parseDeviceOutput(output.stdout)).toEqual({ code: 3, stdout: "link|status|--json|" });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses an argument the shell could interpret", () =>
  Effect.sync(() => {
    expect(() => deviceScript(["sync", "$(id)"])).toThrow(TypeError);
    expect(() => deviceScript(["connect", "--pairing-code-stdin"], "ocx_pair_x'; id; '")).toThrow(
      TypeError,
    );
  }),
);

// Git Bash on mini: a home under a path with spaces, like C:\Program Files.
it.live("hands the pairing code to ocx on stdin only, under a home path with spaces", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-hub-connect-" });
    const home = path.join(root, "Program Files", "user");
    const bin = path.join(home, ".opencodex-desktop", "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(
      path.join(bin, "ocx"),
      '#!/bin/sh\nprintf "argv=%s|" "$@"; IFS= read -r goat_line; printf "stdin=%s" "$goat_line"; exit 0\n',
      { mode: 0o755 },
    );
    const args = [
      "connect",
      "https://jun-mbp.tailnet-example.ts.net:8443",
      "--management-url",
      "https://jun-mbp.tailnet-example.ts.net",
      "--pairing-code-stdin",
    ];
    const script = deviceScript(args, CODE);
    const output = yield* (yield* ProcessRunner.ProcessRunner).run({
      command: "sh",
      args: ["-s"],
      stdin: script,
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    const parsed = parseDeviceOutput(output.stdout);
    expect(parsed?.code).toBe(0);
    const [argv, stdin] = parsed!.stdout.split("stdin=");
    expect(argv).toBe(`${args.map((arg) => `argv=${arg}|`).join("")}`);
    expect(argv).not.toContain(CODE);
    expect(stdin).toBe(CODE);
    // printf is the shell's builtin, so the code is never any process's argv.
    expect(script).toContain(`printf '%s\\n' '${CODE}' | "$goat_ocx"`);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect.each([
  ["MINGW64_NT-10.0-26200\n", "windows"],
  ["MSYS_NT-10.0-19045", "windows"],
  ["CYGWIN_NT-10.0", "windows"],
  ["Windows_NT", "windows"],
  ["Darwin\n", "posix"],
  ["Linux", "posix"],
  ["", undefined],
] as const)("uname %j is %s", ([uname, platform]) =>
  Effect.sync(() => expect(platformOf(uname)).toBe(platform)),
);

it.live("reads /healthz on the port OpenCodex's config names", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-hub-health-" });
    yield* fs.makeDirectory(path.join(home, ".opencodex"));
    yield* fs.writeFileString(
      path.join(home, ".opencodex", "config.json"),
      '{\n  "port": 10234,\n  "runtimeRole": "standalone"\n}\n',
    );
    const bin = path.join(home, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(
      path.join(bin, "curl"),
      '#!/bin/sh\nfor goat_arg; do goat_url=$goat_arg; done\nprintf \'{"service":"opencodex","url":"%s"}\' "$goat_url"\n',
      { mode: 0o755 },
    );
    const output = yield* (yield* ProcessRunner.ProcessRunner).run({
      command: "sh",
      args: ["-s"],
      stdin: healthScript,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(parseDeviceOutput(output.stdout)).toEqual({
      code: 0,
      stdout: '{"service":"opencodex","url":"http://127.0.0.1:10234/healthz"}',
    });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("counts only OpenCodex's ssh -R tunnel for the link", () =>
  Effect.sync(() => {
    const tunnel = (port: number, alias: string) =>
      `ssh -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -R 127.0.0.1:${port}:127.0.0.1:56603 -- ${alias}`;
    const processes = [
      tunnel(42255, "lidge-ts"),
      tunnel(54958, "macmini-ts"),
      "ssh -T -o ClearAllForwardings=yes -- lidge-ts sh",
      "/usr/bin/vim lidge-ts -R 127.0.0.1:42255:x",
    ].join("\n");
    expect(countLinkTunnels(processes, "lidge-ts", 42255)).toBe(1);
    expect(countLinkTunnels(processes, "lidge-ts", undefined)).toBe(1);
    expect(countLinkTunnels(processes, "mini", 52889)).toBe(0);
    // mini's Home-initiated link as the Home ran it, before its revoke.
    expect(countLinkTunnels(`${processes}\n${tunnel(52889, "mini")}`, "mini", 52889)).toBe(1);
  }),
);

const LINK = "lnk_781ccea3cdb84745";
const linkStatus = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      state: "connected",
      transport: "link",
      link: { linkId: LINK, tunnelPort: 54365 },
      serverUrl: "http://127.0.0.1:54365",
      catalog: "present",
      ...overrides,
    },
    null,
    2,
  );

/**
 * A Child as the guarded sync finds it: `ocx connect status --json` answers from `statuses` in
 * order (the last answer repeats), and `ocx sync` prints `syncOutput`. Only the temporary
 * home's tools are on PATH, so the developer's own OpenCodex is never found.
 */
const guardedChild = Effect.fn("HubOcxTest.guardedChild")(function* (
  statuses: ReadonlyArray<string>,
  syncOutput = "Remote Link Home catalog synchronized.",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-guarded-sync-" });
  const bin = path.join(home, "bin");
  yield* fs.makeDirectory(bin);
  const log = path.join(home, "calls.log");
  for (const [index, status] of statuses.entries())
    yield* fs.writeFileString(path.join(home, `status${index + 1}`), status);
  yield* fs.writeFileString(
    path.join(bin, "ocx"),
    [
      "#!/bin/sh",
      `printf 'ocx %s\\n' "$*" >> '${log}'`,
      'case "$1" in',
      "  connect)",
      `    goat_n=$(cat '${home}/count' 2>/dev/null || echo 0); goat_n=$((goat_n + 1))`,
      `    echo "$goat_n" > '${home}/count'`,
      `    [ "$goat_n" -gt ${statuses.length} ] && goat_n=${statuses.length}`,
      `    cat "${home}/status$goat_n" ;;`,
      `  sync) printf '%s\\n' '${syncOutput}' ;;`,
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const tool of ["sh", "cat", "grep"]) {
    for (const directory of ["/bin", "/usr/bin"]) {
      const candidate = path.join(directory, tool);
      if (yield* fs.exists(candidate)) {
        yield* fs.symlink(candidate, path.join(bin, tool));
        break;
      }
    }
  }
  const output = yield* (yield* ProcessRunner.ProcessRunner).run({
    command: "/bin/sh",
    args: ["-s"],
    stdin: guardedSyncScript(LINK, true, { candidates: ['"$HOME/bin/ocx"'], searchPath: "" }),
    env: { HOME: home, PATH: bin },
  });
  const calls = yield* fs.readFileString(log).pipe(
    Effect.map((text) => text.trim().split("\n")),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  return { result: parseDeviceOutput(output.stdout), calls };
});

it.live("syncs a Child only while it is connected over the expected link", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* guardedChild([linkStatus()]);
    expect(result).toEqual({ code: 0, stdout: "Remote Link Home catalog synchronized." });
    expect(calls).toEqual([
      "ocx connect status --json",
      "ocx sync --restart-codex",
      "ocx connect status --json",
    ]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live.each([
  { name: "disconnected", status: linkStatus({ state: "disconnected" }) },
  { name: "a Hub-mode client", status: linkStatus({ transport: "hub" }) },
  {
    name: "linked to another Home",
    status: linkStatus({ link: { linkId: "lnk_another_home", tunnelPort: 1 } }),
  },
  { name: "unreadable", status: "not json" },
])("never runs ocx sync on a machine that is $name", ({ status }) =>
  Effect.gen(function* () {
    const { result, calls } = yield* guardedChild([status]);
    expect(result?.code).toBe(SYNC_EXIT.notConnected);
    expect(calls).toEqual(["ocx connect status --json"]);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("reports a connection that moved while the sync ran", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* guardedChild([
      linkStatus(),
      linkStatus({ state: "disconnected" }),
    ]);
    expect(result?.code).toBe(SYNC_EXIT.connectionChanged);
    expect(calls).toContain("ocx sync --restart-codex");
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.live("passes on OpenCodex's notice that it kept the last remote catalog", () =>
  Effect.gen(function* () {
    const stale =
      "Home unavailable; retained and applied the last-known-good remote catalog (stale).";
    const { result } = yield* guardedChild([linkStatus()], stale);
    expect(result).toEqual({ code: 0, stdout: stale });
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses a link id the guard could not match literally", () =>
  Effect.sync(() => expect(() => guardedSyncScript("lnk.1'", true)).toThrow(TypeError)),
);
