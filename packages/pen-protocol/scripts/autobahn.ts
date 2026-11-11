// Autobahn testsuite, client mode (design 10.2 exit criterion): our WebSocket adapter echoes every case of a
// fuzzingserver (crossbario/autobahn-testsuite) and the server's report is checked here. Usage:
//   node scripts/autobahn.ts <fuzzingserver ws URL> <reports dir>
// The CI step in goat-ci.yml (test-pen) starts the pinned image and runs this.
// @effect-diagnostics nodeBuiltinImport:off - A standalone script over real sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { makePenWebSocketConstructor, type PenWebSocketLike } from "../src/client/penWebSocket.ts";
import type { Clock } from "../src/client/runtime.ts";
import { netStream } from "../src/client/testing/netStream.ts";

const [serverUrl = "ws://127.0.0.1:9001", reportsDir = "autobahn-reports"] = process.argv.slice(2);
const AGENT = "pen-client";
const url = new URL(serverUrl);
const origin = "http://" + url.host;
const clock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};
const construct = makePenWebSocketConstructor({
  origin,
  clock,
  random: (n) => new Uint8Array(NodeCrypto.randomBytes(n)),
  openStream: () =>
    new Promise((resolve, reject) => {
      const socket = NodeNet.connect(Number(url.port), url.hostname, () =>
        resolve(netStream(socket)),
      );
      socket.once("error", reject);
    }),
});

/** Opens a socket and resolves on close; onMessage sees every message. */
function session(
  path: string,
  onMessage: (socket: PenWebSocketLike, data: unknown) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const socket = construct("ws://" + url.host + path);
    socket.addEventListener("message", (event) => onMessage(socket, event.data));
    socket.addEventListener("close", () => resolve());
  });
}

let count = 0;
await session("/getCaseCount", (_socket, data) => {
  count = Number(data);
});
if (!Number.isInteger(count) || count <= 0) throw new Error("the fuzzingserver reported no cases");
process.stdout.write("autobahn: " + count + " cases\n");
for (let n = 1; n <= count; n++) {
  await session("/runCase?case=" + n + "&agent=" + AGENT, (socket, data) => {
    try {
      socket.send(data as string | Uint8Array);
    } catch {
      // A send refused by the adapter's limits shows up in the case's report.
    }
  });
}
await session("/updateReports?agent=" + AGENT, () => undefined);

const index = JSON.parse(
  NodeFS.readFileSync(NodePath.join(reportsDir, "clients", "index.json"), "utf8"),
) as Record<string, Record<string, { behavior: string; behaviorClose: string }>>;
const results = index[AGENT] ?? {};
const passing = new Set(["OK", "NON-STRICT", "INFORMATIONAL"]);
// Messages of more than 1,024 fragments are refused by design 10.2 with 1009; these cases must end that way.
const refusedByDesign = new Map([
  ["9.3.1", 1009],
  ["9.3.2", 1009],
  ["9.3.3", 1009],
  ["9.4.1", 1009],
  ["9.4.2", 1009],
  ["9.4.3", 1009],
]);
const tally = new Map<string, number>();
const bad: Array<string> = [];
for (const [id, result] of Object.entries(results) as Array<
  [string, { behavior: string; behaviorClose: string; reportfile?: string }]
>) {
  const key = result.behavior + "/" + result.behaviorClose;
  tally.set(key, (tally.get(key) ?? 0) + 1);
  const refusal = refusedByDesign.get(id);
  if (refusal !== undefined) {
    const detail = JSON.parse(
      NodeFS.readFileSync(NodePath.join(reportsDir, "clients", result.reportfile ?? ""), "utf8"),
    ) as {
      localCloseCode?: number;
      remoteCloseCode?: number;
    };
    process.stdout.write(
      "autobahn: " + id + " refused by design, client close " + detail.remoteCloseCode + "\n",
    );
    if (detail.remoteCloseCode !== refusal)
      bad.push(id + " expected a " + refusal + " close from the client");
    continue;
  }
  if (!passing.has(result.behavior) || !passing.has(result.behaviorClose)) bad.push(id + " " + key);
}
process.stdout.write(
  "autobahn: " +
    Object.keys(results).length +
    " reported; " +
    [...tally].map(([k, v]) => k + " " + v).join(", ") +
    "\n",
);
if (Object.keys(results).length !== count) {
  process.stderr.write(
    "autobahn: " + count + " cases ran but " + Object.keys(results).length + " were reported\n",
  );
  process.exit(1);
}
if (bad.length > 0) {
  process.stderr.write("autobahn: failing cases:\n" + bad.join("\n") + "\n");
  process.exit(1);
}
process.stdout.write(
  "autobahn: every case passed (12.x and 13.x, permessage-deflate, are excluded: the client offers no extension)\n",
);
