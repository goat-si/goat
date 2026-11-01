import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as RpcHttp from "../rpc/http.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import {
  directRequestTimeout,
  isLoopbackEntry,
  isLocalServerConnection,
  retryDelayMs,
} from "./loopbackHost.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget, SshConnectionTarget } from "./model.ts";

const environmentId = EnvironmentId.make("environment-1");
const local = "http://127.0.0.1:3773";
const primary = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({ environmentId, label: "Mac", httpBaseUrl, wsBaseUrl: httpBaseUrl });

describe("loopback hosts", () => {
  it("treats only a non-SSH loopback connection as this device's own server", () => {
    const ssh = new SshConnectionTarget({ environmentId, label: "Box", connectionId: "ssh-1" });
    expect(isLocalServerConnection(primary(local), local)).toBe(true);
    expect(
      isLocalServerConnection(primary("https://mac.example.ts.net"), "https://mac.example.ts.net"),
    ).toBe(false);
    // An SSH forward listens on loopback too, but its silence can be a lost network.
    expect(isLocalServerConnection(ssh, local)).toBe(false);
    expect(directRequestTimeout(local, "direct")).toEqual({ timeoutMs: 60_000 });
    expect(directRequestTimeout(local, "ssh")).toEqual({});
    expect(directRequestTimeout("http://192.168.1.10:3773", "direct")).toEqual({});
  });

  it("counts an entry as local only when every route reaches this device", () => {
    const entry: ConnectionCatalogEntry = {
      target: primary(local),
      profile: Option.none(),
      enabled: true,
    };
    const lan = new BearerConnectionProfile({
      connectionId: "lan",
      environmentId,
      label: "Mac",
      httpBaseUrl: "http://192.168.1.10:3773",
      wsBaseUrl: "ws://192.168.1.10:3773",
    });
    expect(isLoopbackEntry(entry)).toBe(true);
    expect(
      isLoopbackEntry({
        ...entry,
        alternateRoutes: [
          {
            target: new BearerConnectionTarget({
              environmentId,
              label: "Mac",
              connectionId: "lan",
            }),
            profile: Option.some(lan),
          },
        ],
      }),
    ).toBe(false);
  });

  it("retries this device's own server within seconds however many attempts failed", () => {
    expect(retryDelayMs(0, 1, true)).toBe(2_000);
    expect(retryDelayMs(100, 1, true)).toBe(5_000);
    expect(retryDelayMs(100, 1)).toBe(300_000);
  });

  // The desktop's own server answered after 18 s mid maintenance pass; 10 s called it offline.
  it.effect("waits out a busy local server for its descriptor where a remote host times out", () =>
    Effect.gen(function* () {
      const silent = (() => new Promise<Response>(() => {})) satisfies typeof fetch;
      const read = (httpBaseUrl: string) =>
        fetchRemoteEnvironmentDescriptor({
          httpBaseUrl,
          ...directRequestTimeout(httpBaseUrl, "direct"),
        }).pipe(
          Effect.provide(RpcHttp.layerRemoteHttpClient(silent)),
          Effect.flip,
          Effect.forkChild,
        );
      const remote = yield* read("https://remote.example.com");
      const own = yield* read(local);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(remote)).toMatchObject({ timeoutMs: 10_000 });
      expect(own.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(own)).toMatchObject({ timeoutMs: 60_000 });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
