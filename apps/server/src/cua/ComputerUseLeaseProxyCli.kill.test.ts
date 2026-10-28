// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off -- Native CLI pipe fixture with stubbed HTTP reports.
import { assert, it, vi } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import { runLeaseProxyCli } from "./ComputerUseLeaseProxyCli.ts";
import { LEASE_PROXY_ENV } from "./ComputerUseAttachment.ts";
import * as DriverProcess from "./driverProcess.ts";
import * as LeaseProxy from "./ComputerUseLeaseProxy.ts";
import type { LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";

// Real CLI process plumbing: the bound under test is the CLI's own 2 s wall-clock limit.
it.live("a killed driver whose pipes never close still lets the proxy's cutoff finish", () =>
  Effect.gen(function* () {
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    const providerInput = new NodeStream.PassThrough();
    // A child that never reports close, as when a grandchild keeps its pipes open.
    const child = Object.assign(new NodeChildProcess.ChildProcess(), {
      stdin,
      stdout,
      stdio: [stdin, stdout, null],
    });
    let killed = false;
    using _spawn = vi
      .spyOn(DriverProcess, "spawnDriverProcess")
      .mockReturnValue(child as ReturnType<typeof DriverProcess.spawnDriverProcess>);
    using _end = vi.spyOn(DriverProcess, "endDriversWithProxy").mockImplementation(() => undefined);
    using _kill = vi.spyOn(DriverProcess, "killDriverGroup").mockImplementation(() => undefined);
    using _exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    using _stdin = vi
      .spyOn(process, "stdin", "get")
      .mockReturnValue(providerInput as unknown as typeof process.stdin);
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    using _proxy = vi
      .spyOn(LeaseProxy, "runLeaseProxy")
      .mockImplementation(<EU, ED>(options: LeaseProxyOptions<EU, ED>) =>
        Effect.gen(function* () {
          const driver = yield* options.startDriver;
          yield* driver.kill;
          killed = true;
          return undefined;
        }),
      );
    vi.stubEnv(LEASE_PROXY_ENV.url, "http://goat.test/api/computer-use/lease");
    vi.stubEnv(LEASE_PROXY_ENV.authorization, "Bearer fixture");
    vi.stubEnv(
      LEASE_PROXY_ENV.driver,
      JSON.stringify({ command: "/fixture-driver", args: [], environment: [] }),
    );
    vi.stubEnv(LEASE_PROXY_ENV.proxyChannelToken, undefined);
    try {
      yield* Effect.promise(() =>
        runLeaseProxyCli(["--control", "control:fixture", "--expires", "2030-01-01T00:00:00Z"]),
      );
    } finally {
      vi.unstubAllEnvs();
      stdin.destroy();
      stdout.destroy();
      providerInput.destroy();
    }
    assert.isTrue(killed);
  }),
);
