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
import type { PenStream } from "../src/client/stream.ts";
import { netStream } from "../src/client/testing/netStream.ts";
import { checkAutobahnReport } from "./autobahnReport.ts";

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
// The case's TCP stream, so a case ends when its connection has closed, not when the client reported close.
let lastStream: PenStream | undefined;
const construct = makePenWebSocketConstructor({
  origin,
  clock,
  random: (n) => new Uint8Array(NodeCrypto.randomBytes(n)),
  openStream: () =>
    new Promise((resolve, reject) => {
      const socket = NodeNet.connect(Number(url.port), url.hostname, () => {
        lastStream = netStream(socket);
        resolve(lastStream);
      });
      socket.once("error", reject);
    }),
});

/** Opens a socket and resolves once it closed and its TCP connection ended; onMessage sees every message. */
async function session(
  path: string,
  onMessage: (socket: PenWebSocketLike, data: unknown) => void,
): Promise<void> {
  lastStream = undefined;
  await new Promise<void>((resolve) => {
    const socket = construct("ws://" + url.host + path);
    socket.addEventListener("message", (event) => onMessage(socket, event.data));
    socket.addEventListener("close", () => resolve());
  });
  await lastStream?.closed;
}

let count = 0;
await session("/getCaseCount", (_socket, data) => {
  count = Number(data);
});
if (!Number.isInteger(count) || count <= 0) throw new Error("the fuzzingserver reported no cases");
// The expected case ids come from the server's own case list, not from the report.
const expectedIds: Array<string> = [];
for (let n = 1; n <= count; n++) {
  await session("/getCaseInfo?case=" + n, (_socket, data) => {
    expectedIds.push((JSON.parse(String(data)) as { id: string }).id);
  });
}
if (expectedIds.length !== count) throw new Error("the fuzzingserver did not describe every case");
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

type Entry = { behavior: string; behaviorClose: string; reportfile?: string };
const index = JSON.parse(
  NodeFS.readFileSync(NodePath.join(reportsDir, "clients", "index.json"), "utf8"),
) as Record<string, Record<string, Entry>>;
const results = index[AGENT] ?? {};
const clientClose = (id: string) => {
  const file = results[id]?.reportfile;
  if (file === undefined) return undefined;
  const detail = JSON.parse(
    NodeFS.readFileSync(NodePath.join(reportsDir, "clients", file), "utf8"),
  ) as {
    remoteCloseCode?: number;
  };
  return detail.remoteCloseCode;
};
const tally = new Map<string, number>();
for (const result of Object.values(results)) {
  const key = result.behavior + "/" + result.behaviorClose;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}
process.stdout.write(
  "autobahn: " +
    Object.keys(results).length +
    " reported; " +
    [...tally].map(([k, v]) => k + " " + v).join(", ") +
    "\n",
);
const problems = checkAutobahnReport(expectedIds, results, clientClose);
if (problems.length > 0) {
  process.stderr.write("autobahn: failing:\n" + problems.join("\n") + "\n");
  process.exit(1);
}
process.stdout.write(
  "autobahn: every expected case passed; 9.3.1-9.3.3 and 9.4.1-9.4.3 ended with the client's 1009 by design; 12.x and 13.x (permessage-deflate) are excluded because the client offers no extension\n",
);
