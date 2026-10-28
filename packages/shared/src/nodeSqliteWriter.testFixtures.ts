import type * as NodeWorkerThreads from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

export const awaitWorkerExit = (worker: NodeWorkerThreads.Worker) =>
  Effect.callback<void>((resume) => {
    if (worker.threadId === -1) {
      resume(Effect.void);
      return;
    }
    const exit = () => resume(Effect.void);
    worker.once("exit", exit);
    return Effect.sync(() => worker.off("exit", exit));
  });

export const initialCheckpointPrelude = `
(() => {
  const { parentPort } = require("node:worker_threads");
  const sqlite = require("node:sqlite");
  let gate;
  parentPort.on("message", (request) => { if (request.startupGate) gate = request.startupGate; });
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    if (sql === "PRAGMA wal_checkpoint(NOOP)") {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        if (gate) {
          const held = new Int32Array(gate);
          gate = undefined;
          parentPort.postMessage({ type: "checkpoint-held" });
          Atomics.wait(held, 0, 0);
        }
        return get(...args);
      };
    }
    return statement;
  };
})();
`;

export const holdInitialCheckpoint = (worker: NodeWorkerThreads.Worker) => {
  const gate = new SharedArrayBuffer(4);
  const arrived = Deferred.makeUnsafe<void>();
  let retirement: Promise<number> | undefined;
  const listener = (reply: { type?: string }) => {
    if (reply.type === "checkpoint-held") Deferred.doneUnsafe(arrived, Effect.void);
  };
  worker.on("message", listener);
  const post = worker.postMessage.bind(worker);
  const sending = vi.spyOn(worker, "postMessage").mockImplementation((message, ...rest) => {
    post(message?.type === "initialize" ? { ...message, startupGate: gate } : message, ...rest);
  });
  const terminate = worker.terminate.bind(worker);
  const retiring = vi.spyOn(worker, "terminate").mockImplementation(() => {
    retirement = terminate();
    return retirement;
  });
  const release = () => {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
  };
  return {
    arrived,
    release,
    get retirement() {
      return retirement;
    },
    [Symbol.dispose]() {
      release();
      worker.off("message", listener);
      sending.mockRestore();
      retiring.mockRestore();
    },
  };
};

export const recoveryPrelude = (
  point: "initialize" | "prepare" | "execute",
  codes: ReadonlyArray<number>,
  repeat = false,
) => `
(() => {
  const sqlite = require("node:sqlite");
  const { parentPort } = require("node:worker_threads");
  const codes = ${JSON.stringify(codes)};
  let attempts = 0;
  const prototype = ${JSON.stringify(point)} === "execute" ? sqlite.StatementSync.prototype : sqlite.DatabaseSync.prototype;
  const method = ${JSON.stringify(point)} === "execute" ? "all" : "prepare";
  const original = prototype[method];
  prototype[method] = function(...args) {
    const matches = ${JSON.stringify(point)} === "execute" ? this.sourceSQL.includes("recovery_value")
      : ${JSON.stringify(point)} === "prepare" ? args[0].includes("recovery_value")
      : args[0] === "SELECT sqlite_version() AS version";
    if (matches) {
      const code = codes[attempts++] ?? (${repeat} ? codes.at(-1) : undefined);
      if (code !== undefined) throw Object.assign(new Error("injected SQLite failure"), { errcode: code });
    }
    return original.apply(this, args);
  };
})();
`;

export const observeFailures = (worker: NodeWorkerThreads.Worker, count: number) => {
  const milestones = Array.from({ length: count }, () => Deferred.makeUnsafe<void>());
  let attempts = 0;
  const listener = (reply: { error?: { errcode?: number }; type?: string; errcode?: number }) => {
    const code = reply.error?.errcode ?? (reply.type === "unavailable" ? reply.errcode : undefined);
    if (code !== undefined) {
      const milestone = milestones[attempts++];
      if (milestone === undefined) throw new Error("More SQLite failures than expected");
      Deferred.doneUnsafe(milestone, Effect.void);
    }
  };
  worker.on("message", listener);
  return {
    milestones,
    [Symbol.dispose]() {
      worker.off("message", listener);
    },
  };
};
