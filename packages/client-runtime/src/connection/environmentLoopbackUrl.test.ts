import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import { resolveEnvironmentLoopbackUrl } from "./environmentLoopbackUrl.ts";
import {
  BearerConnectionTarget,
  type ConnectionTarget,
  HubProxyConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";

const environmentId = EnvironmentId.make("environment-1");
const base = { environmentId, label: "Build box" };
const bearer = new BearerConnectionTarget({ ...base, connectionId: "saved:box" });
const primary = (httpBaseUrl: string) =>
  new PrimaryConnectionTarget({ ...base, httpBaseUrl, wsBaseUrl: httpBaseUrl });

const resolve = (
  url: string,
  target: ConnectionTarget | null,
  httpBaseUrl = "",
  isDesktopRenderer = false,
) =>
  resolveEnvironmentLoopbackUrl({
    url,
    connection: target === null ? null : { target, httpBaseUrl },
    isDesktopRenderer,
  });

describe("resolveEnvironmentLoopbackUrl", () => {
  it("maps a remote environment's loopback address onto its LAN or tailnet host", () => {
    expect(
      resolve("http://localhost:5173/app?mode=dev#top", bearer, "http://192.168.1.25:3773"),
    ).toEqual({ _tag: "Open", url: "http://192.168.1.25:5173/app?mode=dev#top" });
    expect(
      resolve(
        "http://user:p%40ss@127.0.0.1:3000/",
        primary("http://100.65.180.100:3773"),
        "http://100.65.180.100:3773",
      ),
    ).toEqual({ _tag: "Open", url: "http://user:p%40ss@100.65.180.100:3000/" });
    expect(resolve("http://[::1]:8080/", bearer, "http://[fd7a:115c:a1e0::1]:3773")).toEqual({
      _tag: "Open",
      url: "http://[fd7a:115c:a1e0::1]:8080/",
    });
  });

  it("treats every loopback spelling as the environment's own machine", () => {
    for (const url of [
      "http://127.0.0.2:5173/",
      "http://0.0.0.0:5173/",
      "http://[::]:5173/",
      "http://[::ffff:127.0.0.1]:5173/",
      "http://localhost.:5173/",
      "http://app.localhost:5173/",
    ]) {
      const resolved = resolve(url, bearer, "http://192.168.1.25:3773");
      expect(resolved._tag === "Open" && new URL(resolved.url).hostname).toBe("192.168.1.25");
    }
  });

  it("refuses with a reason when this device only reaches GOAT through a forward, hub or relay", () => {
    for (const [target, httpBaseUrl] of [
      [new SshConnectionTarget({ ...base, connectionId: "ssh:box" }), "http://127.0.0.1:41234"],
      [
        new HubProxyConnectionTarget({ ...base, connectionId: "hub:a:b" }),
        "http://192.168.1.2:3773/hub/b",
      ],
      [new RelayConnectionTarget(base), "https://relay.example.com"],
      [bearer, "https://box.example.com"],
    ] as const) {
      const resolved = resolve("http://localhost:5173/", target, httpBaseUrl);
      expect(resolved._tag).toBe("Unreachable");
      expect(resolved._tag === "Unreachable" && resolved.reason).toContain("localhost:5173");
    }
    expect(resolve("http://localhost:5173/", null)._tag).toBe("Unreachable");
  });

  it("keeps the exact address for environments on this device", () => {
    const url = "http://0.0.0.0:5173/app";
    expect(
      resolve(url, primary("http://192.168.1.25:3773"), "http://192.168.1.25:3773", true),
    ).toEqual({ _tag: "Open", url });
    expect(
      resolve(
        url,
        new BearerConnectionTarget({ ...base, connectionId: "local:wsl:Ubuntu" }),
        "http://172.24.66.27:3773",
        true,
      ),
    ).toEqual({ _tag: "Open", url });
    expect(resolve(url, primary("http://localhost:3773"), "http://localhost:3773")).toEqual({
      _tag: "Open",
      url,
    });
    expect(resolve(url, bearer, "http://127.0.0.1:3773")).toEqual({ _tag: "Open", url });
    expect(resolve(url, bearer, "http://goat.localhost:3773")).toEqual({ _tag: "Open", url });
    expect(resolve(url, bearer, "http://0.0.0.0:3773")).toEqual({ _tag: "Open", url });
  });

  it("leaves addresses that are not loopback web URLs unchanged", () => {
    for (const url of [
      "https://github.com/goat-si/goat",
      "http://192.168.1.9:5173",
      "mailto:a@b.c",
      "not a url",
    ]) {
      expect(
        resolve(
          url,
          new SshConnectionTarget({ ...base, connectionId: "ssh:box" }),
          "http://127.0.0.1:41234",
        ),
      ).toEqual({ _tag: "Open", url });
    }
  });
});
