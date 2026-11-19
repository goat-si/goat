// @effect-diagnostics nodeBuiltinImport:off - a scoped SQLite spool backs the retained usage cache.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { UsageContribution, UsageContributions } from "./usageAggregation.ts";
import { encodeScanCachePages, type CachedFile } from "./usageScanCache.ts";

const DECODED_BYTES = 16 * 1024 * 1024;
const CONTRIBUTION_BYTES = 8 * 1024 * 1024;

type CacheEntry = {
  readonly id: number;
  readonly mtimeMs: number;
  readonly provider: CachedFile["provider"];
  readonly records: number;
  readonly malformedRecords: number;
  ref?: WeakRef<CachedFile>;
};

export class UsageHistoryPages {
  readonly #index = new Map<string, CacheEntry>();
  readonly #decoded = new Map<number, { entry: CachedFile; bytes: number }>();
  #decodedBytes = 0;
  #directory: string | undefined;
  #db: NodeSqlite.DatabaseSync | undefined;
  readonly #statements = new Map<string, NodeSqlite.StatementSync>();
  #nextId = 0;
  #nextScan = 0;
  #snapshots = 0;
  readonly #retired = new Set<number>();

  #database() {
    if (this.#db !== undefined) return this.#db;
    this.#directory ??= NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-usage-pages-"));
    const db = new NodeSqlite.DatabaseSync(NodePath.join(this.#directory, "pages.sqlite"));
    try {
      db.exec(`
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        PRAGMA cache_size = -4096;
        PRAGMA temp_store = FILE;
        CREATE TABLE pages (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE strings (
          section TEXT NOT NULL,
          idx INTEGER NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (section, idx)
        );
        CREATE INDEX strings_by_value ON strings (section, value, idx);
        CREATE TABLE contributions (
          scan INTEGER NOT NULL,
          key TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (scan, key)
        );
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    return db;
  }

  #statement(sql: string) {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#database().prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  close() {
    try {
      this.#db?.close();
    } finally {
      if (this.#directory !== undefined)
        NodeFS.rmSync(this.#directory, { recursive: true, force: true });
    }
  }

  metadata() {
    return this.#index.entries();
  }

  set(path: string, entry: CachedFile, remember = true) {
    const id = ++this.#nextId;
    const payload = JSON.stringify(entry);
    this.#statement("INSERT INTO pages VALUES (?, ?)").run(id, payload);
    const previous = this.#index.get(path);
    this.#index.set(path, {
      id,
      provider: entry.provider,
      mtimeMs: entry.mtimeMs,
      records: entry.records.length + entry.tailRecords.length,
      malformedRecords: entry.malformedRecords,
      ...(remember ? { ref: new WeakRef(entry) } : {}),
    });
    if (previous !== undefined) this.#retire(previous.id);
  }

  #retire(id: number) {
    const decoded = this.#decoded.get(id);
    if (decoded !== undefined) {
      this.#decodedBytes -= decoded.bytes;
      this.#decoded.delete(id);
    }
    if (this.#snapshots > 0) this.#retired.add(id);
    else this.#statement("DELETE FROM pages WHERE id = ?").run(id);
  }

  delete(path: string) {
    const previous = this.#index.get(path);
    if (previous === undefined) return false;
    this.#index.delete(path);
    this.#retire(previous.id);
    return true;
  }

  clear() {
    for (const path of this.#index.keys()) this.delete(path);
  }

  get size() {
    return this.#index.size;
  }

  #read(meta: CacheEntry, keepDecoded: boolean): CachedFile {
    const resident = meta.ref?.deref();
    if (resident !== undefined) return resident;
    const held = this.#decoded.get(meta.id);
    if (held !== undefined) {
      this.#decoded.delete(meta.id);
      this.#decoded.set(meta.id, held);
      return held.entry;
    }
    const row = this.#statement("SELECT payload FROM pages WHERE id = ?").get(meta.id);
    if (typeof row?.payload !== "string") throw new Error("Usage page is missing");
    const entry = JSON.parse(row.payload) as CachedFile;
    if (keepDecoded) {
      const bytes = row.payload.length * 4;
      if (bytes <= DECODED_BYTES) {
        for (const [oldest, value] of this.#decoded) {
          if (this.#decodedBytes + bytes <= DECODED_BYTES) break;
          this.#decoded.delete(oldest);
          this.#decodedBytes -= value.bytes;
        }
        this.#decoded.set(meta.id, { entry, bytes });
        this.#decodedBytes += bytes;
      }
    }
    return entry;
  }

  version(path: string) {
    return this.#index.get(path)?.id;
  }

  get(path: string) {
    const meta = this.#index.get(path);
    return meta === undefined ? undefined : this.#read(meta, true);
  }

  setOrder(paths: readonly string[]) {
    const next = new Map<string, CacheEntry>();
    for (const path of paths) {
      const entry = this.#index.get(path);
      if (entry !== undefined) next.set(path, entry);
    }
    this.#index.clear();
    for (const [path, entry] of next) this.#index.set(path, entry);
  }

  snapshot() {
    const captured = [...this.#index];
    this.#snapshots++;
    const self = this;
    return {
      *entries(keep?: (path: string, meta: CacheEntry) => boolean) {
        for (const [path, meta] of captured) {
          if (keep === undefined || keep(path, meta))
            yield [path, self.#read(meta, keep !== undefined), meta.id] as const;
        }
      },
      release() {
        if (--self.#snapshots !== 0) return;
        for (const id of self.#retired) self.#statement("DELETE FROM pages WHERE id = ?").run(id);
        self.#retired.clear();
      },
    };
  }

  writeSnapshot(extra: Readonly<Record<string, unknown>>) {
    const snapshot = this.snapshot();
    const index = (section: "models" | "sessions") => {
      let next = 0;
      let residentBytes = 0;
      const recent = new Map<string, number>();
      return (value: string) => {
        const known = recent.get(value);
        if (known !== undefined) return known;
        const id = this.intern(section, value, next);
        if (id === next) next++;
        const bytes = 64 + value.length * 2;
        if (residentBytes + bytes > 1024 * 1024) {
          recent.clear();
          residentBytes = 0;
        }
        if (bytes <= 1024 * 1024) {
          recent.set(value, id);
          residentBytes += bytes;
        }
        return id;
      };
    };
    return {
      contents: encodeScanCachePages(
        Iterator.from(snapshot.entries()).map(([path, entry]) => [path, entry] as const),
        extra,
        { model: index("models"), session: index("sessions") },
        (section) => this.strings(section),
      ),
      release: () => {
        try {
          snapshot.release();
        } finally {
          this.clearStrings();
        }
      },
    };
  }

  contributions(): UsageContributions {
    const scan = ++this.#nextScan;
    const resident = new Map<string, UsageContribution>();
    let residentBytes = 0;
    let spilled = false;
    const put = (key: string, value: UsageContribution) =>
      this.#statement(
        "INSERT INTO contributions VALUES (?, ?, ?) ON CONFLICT (scan, key) DO UPDATE SET payload = excluded.payload",
      ).run(scan, key, JSON.stringify(value));
    const rows = () =>
      this.#statement("SELECT payload FROM contributions WHERE scan = ? ORDER BY rowid").iterate(
        scan,
      );
    const decode = (row: { payload?: unknown } | undefined) =>
      typeof row?.payload === "string" ? (JSON.parse(row.payload) as UsageContribution) : undefined;

    return {
      get: (key) =>
        spilled
          ? decode(
              this.#statement("SELECT payload FROM contributions WHERE scan = ? AND key = ?").get(
                scan,
                key,
              ),
            )
          : resident.get(key),
      set: (key, value) => {
        if (!spilled) {
          const previous = resident.get(key);
          const weight = (entry: UsageContribution) => {
            const { model, rateModel, sessionId, unresolvedServiceTierTurnId } = entry.record;
            return (
              640 +
              4 *
                (key.length +
                  model.length +
                  sessionId.length +
                  (rateModel?.length ?? 0) +
                  (unresolvedServiceTierTurnId?.length ?? 0))
            );
          };
          residentBytes += weight(value) - (previous === undefined ? 0 : weight(previous));
          if (residentBytes <= CONTRIBUTION_BYTES) {
            resident.set(key, value);
            return;
          }
          for (const [heldKey, held] of resident) put(heldKey, held);
          resident.clear();
          spilled = true;
        }
        put(key, value);
      },
      *values() {
        if (!spilled) {
          yield* resident.values();
          return;
        }
        for (const row of rows()) {
          const value = decode(row);
          if (value !== undefined) yield value;
        }
      },
      clear: () => {
        resident.clear();
        residentBytes = 0;
        if (spilled) this.#statement("DELETE FROM contributions WHERE scan = ?").run(scan);
        spilled = false;
      },
    };
  }

  clearStrings() {
    this.#db?.exec("DELETE FROM strings");
  }

  setString(section: string, index: number, value: string) {
    this.#statement("INSERT INTO strings VALUES (?, ?, ?)").run(section, index, value);
  }

  getString(section: string, index: number) {
    const row = this.#statement("SELECT value FROM strings WHERE section = ? AND idx = ?").get(
      section,
      index,
    );
    return typeof row?.value === "string" ? row.value : undefined;
  }

  intern(section: string, value: string, next: number) {
    const row = this.#statement(
      "SELECT idx FROM strings WHERE section = ? AND value = ? LIMIT 1",
    ).get(section, value);
    if (typeof row?.idx === "number") return row.idx;
    this.setString(section, next, value);
    return next;
  }

  *strings(section: string) {
    for (const row of this.#statement(
      "SELECT value FROM strings WHERE section = ? ORDER BY idx",
    ).iterate(section)) {
      if (typeof row.value === "string") yield row.value;
    }
  }
}
