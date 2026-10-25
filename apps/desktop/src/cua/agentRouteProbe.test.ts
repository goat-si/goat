// @effect-diagnostics nodeBuiltinImport:off -- Writes stand-in helper scripts for a real subprocess probe.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { agentRouteFailure, probeAgentRoute } from "./agentRouteProbe.ts";

/** A stand-in helper run by this Node: answers the handshake, refuses its parent, or crashes. */
function standIn(body: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-agent-route-"));
  const script = NodePath.join(dir, "helper.cjs");
  NodeFS.writeFileSync(script, body);
  return {
    target: { command: process.execPath, args: [script, "--mcp"], environment: [] },
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

const ANSWERS = `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  const line = buf.split("\\n")[0];
  if (!buf.includes("\\n")) return;
  const { id } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { capabilities: {} } }) + "\\n");
});
`;

describe("agent route probe (real subprocesses)", () => {
  it.live("reports a helper that answers the handshake under the agents' parent", () =>
    Effect.promise(async () => {
      using helper = standIn(ANSWERS);
      assert.deepEqual(await probeAgentRoute(helper.target), { kind: "answered" });
    }),
  );

  it.live("reports a helper that refuses its parent with exit 77 and its reason", () =>
    Effect.promise(async () => {
      using helper = standIn(
        `process.stderr.write("GOAT Computer Use: not signed by GOAT's team\\n"); process.exit(77);`,
      );
      const outcome = await probeAgentRoute(helper.target);
      assert.equal(outcome.kind, "refused");
      assert.match(
        agentRouteFailure(outcome, "GOAT Computer Use") ?? "",
        /refused the process GOAT starts it from for agents.*not signed by GOAT's team/,
      );
    }),
  );

  it.live("reports a helper that dies before answering, as the capture crash did", () =>
    Effect.promise(async () => {
      using helper = standIn(`process.exit(134);`);
      assert.deepEqual(await probeAgentRoute(helper.target), {
        kind: "failed",
        reason: "exited before answering (code 134)",
      });
    }),
  );
});
