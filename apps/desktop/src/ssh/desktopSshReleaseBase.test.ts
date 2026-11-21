import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { resolveDesktopSshCliRunner } from "./desktopSshCliRunner.ts";

it("reads a late shell mirror for each SSH connection and preserves archive options", () => {
  const env: Record<string, string | undefined> = {};
  const config = {
    archiveDirectory: "/cache",
    bundledArchiveDirectory: "/bundle",
    releaseBaseUrl: "https://configured.example/releases",
  };
  const desktop = {
    appVersion: "1.2.3",
    isPackaged: true,
    isDevelopment: false,
    devRemoteGoatServerEntryPath: Option.none<string>(),
  };
  const server = { version: "1.2.3", engines: { node: ">=26" } };
  const messages: Array<{ level: string; message: string }> = [];
  const notify = (level: string, message: string) => messages.push({ level, message });
  const first = resolveDesktopSshCliRunner(desktop, config, server, undefined, env, notify);
  assert.equal(first.releaseBaseUrl, config.releaseBaseUrl);
  env.GOAT_RELEASE_BASE_URL = "https://mirror.example/private";
  const second = resolveDesktopSshCliRunner(desktop, config, server, undefined, env, notify);
  assert.equal(second.releaseBaseUrl, env.GOAT_RELEASE_BASE_URL);
  assert.equal(second.archiveDirectory, "/cache");
  assert.equal(second.bundledArchiveDirectory, "/bundle");
  assert.deepEqual(messages.at(-1), {
    level: "info",
    message: "Using release mirror mirror.example",
  });
  env.GOAT_RELEASE_BASE_URL = "https://user:password@evil.example/path";
  const rejected = resolveDesktopSshCliRunner(desktop, config, server, undefined, env, notify);
  assert.equal(rejected.releaseBaseUrl, config.releaseBaseUrl);
  assert.isTrue(messages.some(({ level }) => level === "warn"));
  assert.notInclude(JSON.stringify(messages), "password");
});

it.each([
  "http://example.com/releases",
  "file:///tmp/releases",
  "https://user:pass@example.com/releases",
  "https://@example.com/releases",
  "https://example.com/path?token=secret",
  "x".repeat(2049),
  "not a URL",
  "",
])("rejects an unsafe shell mirror without logging its value", (value) => {
  const notices: string[] = [];
  const desktop = {
    appVersion: "1.2.3",
    isPackaged: true,
    isDevelopment: false,
    devRemoteGoatServerEntryPath: Option.none<string>(),
  };
  const runner = resolveDesktopSshCliRunner(
    desktop,
    { releaseBaseUrl: "https://configured.example/releases" },
    { version: "1.2.3", engines: { node: ">=26" } },
    undefined,
    { GOAT_RELEASE_BASE_URL: value },
    (_, message) => notices.push(message),
  );
  assert.equal(runner.releaseBaseUrl, "https://configured.example/releases");
  assert.equal(notices.filter((message) => message.includes("invalid")).length, 1);
  if (value) assert.notInclude(JSON.stringify(notices), value);
});

it.each(["http://localhost:1234", "http://127.0.0.1:1234", "http://[::1]:1234"])(
  "allows loopback mirror %s",
  (url) => {
    const desktop = {
      appVersion: "1.2.3",
      isPackaged: true,
      isDevelopment: false,
      devRemoteGoatServerEntryPath: Option.none<string>(),
    };
    const runner = resolveDesktopSshCliRunner(
      desktop,
      {},
      { version: "1.2.3", engines: { node: ">=26" } },
      undefined,
      { GOAT_RELEASE_BASE_URL: url },
    );
    assert.equal(runner.releaseBaseUrl, url);
  },
);
