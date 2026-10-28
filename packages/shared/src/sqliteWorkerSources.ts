// Inline worker source also runs in bundles and single-executable builds without module files.
export const readerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
const initialize = () => {
let next;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  next = new DatabaseSync(workerData.filename, {
    readOnly: true,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  if (next) next.close();
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error), errcode: error && error.errcode });
}
};
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", (request) => {
  if (request.type === "initialize") return initialize();
  const { id, sql, params, cached, values, raw, safeIntegers } = request;
  let operation = "open";
  let started = performance.now();
  let prepareMs;
  let nativeMs;
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    prepareMs = performance.now() - started;
    operation = "execute";
    started = performance.now();
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      const rows = statement.all(...params);
      nativeMs = performance.now() - started;
      parentPort.postMessage({ id, rows, prepareMs, nativeMs });
    } else {
      const result = statement.run(...params);
      nativeMs = performance.now() - started;
      parentPort.postMessage({ id, rows: raw ? result : [], prepareMs, nativeMs });
    }
  } catch (error) {
    if (operation === "prepare") prepareMs = performance.now() - started;
    if (operation === "execute" && nativeMs === undefined) nativeMs = performance.now() - started;
    parentPort.postMessage({
      id,
      prepareMs,
      nativeMs,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

// Evaluated source also works in bundles and single-executable builds.
export const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { statSync } = require("node:fs");
let db;
let frames;
let checkpoint;
let truncate;
let journalSizeLimit = -1;
let generation = 0;
let nextTruncateId = 0;
let pendingTruncate;
let pendingBarriers = 0;
let idle;
const initialize = () => {
  if (db !== undefined) return;
  // The writer switches to WAL after constructing the client.
  db = new DatabaseSync(workerData.filename);
  db.exec("PRAGMA busy_timeout = 5000;");
  const mode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  // macOS requires F_FULLFSYNC to flush the drive cache.
  db.exec("PRAGMA checkpoint_fullfsync = ON;");
  frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
  checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
  truncate = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
};
const atCeiling = (state) => state.log >= workerData.backpressureFrames;
const exceedsSizeLimit = () =>
  journalSizeLimit >= 0 && statSync(workerData.filename + "-wal").size > journalSizeLimit;
const schedule = (state, blocked) => {
  if (blocked || state.log - state.checkpointed >= workerData.frames) {
    idle = setTimeout(() => checkSafely(undefined, undefined, true), workerData.idleMs);
  }
};
const check = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  initialize();
  if (Number.isSafeInteger(nextGeneration)) generation = Math.max(generation, nextGeneration);
  if (Number.isSafeInteger(nextJournalSizeLimit)) journalSizeLimit = nextJournalSizeLimit;
  let state = frames.get();
  const oversized = exceedsSizeLimit();
  if (force || state.log - state.checkpointed >= workerData.frames || oversized) {
    checkpoint.get();
    state = frames.get();
  }
  if (state.checkpointed === state.log && (atCeiling(state) || oversized)) {
    pendingTruncate = { truncateId: ++nextTruncateId, checkId: id, generation, state };
    parentPort.postMessage({
      type: "truncate-request",
      truncateId: pendingTruncate.truncateId,
      checkId: id,
      generation,
      ...state,
    });
    return;
  }
  const blocked = (atCeiling(state) || oversized) && state.checkpointed < state.log;
  parentPort.postMessage({ type: "checkpoint", id, generation, ...state, blocked });
  schedule(state, blocked);
};
const checkSafely = (id, nextJournalSizeLimit, force, nextGeneration = generation) => {
  try {
    check(id, nextJournalSizeLimit, force, nextGeneration);
  } catch (error) {
    if (!error || (error.errcode & 0xff) !== 5) throw error;
    // Retire the request conservatively, then recheck once the other connection releases its lock.
    parentPort.postMessage({ type: "checkpoint", id, generation: nextGeneration, log: workerData.backpressureFrames, checkpointed: 0, blocked: true });
    idle = setTimeout(() => checkSafely(undefined, undefined, true, nextGeneration), workerData.idleMs);
  }
};
const finishTruncate = (truncateId) => {
  if (pendingTruncate === undefined || pendingTruncate.truncateId !== truncateId) return;
  const pending = pendingTruncate;
  parentPort.postMessage({ type: "truncate-start", truncateId });
  let busy;
  // Admission is paused here; a pinned reader must not make truncation wait.
  db.exec("PRAGMA busy_timeout = 0;");
  try {
    try {
      busy = truncate.get().busy !== 0;
    } catch (error) {
      if (!error || (error.errcode & 0xff) !== 5) throw error;
      busy = true;
    }
  } finally {
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  const state = frames.get();
  const blocked = (atCeiling(state) && (busy || state.checkpointed < state.log)) || exceedsSizeLimit();
  pendingTruncate = undefined;
  parentPort.postMessage({
    type: "checkpoint",
    id: pending.checkId,
    generation: pending.generation,
    truncateId,
    ...state,
    blocked,
  });
  while (pendingBarriers > 0) {
    pendingBarriers--;
    parentPort.postMessage("barrier");
  }
  schedule(state, blocked);
};
const finishTruncateSafely = (truncateId) => {
  try {
    finishTruncate(truncateId);
  } catch (error) {
    if (!error || (error.errcode & 0xff) !== 5) throw error;
    idle = setTimeout(() => finishTruncateSafely(truncateId), workerData.idleMs);
  }
};
parentPort.on("message", (request) => {
  clearTimeout(idle);
  if (request && request.type === "initialize") {
    try {
      initialize();
      parentPort.postMessage({ type: "ready" });
    } catch (error) {
      if (db) db.close();
      db = undefined;
      parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error), errcode: error && error.errcode });
    }
    return;
  }
  if (request && request.type === "truncate") {
    finishTruncateSafely(request.truncateId);
    return;
  }
  const isBarrier = request === "barrier";
  if (pendingTruncate !== undefined) {
    if (isBarrier) pendingBarriers++;
    else if (request && request.type === "check") {
      // Retire the request without labeling the pending snapshot with a newer generation.
      parentPort.postMessage({
        type: "checkpoint",
        id: request.id,
        generation: pendingTruncate.generation,
        ...pendingTruncate.state,
        blocked: true,
      });
    }
    return;
  }
  const input = request && typeof request === "object" ? request : {};
  checkSafely(input.id, input.journalSizeLimit, input.force, input.generation);
  if (isBarrier) {
    if (pendingTruncate !== undefined) pendingBarriers++;
    else parentPort.postMessage("barrier");
  }
});
`;
