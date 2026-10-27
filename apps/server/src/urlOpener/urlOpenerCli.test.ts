import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import { describe, expect, it } from "vite-plus/test";

import {
  callThread,
  runUrlOpener,
  URL_OPENER_FALLBACK_ENV,
  type UrlOpenerIo,
} from "./urlOpenerCli.ts";

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
const revoked: AgentSurfaceResult = {
  status: "error",
  error: {
    code: "unauthenticated",
    reason: "credential_refused",
    message: "The credential was revoked.",
    retryable: false,
  },
};

/** One shell's opener: what reached GOAT's preview and what reached the system browser. */
const harness = (
  preview: AgentSurfaceResult,
  env: Record<string, string> = THREAD_ENV,
  thread: AgentSurfaceResult = { status: "ok", value: {} },
) => {
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
    checkThread: async () => thread,
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

  it("refuses every URL once the thread's session has ended, without falling back to the system browser", async () => {
    for (const url of ["https://example.com/", "file:///home/user/report.html"]) {
      const shell = harness(revoked, THREAD_ENV, revoked);
      // Exit 0 keeps callers such as Python's webbrowser from trying another browser themselves.
      expect(await runUrlOpener([url], shell.io), url).toBe(0);
      expect(shell.systemCalls, url).toEqual([]);
      expect(shell.stderr(), url).toContain("did not open");
    }
    // Markers GOAT blanked or broke are no reason to open anything either.
    const blank = harness(opened, { ...THREAD_ENV, GOAT_ACP_MCP_AUTHORIZATION: "" });
    expect(await runUrlOpener(["mailto:someone@example.com"], blank.io)).toBe(0);
    expect([...blank.previewCalls, ...blank.systemCalls]).toEqual([]);
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

describe("the preview call's deadline", () => {
  it("ends a stalled tool call and a stalled session cleanup as an unknown outcome", async () => {
    const deadline = new AbortController();
    const requests: Array<string> = [];
    const { promise: toolCallSent, resolve: markToolCallSent } = Promise.withResolvers<void>();
    // A server that never answers: only the request's abort signal ends the wait.
    const stall = (signal: AbortSignal | null | undefined) =>
      new Promise<Response>((_, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const fetchImplementation = async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        requests.push("DELETE");
        return stall(init.signal);
      }
      const message = JSON.parse(String(init?.body)) as { method: string; id?: string };
      requests.push(message.method);
      if (message.method === "initialize")
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
          { headers: { "mcp-session-id": "session-1" } },
        );
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      markToolCallSent();
      return stall(init?.signal);
    };

    const pending = callThread(
      { path: "preview.open", args: { url: "https://example.com/" }, effect: "destructive" },
      { endpoint: "http://127.0.0.1:43123/mcp", authorization: "Bearer thread-token" },
      deadline.signal,
      fetchImplementation,
    );
    await toolCallSent;
    deadline.abort();

    expect(await pending).toMatchObject({ status: "error", error: { code: "unknown_outcome" } });
    expect(requests).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
  });
});
