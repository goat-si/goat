// @effect-diagnostics nodeBuiltinImport:off -- Desktop owns this local child transport.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import type { PenSnapshotStream } from "@goat/pen-protocol/snapshot";
import { guardChild, guardErrors } from "@goat/shared/errorGuards";

export function openPenSnapshotChild(input: {
  readonly stateDir: string;
  readonly resolveBinary: () => Promise<string | undefined>;
  readonly spawn: (
    path: string,
    args: readonly string[],
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
}): PenSnapshotStream {
  let destroyed = false;
  let ended = false;
  let exited = false;
  let answered = false;
  let child: NodeChildProcess.ChildProcess | undefined;
  // The watch observes errors; this listener also contains errors after teardown.
  const emitter = guardErrors(new NodeEvents.EventEmitter(), () => {});
  const fail = (error: Error) => {
    if (destroyed || ended) return;
    ended = true;
    emitter.emit("error", error);
    if (!destroyed) emitter.emit("close");
  };
  const stream = Object.assign(emitter, {
    write: (_data: string) => {},
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      child?.stdin?.end();
      if (child && !exited && child.exitCode === null && child.signalCode === null) child.kill();
    },
  });
  void Promise.resolve()
    .then(input.resolveBinary)
    .then((binary) => {
      if (destroyed) return;
      if (!binary || !NodePath.isAbsolute(binary)) throw new Error("no Pen binary");
      child = guardChild(
        input.spawn(binary, ["ls", "--watch", "--snapshot", "--until-stdin-closes"], {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, PEN_HOME: input.stateDir },
        }),
        fail,
      );
      if (!child.stdin || !child.stdout) throw new Error("Pen snapshot child missing stdio");
      child.on("spawn", () => {
        if (!destroyed && !ended) emitter.emit("connect");
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (destroyed || ended) return;
        answered = true;
        emitter.emit("data", chunk);
      });
      child.on("exit", () => {
        exited = true;
      });
      child.on("close", () => {
        exited = true;
        if (destroyed || ended) return;
        // pen prints nothing when no daemon answers: that is the socket's failed connect.
        if (!answered) return fail(new Error("pen printed no snapshot"));
        ended = true;
        emitter.emit("close");
      });
    })
    .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  return stream;
}
