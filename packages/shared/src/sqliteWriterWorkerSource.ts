// Eval source also runs in bundles and single-executable builds without module files.
export const writerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync, constants } = require("node:sqlite");
const { statSync } = require("node:fs");
const { performance } = require("node:perf_hooks");
let db;
let wal = false;
let unknown = false;
let blocked = false;
let idle;
let nextSequence = 0;
let transactionOwner;
const cache = new Map();
let classification;
const modifyingPragmas = new Set([
  "application_id", "auto_vacuum", "journal_mode", "schema_version", "user_version",
]);
const mutatesPragma = (name, value) => {
  const pragma = name && name.toLowerCase();
  if (pragma === "incremental_vacuum" || pragma === "optimize") return true;
  if (pragma === "wal_checkpoint") return value && value.toLowerCase() !== "noop";
  return value !== null && modifyingPragmas.has(pragma);
};
const errorReply = (id, error, operation, timing = {}) => parentPort.postMessage({
  id, ...timing, error: { operation, message: String(error.message || error),
    code: error.code, errcode: error.errcode, errstr: error.errstr },
});
const initialize = () => {
  if (db) return;
  try {
    db = new DatabaseSync(workerData.filename, {
      readOnly: workerData.readonly, allowExtension: workerData.allowExtension,
    });
    if (typeof db.isTransaction !== "boolean" || typeof db.setAuthorizer !== "function")
      throw new Error("Writer worker requires SQLite authorizer and transaction state");
    if (workerData.checkpoint) {
      const version = String(db.prepare("SELECT sqlite_version() AS version").get().version);
      const [major, minor] = version.split(".").map(Number);
      if (major < 3 || (major === 3 && minor < 51)) throw new Error("Writer requires SQLite NOOP checkpoint");
      db.exec("PRAGMA wal_autocheckpoint = 0;");
      wal = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase() === "wal";
    }
    db.setAuthorizer((code, action, argument) => {
      if (code === constants.SQLITE_PRAGMA && action?.toLowerCase() === "journal_mode" && argument !== null) {
        if (workerData.protectJournal && argument.toLowerCase() !== "wal") return constants.SQLITE_DENY;
        if (classification) classification.journal = true;
      }
      if (!classification) return constants.SQLITE_OK;
      if (code === constants.SQLITE_TRANSACTION) {
        classification.backpressure ||= action === "BEGIN";
        classification.check ||= action === "COMMIT" || action === "ROLLBACK";
      } else if (code === constants.SQLITE_SAVEPOINT) {
        classification.backpressure ||= action === "BEGIN";
        classification.check = true;
      } else if (code === constants.SQLITE_PRAGMA && mutatesPragma(action, argument)) {
        classification.backpressure = true;
        classification.check = true;
      } else if (![constants.SQLITE_READ, constants.SQLITE_SELECT, constants.SQLITE_FUNCTION,
        constants.SQLITE_RECURSIVE, constants.SQLITE_PRAGMA].includes(code)) {
        classification.backpressure = true;
        classification.check = true;
      }
      return constants.SQLITE_OK;
    });
    maintain();
    parentPort.postMessage({ type: "ready" });
  } catch (error) {
    try { if (db) db.close(); } finally { db = undefined; }
    parentPort.postMessage({ type: "unavailable", message: String(error.message || error),
      code: error.code, errcode: error.errcode, errstr: error.errstr });
  }
};
const prepare = (sql, cached) => {
  const now = performance.now();
  let entry = cached ? cache.get(sql) : undefined;
  if (entry && now - entry.at >= workerData.prepareCacheTTL) {
    cache.delete(sql);
    entry = undefined;
  }
  if (!entry) {
    const flags = { backpressure: false, check: false, journal: false };
    classification = flags;
    try { entry = { statement: db.prepare(sql), flags, at: now }; }
    finally { classification = undefined; }
    if (cached && workerData.prepareCacheSize > 0) {
      if (cache.size >= workerData.prepareCacheSize) cache.delete(cache.keys().next().value);
      cache.set(sql, entry);
    }
  } else {
    cache.delete(sql);
    cache.set(sql, entry);
  }
  return entry;
};
const maintain = () => {
  clearTimeout(idle);
  if (!workerData.checkpoint || !db || !wal || db.isTransaction) return;
  try {
    let state = db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
    const limit = Number(db.prepare("PRAGMA journal_size_limit").get().journal_size_limit);
    const oversized = () => limit >= 0 && (statSync(workerData.filename + "-wal", { throwIfNoEntry: false })?.size ?? 0) > limit;
    if (state.log - state.checkpointed >= 1000 || oversized()) {
      db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      state = db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
    }
    if (state.log === state.checkpointed && (state.log >= 10000 || oversized())) {
      const timeout = Number(db.prepare("PRAGMA busy_timeout").get().timeout);
      db.exec("PRAGMA busy_timeout = 0;");
      try { db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); }
      finally { db.exec("PRAGMA busy_timeout = " + timeout); }
      state = db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
    }
    blocked = state.log >= 10000 || oversized();
    if (unknown) parentPort.postMessage({ type: "maintenance-recovered" });
    unknown = false;
    if (blocked || state.log - state.checkpointed >= 1000) idle = setTimeout(maintain, 100);
  } catch {
    if (!unknown) parentPort.postMessage({ type: "maintenance-unavailable" });
    unknown = true;
    idle = setTimeout(maintain, 100);
  }
};
parentPort.on("message", (request) => {
  if (request.type === "initialize") return initialize();
  const { id, sql, params, safeIntegers, values, raw, cached, owner } = request;
  if (!db) return errorReply(id, new Error("Writer unavailable"), "open");
  if (!Number.isSafeInteger(id) || id <= nextSequence)
    return errorReply(id, new Error("Out of order writer request"), "execute");
  nextSequence = id;
  if (request.type === "close") {
    clearTimeout(idle);
    cache.clear();
    try { db.close(); db = undefined; parentPort.postMessage({ id, rows: [] }); }
    catch (error) { errorReply(id, error, "close"); }
    return;
  }
  if (transactionOwner !== undefined && transactionOwner !== owner)
    return errorReply(id, new Error("Writer transaction owner mismatch"), "execute");
  let started = performance.now();
  let prepareMs;
  let nativeMs;
  let completedAtMs;
  let entry;
  let operation = "prepare";
  try {
    entry = prepare(sql, cached);
    prepareMs = performance.now() - started;
    if (entry.flags.backpressure && !db.isTransaction && (unknown || blocked)) {
      maintain();
      if (unknown || blocked) return parentPort.postMessage({ id, backpressure: true });
    }
    operation = "execute";
    started = performance.now();
    classification = entry.flags;
    const statement = entry.statement;
    statement.setReadBigInts(safeIntegers);
    statement.setReturnArrays(values);
    let rows;
    try {
      rows = statement.columns().length > 0 ? statement.all(...params)
        : (raw ? statement.run(...params) : (statement.run(...params), []));
    } finally { statement.setReturnArrays(false); }
    nativeMs = performance.now() - started;
    completedAtMs = Date.now();
    if (db.isTransaction && transactionOwner === undefined) transactionOwner = owner;
    if (!db.isTransaction) transactionOwner = undefined;
    classification = undefined;
    if (entry.flags.journal && workerData.checkpoint)
      wal = String(values ? rows[0]?.[0] : rows[0]?.journal_mode).toLowerCase() === "wal";
    parentPort.postMessage({ id, rows, prepareMs, nativeMs, completedAtMs });
  } catch (error) {
    if (!db.isTransaction) transactionOwner = undefined;
    if (operation === "prepare") prepareMs = performance.now() - started;
    if (operation === "execute" && nativeMs === undefined) nativeMs = performance.now() - started;
    errorReply(id, error, operation, { prepareMs, nativeMs, completedAtMs: completedAtMs ?? Date.now() });
  } finally {
    classification = undefined;
    // OR FAIL may commit rows; checkpoint failure must not replace a committed SQL result.
    if (entry && entry.flags.check && !db.isTransaction) maintain();
  }
});
`;
