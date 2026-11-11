// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - reads the ready line of a pen pipe child its caller spawned, with its own deadline.
import type * as NodeChildProcess from "node:child_process";

// The caller side of "pen pipe --node --noise @<service>" (CONTRACT "Exact dial and the ready line").

export const PEN_READY_CAP = 128;
export const PEN_READY_DEADLINE_MS = 25_000;
/** What stays of the child's stderr after the ready line: the last bytes, for error text. */
export const PEN_STDERR_TAIL = 4096;

export type PenReadyFailure = "line" | "stdout" | "exit" | "deadline" | "aborted" | "spawn";

export class PenReadyError extends Error {
  readonly reason: PenReadyFailure;
  constructor(reason: PenReadyFailure, message: string) {
    super(message);
    this.name = "PenReadyError";
    this.reason = reason;
  }
}

export interface PenReady {
  /** The child's stderr after the ready line, at most PEN_STDERR_TAIL bytes, latest last. */
  stderrTail(): string;
}

export interface PenReadyExpected {
  readonly nodeId: string;
  readonly noisePub: string;
}

export interface PenReadyOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

function exited(child: NodeChildProcess.ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Resolves once the child printed exactly "pen-ready v1 <nodeId> <noisePub>" on stderr. Until then it
 * reads stderr with a 128-byte cap, refuses any stdout byte, and writes nothing to stdin. On any failure it
 * kills the child and rejects only after the child has exited. On success stdout is left paused with its
 * data unread, for the caller to resume, and stderr keeps draining into a bounded tail.
 */
export function awaitPenReady(
  child: NodeChildProcess.ChildProcess,
  expected: PenReadyExpected,
  options: PenReadyOptions = {},
): Promise<PenReady> {
  const want = "pen-ready v1 " + expected.nodeId + " " + expected.noisePub;
  const { stdout, stderr } = child;
  return new Promise<PenReady>((resolve, reject) => {
    if (stdout === null || stderr === null) {
      reject(new PenReadyError("spawn", "the child needs piped stdout and stderr"));
      return;
    }
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let accepted = false;
    let settled = false;

    const keepTail = (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.byteLength > PEN_STDERR_TAIL)
        tail = tail.subarray(tail.byteLength - PEN_STDERR_TAIL);
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stdout.removeListener("readable", onStdout);
      stderr.removeListener("end", onEarlyEnd);
      child.removeListener("exit", onEarlyEnd);
      child.removeListener("error", onSpawnError);
    };
    const fail = (reason: PenReadyFailure, message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.destroy();
      const done = () => reject(new PenReadyError(reason, message));
      if (child.pid === undefined || exited(child)) {
        done();
        return;
      }
      child.once("exit", done);
      child.kill("SIGKILL");
    };
    const onStderr = (chunk: Buffer) => {
      if (accepted) {
        keepTail(chunk);
        return;
      }
      if (settled) return;
      head = Buffer.concat([head, chunk]);
      const lf = head.indexOf(10);
      if (lf < 0) {
        if (head.byteLength >= PEN_READY_CAP)
          fail("line", "the child's first stderr line is over " + PEN_READY_CAP + " bytes");
        return;
      }
      if (lf + 1 > PEN_READY_CAP || head.subarray(0, lf).toString("latin1") !== want) {
        fail("line", "the child's first stderr line is not the ready line for " + expected.nodeId);
        return;
      }
      // A stdout byte that arrived before this point was written before the line was accepted.
      if (stdout.readableLength > 0) {
        fail("stdout", "the child wrote to stdout before its ready line");
        return;
      }
      accepted = true;
      settled = true;
      cleanup();
      keepTail(head.subarray(lf + 1));
      head = Buffer.alloc(0);
      resolve({ stderrTail: () => tail.toString("utf8") });
    };
    const onStdout = () => {
      if (stdout.readableLength > 0)
        fail("stdout", "the child wrote to stdout before its ready line");
    };
    const onEarlyEnd = () => fail("exit", "the child ended before its ready line");
    const onSpawnError = (error: Error) =>
      fail("spawn", "the child did not start: " + error.message);
    const onAbort = () => fail("aborted", "the caller gave up before the ready line");
    const timer = setTimeout(
      () =>
        fail(
          "deadline",
          "no ready line within " + (options.deadlineMs ?? PEN_READY_DEADLINE_MS) + " ms",
        ),
      options.deadlineMs ?? PEN_READY_DEADLINE_MS,
    );

    stdout.pause();
    stdout.on("readable", onStdout);
    stderr.on("data", onStderr);
    stderr.once("end", onEarlyEnd);
    child.once("exit", onEarlyEnd);
    child.once("error", onSpawnError);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
