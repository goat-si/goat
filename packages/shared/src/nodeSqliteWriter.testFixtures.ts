import type * as NodeWorkerThreads from "node:worker_threads";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

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
