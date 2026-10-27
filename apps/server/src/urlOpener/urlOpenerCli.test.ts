import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { describe, expect, it } from "vite-plus/test";

import { runUrlOpener, URL_OPENER_FALLBACK_ENV, type UrlOpenerIo } from "./urlOpenerCli.ts";

const SHIM = "/tmp/goat-threads-fixture/goat-browser";
const THREAD_ENV = {
  PATH: "/usr/bin",
  BROWSER: SHIM,
  GOAT_ACP_MCP_ENDPOINT: "http://127.0.0.1:43123/mcp",
  GOAT_ACP_MCP_AUTHORIZATION: "Bearer thread-token",
  T3_ACP_MCP_AUTHORIZATION: "Bearer thread-token", // goat-rename: legacy
};
const opened: AgentSurfaceResult = {
  status: "ok",
  value: { available: true, visible: true, tabId: "tab-7", url: null, title: null, loading: true },
};

/** One shell's opener: what reached GOAT's preview and what reached the system browser. */
const harness = (preview: AgentSurfaceResult, env: Record<string, string> = THREAD_ENV) => {
  const previewCalls: Array<{ url: string; authorization: string }> = [];
  const systemCalls: Array<{ url: string; env: Readonly<Record<string, string | undefined>> }> = [];
  const out: Array<string> = [];
  const err: Array<string> = [];
  const io: UrlOpenerIo = {
    env,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    openInPreview: async (url, credential) => {
      previewCalls.push({ url, authorization: credential.authorization });
      return preview;
    },
    openWithSystem: async (url, systemEnv) => {
      systemCalls.push({ url, env: systemEnv });
      return true;
    },
  };
  return {
    io,
    previewCalls,
    systemCalls,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
};

describe("GOAT's BROWSER for a thread", () => {
  it("opens a web URL in the thread's own preview and returns the tab handle", async () => {
    const shell = harness(opened);
    const code = await runUrlOpener(["http://localhost:5173/?a=1&b=2"], shell.io);

    expect(code).toBe(0);
    expect(shell.previewCalls).toEqual([
      { url: "http://localhost:5173/?a=1&b=2", authorization: "Bearer thread-token" },
    ]);
    expect(shell.stdout()).toContain("tab tab-7");
    expect(shell.systemCalls).toEqual([]);
  });

  it("refuses once the thread's session has ended, without falling back to the system browser", async () => {
    const shell = harness({
      status: "error",
      error: {
        code: "unauthenticated",
        reason: "credential_refused",
        message: "The credential was revoked.",
        retryable: false,
      },
    });
    const code = await runUrlOpener(["https://example.com/"], shell.io);

    // Exit 0 keeps callers such as Python's webbrowser from trying another browser themselves.
    expect(code).toBe(0);
    expect(shell.systemCalls).toEqual([]);
    expect(shell.stderr()).toContain("did not open");
  });

  it("hands what the preview cannot open to the system browser, without BROWSER or the thread credential", async () => {
    for (const url of [
      "file:///home/user/report.html",
      "mailto:someone@example.com",
      "https://user:secret@example.com/",
      `https://example.com/${"a".repeat(3_000)}`,
    ]) {
      const shell = harness(opened);
      expect(await runUrlOpener([url], shell.io), url).toBe(0);
      expect(shell.previewCalls, url).toEqual([]);
      expect(shell.systemCalls.map((call) => call.url)).toEqual([url]);
      expect(shell.systemCalls[0]?.env).toEqual({
        PATH: "/usr/bin",
        [URL_OPENER_FALLBACK_ENV]: "1",
      });
    }
  });

  it("uses the system browser when the thread's preview is not available", async () => {
    const shell = harness({
      status: "error",
      error: {
        code: "unavailable",
        reason: "unreachable",
        message: "connect ECONNREFUSED",
        retryable: true,
      },
    });
    expect(await runUrlOpener(["https://example.com/"], shell.io)).toBe(0);
    expect(shell.systemCalls.map((call) => call.url)).toEqual(["https://example.com/"]);
  });

  it("ends after one hop when the system opener leads back to GOAT's opener", async () => {
    const shell = harness({
      status: "error",
      error: { code: "unavailable", reason: "unreachable", message: "down", retryable: true },
    });
    let runs = 0;
    // A system default browser configured as GOAT's shim, which then runs it again.
    const loopingIo: UrlOpenerIo = {
      ...shell.io,
      openWithSystem: async (url, env) => {
        runs += 1;
        return (await runUrlOpener([url], { ...loopingIo, env: { ...env, BROWSER: SHIM } })) === 0;
      },
    };
    expect(await runUrlOpener(["https://example.com/"], loopingIo)).toBe(1);
    expect(runs).toBe(1);
  });
});
