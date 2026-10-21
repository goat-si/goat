import * as Effect from "effect/Effect";
import { assert } from "@effect/vitest";
import { ChildProcess } from "effect/process";
import type { makeProtocolFixture } from "./tunnel.protocol.fixture.ts";

/** The stop script still checks ownership and sends SIGTERM; only its fixture signal waits for exit. */
export const synchronizeProtocolStop = Effect.fn("test.protocol.stopBarrier")(function* (
  fixture: Effect.Success<ReturnType<typeof makeProtocolFixture>>,
) {
  const controller = `${fixture.test}/stop-signal.cjs`;
  yield* fixture.fs.writeFileString(
    controller,
    `const fs = require("node:fs");
const net = require("node:net");
const pid = Number(process.argv[2]);
const observe = process.argv[3] === "observe";
const port = Number(fs.readFileSync(process.env.HOME + "/.test/stop-port-" + pid, "utf8"));
const socket = net.connect(port, "127.0.0.1");
let pending = "";
let stopping = false;
socket.on("error", error => { throw error; });
socket.on("data", data => {
  pending += data;
  let at;
  while ((at = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, at);
    pending = pending.slice(at + 1);
    if (line === "ready") {
      if (observe) socket.write("observe\\n");
      else process.kill(pid, "SIGTERM");
    } else if (line === "stopping") {
      stopping = true;
      if (observe) socket.end();
      else socket.write("exit\\n");
    } else throw new Error("Unexpected stop milestone: " + line);
  }
});
socket.on("end", () => {
  if (!stopping) throw new Error("Fixture exited before acknowledging SIGTERM");
  if (!observe) fs.appendFileSync(process.env.HOME + "/.test/stop-exits", pid + "\\n");
});

`,
  );
  // kill -0 and all ownership probes stay real. Only the single-PID signal uses the controller.
  fixture.setScriptPrefix(`kill() {
  if [ "$#" = 1 ] && [ "$1" -gt 0 ] 2>/dev/null; then
    '${process.execPath.replaceAll("'", "'\\''")}' "$HOME/.test/stop-signal.cjs" "$1"
  else
    command kill "$@"
  fi
}
`);
});

export const awaitProtocolStop = Effect.fn("test.protocol.awaitStop")(function* (
  fixture: Effect.Success<ReturnType<typeof makeProtocolFixture>>,
) {
  const observer = yield* fixture.realSpawner.spawn(
    ChildProcess.make(
      process.execPath,
      [`${fixture.test}/stop-signal.cjs`, String(fixture.pid), "observe"],
      { env: { HOME: fixture.home } },
    ),
  );
  assert.equal(yield* observer.exitCode, 0);
});
