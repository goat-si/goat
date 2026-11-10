// SQLite tables of the Login Durable Object. Secrets (device codes, session ids) are stored only as hashes.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
    code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, sign_pub TEXT NOT NULL, noise_pub TEXT NOT NULL,
    name TEXT NOT NULL, country TEXT NOT NULL, city TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, last_poll_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    sub TEXT, email TEXT)`,
  `CREATE TABLE IF NOT EXISTS web_sessions (
    id_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT '',
    user_code TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', verifier TEXT NOT NULL DEFAULT '',
    nonce TEXT NOT NULL DEFAULT '', csrf TEXT NOT NULL DEFAULT '', sub TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '')`,
  "CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS lockouts (source TEXT PRIMARY KEY, wrong INTEGER NOT NULL, first_at INTEGER NOT NULL, locked_until INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS assertions (
    hash TEXT PRIMARY KEY, sub TEXT NOT NULL, name TEXT NOT NULL, exp INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`,
  "CREATE TABLE IF NOT EXISTS accounts (sub TEXT PRIMARY KEY, mesh_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
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
export const Caps = { DEVICES: 10_000, SESSIONS: 20_000 } as const;

export class Store {
  private readonly sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
    for (const statement of SCHEMA) sql.exec(statement);
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

  pendingDevices(now: number): number {
    return this.count("SELECT COUNT(*) AS n FROM devices WHERE expires_at > ?", now);
  }

  /** False when the user code is taken. */
  insertDevice(row: Omit<DeviceRow, "last_poll_at" | "status" | "sub" | "email">): boolean {
    if (this.first("SELECT 1 FROM devices WHERE user_code = ?", row.user_code)) return false;
    this.sql.exec(
      `INSERT INTO devices (code_hash, user_code, sign_pub, noise_pub, name, country, city, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      row.code_hash,
      row.user_code,
      row.sign_pub,
      row.noise_pub,
      row.name,
      row.country,
      row.city,
      row.created_at,
      row.expires_at,
    );
    return true;
  }

  deviceByHash(codeHash: string): DeviceRow | null {
    return this.first<DeviceRow>("SELECT * FROM devices WHERE code_hash = ?", codeHash);
  }

  deviceByUserCode(userCode: string): DeviceRow | null {
    return this.first<DeviceRow>("SELECT * FROM devices WHERE user_code = ?", userCode);
  }

  setPolled(codeHash: string, at: number): void {
    this.sql.exec("UPDATE devices SET last_poll_at = ? WHERE code_hash = ?", at, codeHash);
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

  /** Marks an approved device consumed; false when another poll got there first. */
  consume(codeHash: string): boolean {
    return (
      this.sql.exec(
        "UPDATE devices SET status = 'consumed' WHERE code_hash = ? AND status = 'approved'",
        codeHash,
      ).rowsWritten > 0
    );
  }

  sessionCount(now: number): number {
    return this.count("SELECT COUNT(*) AS n FROM web_sessions WHERE expires_at > ?", now);
  }

  createSession(idHash: string, expiresAt: number): void {
    this.sql.exec(
      "INSERT INTO web_sessions (id_hash, expires_at) VALUES (?, ?)",
      idHash,
      expiresAt,
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

  insertAssertion(hash: string, sub: string, name: string, exp: number): void {
    this.sql.exec(
      "INSERT INTO assertions (hash, sub, name, exp) VALUES (?, ?, ?, ?)",
      hash,
      sub,
      name,
      exp,
    );
  }

  assertion(hash: string): { sub: string; name: string; used: number } | null {
    return this.first("SELECT sub, name, used FROM assertions WHERE hash = ?", hash);
  }

  markAssertionUsed(hash: string): boolean {
    return (
      this.sql.exec("UPDATE assertions SET used = 1 WHERE hash = ? AND used = 0", hash)
        .rowsWritten > 0
    );
  }

  meshOf(sub: string): string | null {
    return (
      this.first<{ mesh_id: string }>("SELECT mesh_id FROM accounts WHERE sub = ?", sub)?.mesh_id ??
      null
    );
  }

  bindMesh(sub: string, meshId: string, now: number): void {
    this.sql.exec(
      "INSERT INTO accounts (sub, mesh_id, created_at) VALUES (?, ?, ?) ON CONFLICT(sub) DO NOTHING",
      sub,
      meshId,
      now,
    );
  }

  upsertNode(row: NodeRow, now: number): void {
    this.sql.exec(
      `INSERT INTO nodes (node_id, sub, sign_pub, noise_pub, name, registered_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET sub = excluded.sub, sign_pub = excluded.sign_pub,
       noise_pub = excluded.noise_pub, name = excluded.name, registered_at = excluded.registered_at`,
      row.node_id,
      row.sub,
      row.sign_pub,
      row.noise_pub,
      row.name,
      now,
    );
  }

  nodesOf(sub: string): Array<NodeRow> {
    return this.sql
      .exec(
        "SELECT node_id, sub, sign_pub, noise_pub, name FROM nodes WHERE sub = ? ORDER BY registered_at, node_id",
        sub,
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

  resetAccount(sub: string): void {
    this.sql.exec("DELETE FROM nodes WHERE sub = ?", sub);
    this.sql.exec("DELETE FROM accounts WHERE sub = ?", sub);
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
