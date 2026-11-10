// SQLite tables of the Login Durable Object. Secrets (device codes, session ids) are stored only as hashes.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
    code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, sign_pub TEXT NOT NULL, noise_pub TEXT NOT NULL,
    name TEXT NOT NULL, country TEXT NOT NULL, city TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, last_poll_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    sub TEXT, email TEXT, source TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS devices_by_source ON devices (source, expires_at)",
  "CREATE INDEX IF NOT EXISTS devices_by_sub ON devices (sub, status)",
  `CREATE TABLE IF NOT EXISTS web_sessions (
    id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, source TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT '',
    user_code TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', verifier TEXT NOT NULL DEFAULT '',
    nonce TEXT NOT NULL DEFAULT '', csrf TEXT NOT NULL DEFAULT '', sub TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '')`,
  "CREATE INDEX IF NOT EXISTS sessions_by_source ON web_sessions (source, expires_at)",
  "CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lockouts (source TEXT PRIMARY KEY, wrong INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS assertions (
    hash TEXT PRIMARY KEY, sub TEXT NOT NULL, name TEXT NOT NULL, exp INTEGER NOT NULL, issued_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS assertions_by_sub ON assertions (sub, used)",
  "CREATE TABLE IF NOT EXISTS accounts (sub TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS resets (sub TEXT PRIMARY KEY, at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS nodes (
    node_id TEXT PRIMARY KEY, sub TEXT NOT NULL, sign_pub TEXT NOT NULL, noise_pub TEXT NOT NULL, name TEXT NOT NULL,
    registered_at INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS nodes_by_sub ON nodes (sub, registered_at)",
  "CREATE TABLE IF NOT EXISTS jwks (url TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL)",
];

export type DeviceStatus = "pending" | "approved" | "denied" | "consumed";

export interface DeviceRow {
  readonly code_hash: string;
  readonly user_code: string;
  readonly sign_pub: string;
  readonly noise_pub: string;
  readonly name: string;
  readonly country: string;
  readonly city: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_poll_at: number;
  readonly status: DeviceStatus;
  readonly sub: string | null;
  readonly email: string | null;
}

export interface SessionRow {
  readonly id_hash: string;
  readonly expires_at: number;
  readonly purpose: "" | "device" | "reset";
  readonly user_code: string;
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly csrf: string;
  readonly sub: string;
  readonly email: string;
}

export interface NodeRow {
  readonly node_id: string;
  readonly sub: string;
  readonly sign_pub: string;
  readonly noise_pub: string;
  readonly name: string;
}

type SessionFields = Partial<Omit<SessionRow, "id_hash" | "expires_at">>;

/** Bounds on rows a flood could otherwise grow without limit. */
export const Caps = { DEVICES: 10_000, SESSIONS: 20_000, NODES_PER_ACCOUNT: 64 } as const;

export interface Registration {
  readonly hash: string;
  readonly sub: string;
  readonly meshId: string;
  readonly nodeId: string;
  readonly signPub: string;
  readonly noisePub: string;
}

export type RegisterError =
  | "unknown_assertion"
  | "assertion_used"
  | "issued_before_reset"
  | "mesh_mismatch"
  | "account_full";

export type RegisterResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RegisterError };

/** What a poll decides, taken in one step so two polls at once cannot both pass the interval check. */
export type PollOutcome = "expired" | "slow_down" | "denied" | "pending" | "approved";

export class Store {
  private readonly storage: DurableObjectStorage;
  private readonly sql: SqlStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    this.sql = storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  private first<T>(query: string, ...bindings: Array<string | number | null>): T | null {
    const rows = this.sql.exec(query, ...bindings).toArray();
    return (rows[0] as T | undefined) ?? null;
  }

  private count(query: string, ...bindings: Array<string | number>): number {
    return Number(this.first<{ n: number }>(query, ...bindings)?.n ?? 0);
  }

  prune(now: number): void {
    this.sql.exec("DELETE FROM devices WHERE expires_at < ?", now - 3_600_000);
    this.sql.exec("DELETE FROM web_sessions WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM counters WHERE window < ?", Math.floor(now / 60_000) - 1);
    this.sql.exec(
      "DELETE FROM lockouts WHERE locked_until < ? AND first_at < ?",
      now,
      now - 600_000,
    );
    this.sql.exec("DELETE FROM assertions WHERE exp < ?", Math.floor(now / 1000) - 120);
  }

  /** Increments the per-minute counter for key and returns its new value. */
  hit(key: string, now: number): number {
    const window = Math.floor(now / 60_000);
    const row = this.first<{ count: number }>(
      `INSERT INTO counters (key, window, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END,
       window = excluded.window RETURNING count`,
      key,
      window,
    );
    return Number(row?.count ?? 1);
  }

