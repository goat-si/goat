// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- The eval worker runs independently of Effect and the server loop.
import * as NodeWorkerThreads from "node:worker_threads";
import { makeLoopObserver } from "@goat/shared/managedRecoveryPolicy";
import type { DesktopBackendHealth, ManagedWatchdogBootstrap } from "@goat/contracts";

type Phase = DesktopBackendHealth["phase"];
const phases: ReadonlyArray<Phase> = ["starting", "migrating", "recovering", "ready", "stopping"];
export const makeMailbox = () => new Int32Array(new SharedArrayBuffer(24));
export function publishMailbox(mailbox: Int32Array, phase: Phase): boolean {
  if (Atomics.load(mailbox, 4) !== 0) return false;
  const sequence = Atomics.load(mailbox, 1);
  if (sequence >= 2_147_483_646) {
    Atomics.store(mailbox, 4, 1);
    return false;
  }
  Atomics.add(mailbox, 0, 1);
  Atomics.store(mailbox, 1, sequence + 1);
  Atomics.store(mailbox, 2, phases.indexOf(phase));
  if (phase === "ready") Atomics.store(mailbox, 3, 1);
  Atomics.add(mailbox, 0, 1);
  return Atomics.load(mailbox, 4) === 0;
}
export function readMailbox(mailbox: Int32Array) {
  const phaseLabels = ["starting", "migrating", "recovering", "ready", "stopping"] as const;
  for (let attempt = 0; attempt < 2; attempt++) {
    const version = Atomics.load(mailbox, 0);
    if (version % 2 !== 0) continue;
    const sequence = Atomics.load(mailbox, 1);
    const phase = phaseLabels[Atomics.load(mailbox, 2)] ?? "starting";
    const ready = Atomics.load(mailbox, 3) === 1;
    if (version === Atomics.load(mailbox, 0))
      return { sequence, phase, ready, stopping: phase === "stopping" };
  }
  return undefined;
}

// Embedded with its dependencies so bundles and SEA never resolve a worker file.
function workerMain(
  makeLoopObserver: typeof import("@goat/shared/managedRecoveryPolicy").makeLoopObserver,
  readMailbox: typeof import("./LoopWatchdogWorker.ts").readMailbox,
) {
  const { workerData, parentPort } =
    require("node:worker_threads") as typeof import("node:worker_threads");
  const fs = require("node:fs") as typeof import("node:fs");
  const data = workerData as {
    mailbox: SharedArrayBuffer;
    generation: string;
    pid: number;
    healthFd?: number;
  };
  const mailbox = new Int32Array(data.mailbox);
  const observer = makeLoopObserver(performance.now());
  let sequence = 0;
  let writing = false;
  let pending: Buffer | undefined;
  let terminal = false;
  let failed = false;
  let snapshot = {
    sequence: 0,
    phase: "starting" as DesktopBackendHealth["phase"],
    ready: false,
    stopping: false,
  };
  const write = (frame: Buffer) => {
    if (data.healthFd === undefined || failed) return;
    if (writing) {
      pending = frame;
      return;
    }
    writing = true;
    let offset = 0;
    const next = () => {
      fs.write(data.healthFd ?? -1, frame, offset, frame.length - offset, null, (error, count) => {
        if (error || count <= 0) {
          failed = true;
          writing = false;
          pending = undefined;
          return;
        }
        offset += count;
        if (offset < frame.length) {
          next();
          return;
        }
        writing = false;
        const latest = pending;
        pending = undefined;
        if (latest) write(latest);
      });
    };
    next();
  };
  setInterval(() => {
    if (terminal) return;
    snapshot = readMailbox(mailbox) ?? snapshot;
    const verdict = observer.sample(
      performance.now(),
      snapshot.sequence,
      snapshot.ready,
      snapshot.stopping,
    );
    if (verdict === "stopping") return;
    if (verdict === "main-silent" || Atomics.load(mailbox, 4) !== 0) {
      terminal = true;
      Atomics.store(mailbox, 4, 1);
      // A worker's process.exit only exits the worker; kill the captured process instead.
      setTimeout(() => process.kill(data.pid, "SIGKILL"), 5_000);
    }
    sequence++;
    const frame = Buffer.from(
      `{"version":1,"type":"backendHealth","generation":"${data.generation}","observerSequence":${sequence},"mainSequence":${snapshot.sequence},"phase":"${snapshot.phase}","verdict":"${terminal ? "main-silent" : "healthy"}"}\n`,
    );
    write(frame);
  }, 2_000);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is a Node worker MessagePort.
  parentPort?.postMessage("installed");
}

export function startLoopWatchdog(bootstrap: ManagedWatchdogBootstrap, mailbox: Int32Array) {
  const source = loopWatchdogWorkerSource();
  return new NodeWorkerThreads.Worker(source, {
    eval: true,
    // The embedded source is CommonJS; launch flags such as --input-type=module must not leak in.
    execArgv: [],
    workerData: {
      mailbox: mailbox.buffer,
      generation: bootstrap.generation,
      pid: process.pid,
      ...(bootstrap.mode === "fd" ? { healthFd: bootstrap.healthFd } : {}),
    },
  });
}

export const loopWatchdogWorkerSource = () =>
  `(${workerMain.toString()})(${makeLoopObserver.toString()}, ${readMailbox.toString()});`;
