import type { HourlyOperation, Limits } from "./AccountLimits.ts";

export interface RateStorage {
  readonly sql: {
    readonly exec: (
      query: string,
      ...values: ReadonlyArray<string | number>
    ) => Iterable<Record<string, unknown>>;
  };
  readonly transactionSync: <A>(body: () => A) => A;
}
const HOUR_MS = 3_600_000;
export function consumeWindow(
  storage: RateStorage,
  operation: HourlyOperation,
  limit: Limits[HourlyOperation],
  nowMs: number,
) {
  return storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS account_rate_closed (id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    if ([...storage.sql.exec("SELECT id FROM account_rate_closed")].length)
      return { allowed: false, retryAfterSeconds: 3600 };
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS account_rate_windows (operation TEXT PRIMARY KEY,window_start_ms INTEGER NOT NULL,used INTEGER NOT NULL)",
    );
    const found = [
      ...storage.sql.exec(
        "SELECT window_start_ms,used FROM account_rate_windows WHERE operation=?",
        operation,
      ),
    ][0];
    if (
      found &&
      (typeof found.window_start_ms !== "number" ||
        !Number.isSafeInteger(found.window_start_ms) ||
        typeof found.used !== "number" ||
        !Number.isSafeInteger(found.used) ||
        found.used < 0)
    )
      throw new Error("Invalid persisted hourly rate window");
    const row =
      found && typeof found.window_start_ms === "number" && typeof found.used === "number"
        ? { window_start_ms: found.window_start_ms, used: found.used }
        : undefined;
    const aligned = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const start = row && row.window_start_ms > aligned ? row.window_start_ms : aligned;
    const used = row && row.window_start_ms === start ? row.used : 0;
    if (used >= limit)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((start + HOUR_MS - nowMs) / 1000)),
      };
    storage.sql.exec(
      "INSERT INTO account_rate_windows(operation,window_start_ms,used) VALUES (?,?,?) ON CONFLICT(operation) DO UPDATE SET window_start_ms=excluded.window_start_ms,used=excluded.used",
      operation,
      start,
      used + 1,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  });
}

export function closeWindows(storage: RateStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS account_rate_closed (id INTEGER PRIMARY KEY CHECK(id=1))",
    );
    storage.sql.exec("INSERT INTO account_rate_closed(id) VALUES(1) ON CONFLICT DO NOTHING");
    storage.sql.exec("DROP TABLE IF EXISTS account_rate_windows");
  });
}