  lockedUntil(source: string): number {
    return Number(
      this.first<{ locked_until: number }>(
        "SELECT locked_until FROM lockouts WHERE source = ?",
        source,
      )?.locked_until ?? 0,
    );
  }

  /** Counts a wrong code; the fifth within 10 minutes locks the source for 10 minutes. Returns tries left. */
  recordWrongCode(source: string, now: number): number {
    const row = this.first<{ wrong: number; first_at: number }>(
      "SELECT wrong, first_at FROM lockouts WHERE source = ?",
      source,
    );
    const fresh = !row || now - row.first_at > 600_000;
    const wrong = fresh ? 1 : row.wrong + 1;
    const lockedUntil = wrong >= 5 ? now + 600_000 : 0;
    this.sql.exec(
      `INSERT INTO lockouts (source, wrong, first_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET wrong = excluded.wrong, first_at = excluded.first_at, locked_until = excluded.locked_until`,
      source,
      wrong,
      fresh ? now : row.first_at,
      lockedUntil,
    );
    return Math.max(0, 5 - wrong);
  }

  liveDevices(now: number): number {
    return this.count("SELECT COUNT(*) AS n FROM devices WHERE expires_at > ?", now);
  }

  liveDevicesFrom(source: string, now: number): number {
    return this.count(
      "SELECT COUNT(*) AS n FROM devices WHERE source = ? AND expires_at > ?",
      source,
      now,
    );
  }

