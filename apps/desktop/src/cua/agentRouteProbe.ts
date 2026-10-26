// @effect-diagnostics nodeBuiltinImport:off -- Starts the helper from GOAT's own Node runtime, as the lease proxy does, and owns that process group.
// @effect-diagnostics globalTimers:off -- The probe's deadline runs outside Effect fibers.
/**
 * Readiness starts the macOS helper the way agents start it: from GOAT's own executable run as
 * Node (resolveSelfInvocationCommand, the lease proxy's command), so the helper's parent check
 * judges the parent agents give it. A readiness check that started the helper from Electron's
 * main process stayed green while every agent connection was refused (exit 77, #1548).
 *
 * @module agentRouteProbe
 */
import * as NodeChildProcess from "node:child_process";

import { resolveSelfInvocationCommand } from "@goat/shared/nodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

/** The helper's exit code when its parent check refuses the launching process (main.swift). */
const UNTRUSTED_PARENT_EXIT = 77;
const ANSWER_WITHIN_MS = 15_000;

export interface AgentRouteCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export type AgentRouteOutcome =
  | { readonly kind: "answered" }
  | { readonly kind: "refused"; readonly exitCode: number; readonly stderr: string }
  | { readonly kind: "failed"; readonly reason: string };

/** The step's failure text, or undefined when the helper answered the MCP handshake. */
export function agentRouteFailure(outcome: AgentRouteOutcome, helperName: string) {
  switch (outcome.kind) {
    case "answered":
      return undefined;
    case "refused":
      return `${helperName} refused the process GOAT starts it from for agents, so agents cannot use computer use. Update GOAT.${outcome.stderr ? ` (${outcome.stderr.trim()})` : ""}`;
    case "failed":
      return `${helperName} did not start the way agents start it: ${outcome.reason}.`;
  }
}

// The child runs this as Node: it starts the helper exactly as the lease proxy does and reports
// how the MCP initialize went on its own stdout.
const PROBE_SCRIPT = `
const cp = require("node:child_process");
const target = JSON.parse(process.env.GOAT_AGENT_ROUTE_TARGET);
const env = { ...process.env };
delete env.GOAT_AGENT_ROUTE_TARGET;
delete env.ELECTRON_RUN_AS_NODE;
for (const v of target.environment) env[v.name] = v.value;
const child = cp.spawn(target.command, target.args, { stdio: ["pipe", "pipe", "pipe"], detached: true, env });
let out = "", err = "", done = false;
const finish = (result) => {
  if (done) return;
  done = true;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  process.stdout.write(JSON.stringify(result) + "\\n");
  process.exit(0);
};
child.on("error", (e) => finish({ kind: "failed", reason: String(e && e.message || e) }));
// A helper that exits at once closes its stdin under the write below; that is its exit's story.
child.stdin.on("error", () => {});
child.stderr.on("data", (d) => { if (err.length < 2000) err += d; });
child.stdout.on("data", (d) => {
  out += d;
  for (const line of out.split("\\n").slice(0, -1)) {
    try { const m = JSON.parse(line); if (m.id === "goat-agent-route") finish(m.result ? { kind: "answered" } : { kind: "failed", reason: "the handshake returned an error" }); } catch {}
  }
});
child.on("exit", (code, signal) => finish(code === ${UNTRUSTED_PARENT_EXIT} ? { kind: "refused", exitCode: code, stderr: err } : { kind: "failed", reason: "exited before answering (" + (code === null ? "signal " + signal : "code " + code) + ")" }));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "goat-agent-route", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "goat-readiness", version: "1" } } }) + "\\n");
`;

/** Runs the helper's MCP handshake under the agents' parent. */
export async function probeAgentRoute(target: AgentRouteCommand): Promise<AgentRouteOutcome> {
  const command = await Effect.runPromise(
    resolveSelfInvocationCommand().pipe(Effect.provide(NodeServices.layer)),
  );
  return new Promise((resolve) => {
    const probe = NodeChildProcess.spawn(command, ["-e", PROBE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        GOAT_AGENT_ROUTE_TARGET: JSON.stringify(target),
      },
    });
    let out = "";
    let settled = false;
    const settle = (outcome: AgentRouteOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // Only the group captured at spawn belongs to this check.
        if (probe.pid !== undefined) process.kill(-probe.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ kind: "failed", reason: "no answer within 15 seconds" }),
      ANSWER_WITHIN_MS,
    );
    timer.unref?.();
    probe.on("error", (error) => settle({ kind: "failed", reason: error.message }));
    probe.stdout.on("data", (chunk) => {
      out += chunk;
      const line = out.split("\n")[0];
      if (!out.includes("\n") || line === undefined) return;
      try {
        settle(JSON.parse(line) as AgentRouteOutcome);
      } catch {
        settle({ kind: "failed", reason: "the check's own process answered unreadably" });
      }
    });
    // "close", not "exit": its answer may still be in the pipe when it exits.
    probe.on("close", (code) =>
      settle({ kind: "failed", reason: `the check's own process exited (code ${code})` }),
    );
  });
}