  /** False when the user code is taken. */
  insertDevice(
    row: Omit<DeviceRow, "last_poll_at" | "status" | "sub" | "email">,
    source: string,
  ): boolean {
    if (this.first("SELECT 1 FROM devices WHERE user_code = ?", row.user_code)) return false;
    this.sql.exec(
      `INSERT INTO devices (code_hash, user_code, sign_pub, noise_pub, name, country, city, created_at, expires_at, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      row.code_hash,
      row.user_code,
      row.sign_pub,
      row.noise_pub,
      row.name,
      row.country,
      row.city,
      row.created_at,
      row.expires_at,
      source,
    );
    return true;
  }

  deviceByHash(codeHash: string): DeviceRow | null {
    return this.first<DeviceRow>("SELECT * FROM devices WHERE code_hash = ?", codeHash);
  }

  deviceByUserCode(userCode: string): DeviceRow | null {
    return this.first<DeviceRow>("SELECT * FROM devices WHERE user_code = ?", userCode);
  }

  /**
   * Reads the device, applies the interval and records the poll in one synchronous step; an approved device is
   * consumed here, so it yields at most one assertion.
   */
  poll(
    codeHash: string,
    now: number,
    intervalMs: number,
  ): { outcome: PollOutcome; device: DeviceRow | null } {
    const device = this.deviceByHash(codeHash);
    if (!device || device.status === "consumed" || now >= device.expires_at)
      return { outcome: "expired", device };
    if (device.last_poll_at !== 0 && now - device.last_poll_at < intervalMs)
      return { outcome: "slow_down", device };
    this.sql.exec("UPDATE devices SET last_poll_at = ? WHERE code_hash = ?", now, codeHash);
    if (device.status === "denied") return { outcome: "denied", device };
    if (device.status !== "approved" || !device.sub || !device.email)
      return { outcome: "pending", device };
    this.sql.exec("UPDATE devices SET status = 'consumed' WHERE code_hash = ?", codeHash);
    return { outcome: "approved", device };
  }

  /** Moves a pending, unexpired device to approved or denied; false when it was no longer pending. */
  decide(
    userCode: string,
    status: "approved" | "denied",
    sub: string,
    email: string,
    now: number,
  ): boolean {
    const changed = this.sql.exec(
      "UPDATE devices SET status = ?, sub = ?, email = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
      status,
      sub,
      email,
      userCode,
      now,
    ).rowsWritten;
    return changed > 0;
  }

  liveSessions(now: number): number {
    return this.count("SELECT COUNT(*) AS n FROM web_sessions WHERE expires_at > ?", now);
  }

  liveSessionsFrom(source: string, now: number): number {
    return this.count(
      "SELECT COUNT(*) AS n FROM web_sessions WHERE source = ? AND expires_at > ?",
      source,
      now,
    );
  }

  createSession(idHash: string, expiresAt: number, source: string): void {
    this.sql.exec(
      "INSERT INTO web_sessions (id_hash, expires_at, source) VALUES (?, ?, ?)",
      idHash,
      expiresAt,
      source,
    );
  }

  session(idHash: string, now: number): SessionRow | null {
    return this.first<SessionRow>(
      "SELECT * FROM web_sessions WHERE id_hash = ? AND expires_at > ?",
      idHash,
      now,
    );
  }

  updateSession(idHash: string, fields: SessionFields): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    this.sql.exec(
      `UPDATE web_sessions SET ${assignments} WHERE id_hash = ?`,
      ...entries.map(([, value]) => String(value)),
      idHash,
    );
  }

  insertAssertion(hash: string, sub: string, name: string, exp: number, issuedAt: number): void {
    this.sql.exec(
      "INSERT INTO assertions (hash, sub, name, exp, issued_at) VALUES (?, ?, ?, ?, ?)",
      hash,
      sub,
      name,
      exp,
      issuedAt,
    );
  }

  meshOf(sub: string): string | null {
    return (
      this.first<{ mesh_id: string }>("SELECT mesh_id FROM accounts WHERE sub = ?", sub)?.mesh_id ??
      null
    );
  }

  /** Checks and records a registration in one transaction, so concurrent registers cannot interleave. */
  register(input: Registration, now: number): RegisterResult {
    return this.storage.transactionSync((): RegisterResult => {
      const issued = this.first<{ sub: string; name: string; used: number; issued_at: number }>(
        "SELECT sub, name, used, issued_at FROM assertions WHERE hash = ?",
        input.hash,
      );
      if (!issued || issued.sub !== input.sub) return { ok: false, error: "unknown_assertion" };
      if (issued.used) return { ok: false, error: "assertion_used" };
      const resetAt =
        this.first<{ at: number }>("SELECT at FROM resets WHERE sub = ?", input.sub)?.at ?? 0;
      if (issued.issued_at <= resetAt) return { ok: false, error: "issued_before_reset" };
      const meshId = this.meshOf(input.sub);
      if (meshId !== null && meshId !== input.meshId) return { ok: false, error: "mesh_mismatch" };
      const known = this.first(
        "SELECT 1 FROM nodes WHERE node_id = ? AND sub = ?",
        input.nodeId,
        input.sub,
      );
      if (
        !known &&
        this.count("SELECT COUNT(*) AS n FROM nodes WHERE sub = ?", input.sub) >=
          Caps.NODES_PER_ACCOUNT
      ) {
        return { ok: false, error: "account_full" };
      }
      this.sql.exec("UPDATE assertions SET used = 1 WHERE hash = ?", input.hash);
      this.sql.exec(
        "INSERT INTO accounts (sub, mesh_id, created_at) VALUES (?, ?, ?) ON CONFLICT(sub) DO NOTHING",
        input.sub,
        input.meshId,
        now,
      );
      this.sql.exec(
        `INSERT INTO nodes (node_id, sub, sign_pub, noise_pub, name, registered_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET sub = excluded.sub, sign_pub = excluded.sign_pub,
         noise_pub = excluded.noise_pub, name = excluded.name, registered_at = excluded.registered_at`,
        input.nodeId,
        input.sub,
        input.signPub,
        input.noisePub,
        issued.name,
        now,
      );
      return { ok: true };
    });
  }

  /**
   * Clears the account and makes what was in flight useless: approved device codes nobody polled are denied,
   * and assertions not yet registered are spent.
   */
  reset(sub: string, now: number): void {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM nodes WHERE sub = ?", sub);
      this.sql.exec("DELETE FROM accounts WHERE sub = ?", sub);
      this.sql.exec(
        "INSERT INTO resets (sub, at) VALUES (?, ?) ON CONFLICT(sub) DO UPDATE SET at = excluded.at",
        sub,
        now,
      );
      this.sql.exec(
        "UPDATE devices SET status = 'denied' WHERE sub = ? AND status = 'approved'",
        sub,
      );
      this.sql.exec("UPDATE assertions SET used = 1 WHERE sub = ? AND used = 0", sub);
    });
  }

  nodesOf(sub: string): Array<NodeRow> {
    return this.sql
      .exec(
        "SELECT node_id, sub, sign_pub, noise_pub, name FROM nodes WHERE sub = ? ORDER BY registered_at, node_id LIMIT ?",
        sub,
        Caps.NODES_PER_ACCOUNT,
      )
      .toArray() as unknown as Array<NodeRow>;
  }

  node(nodeId: string): NodeRow | null {
    return this.first<NodeRow>(
      "SELECT node_id, sub, sign_pub, noise_pub, name FROM nodes WHERE node_id = ?",
      nodeId,
    );
  }

  nodeBySignPub(signPub: string): NodeRow | null {
    return this.first<NodeRow>(
      "SELECT node_id, sub, sign_pub, noise_pub, name FROM nodes WHERE sign_pub = ?",
      signPub,
    );
  }

  deleteNode(nodeId: string): void {
    this.sql.exec("DELETE FROM nodes WHERE node_id = ?", nodeId);
  }

  jwks(url: string): { body: string; fetched_at: number } | null {
    return this.first("SELECT body, fetched_at FROM jwks WHERE url = ?", url);
  }

  saveJwks(url: string, body: string, at: number): void {
    this.sql.exec(
      "INSERT INTO jwks (url, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at",
      url,
      body,
      at,
    );
  }
}
