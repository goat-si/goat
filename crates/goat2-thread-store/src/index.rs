//! `cards.sqlite`: the card index. A cache: one row per thread, rebuildable from the folders.

use std::path::Path;

use rusqlite::{Connection, ErrorCode, OpenFlags, params};

use crate::contract::{CardFile, ThreadCard};
use crate::error::Result;

pub const INDEX_FILE: &str = "cards.sqlite";
pub const SCHEMA_VERSION: i64 = 1;

/// Why the index was rebuilt from the folders.
#[derive(Debug, Clone)]
pub enum RebuildReason {
    Missing,
    Corrupt(String),
    SchemaMismatch(i64),
}

impl std::fmt::Display for RebuildReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RebuildReason::Missing => f.write_str("missing"),
            RebuildReason::Corrupt(detail) => write!(f, "corrupt: {detail}"),
            RebuildReason::SchemaMismatch(v) => write!(f, "schema version {v}"),
        }
    }
}

/// One stored row.
#[derive(Debug, Clone)]
pub struct Row {
    pub id: String,
    pub dirty: bool,
    pub creating: bool,
    pub active_run: bool,
    /// `CardFile` JSON, absent while a create is in progress.
    pub doc: Option<String>,
}

pub struct Index {
    conn: Connection,
    fsync: bool,
}

pub fn is_corruption(err: &rusqlite::Error) -> bool {
    matches!(err, rusqlite::Error::SqliteFailure(e, _)
        if e.code == ErrorCode::NotADatabase || e.code == ErrorCode::DatabaseCorrupt)
}

fn remove_files(path: &Path) -> std::io::Result<()> {
    for suffix in ["", "-wal", "-shm"] {
        let mut p = path.as_os_str().to_owned();
        p.push(suffix);
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

impl Index {
    /// Open the index. Returns a fresh empty index plus the reason when it had to be recreated
    /// (missing file, SQLITE_CORRUPT / NOTADB, schema version mismatch). Other errors fail.
    pub fn open(path: &Path, fsync: bool) -> Result<(Index, Option<RebuildReason>)> {
        if !path.exists() {
            return Ok((Self::create(path, fsync)?, Some(RebuildReason::Missing)));
        }
        match Self::open_existing(path, fsync) {
            Ok(Ok(index)) => Ok((index, None)),
            Ok(Err(version)) => Ok((
                Self::create(path, fsync)?,
                Some(RebuildReason::SchemaMismatch(version)),
            )),
            Err(e) if is_corruption(&e) => Ok((
                Self::create(path, fsync)?,
                Some(RebuildReason::Corrupt(e.to_string())),
            )),
            Err(e) => Err(e.into()),
        }
    }

    fn open_existing(
        path: &Path,
        fsync: bool,
    ) -> rusqlite::Result<std::result::Result<Index, i64>> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version != SCHEMA_VERSION {
            drop(conn);
            return Ok(Err(version));
        }
        conn.query_row("SELECT count(*) FROM cards", [], |r| r.get::<_, i64>(0))?;
        let index = Index { conn, fsync };
        index.configure()?;
        Ok(Ok(index))
    }

    /// Close this connection, delete the files and start an empty index at `path`.
    pub fn recreate(&mut self, path: &Path) -> Result<()> {
        let placeholder = Connection::open_in_memory()?;
        drop(std::mem::replace(&mut self.conn, placeholder));
        *self = Self::create(path, self.fsync)?;
        Ok(())
    }

    fn create(path: &Path, fsync: bool) -> Result<Index> {
        remove_files(path)?;
        let conn = Connection::open(path)?;
        let index = Index { conn, fsync };
        index.configure()?;
        index.conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE cards (
               id TEXT PRIMARY KEY,
               card_seq INTEGER NOT NULL DEFAULT 0,
               kind TEXT, status TEXT, parent_thread_id TEXT, bot_id TEXT, project_id TEXT, cwd TEXT,
               archived INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT,
               dirty INTEGER NOT NULL DEFAULT 0,
               creating INTEGER NOT NULL DEFAULT 0,
               active_run INTEGER NOT NULL DEFAULT 0,
               doc TEXT);
             CREATE INDEX cards_parent ON cards(parent_thread_id);
             CREATE INDEX cards_status ON cards(status);
             CREATE INDEX cards_cwd ON cards(cwd);
             CREATE INDEX cards_project ON cards(project_id);
             CREATE INDEX cards_bot ON cards(bot_id);
             CREATE INDEX cards_kind ON cards(kind);
             CREATE INDEX cards_marks ON cards(dirty, active_run);
             PRAGMA user_version = 1;",
        )?;
        Ok(index)
    }

    fn configure(&self) -> rusqlite::Result<()> {
        self.conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))?;
        self.set_sync(false)
    }

    fn set_sync(&self, durable: bool) -> rusqlite::Result<()> {
        let mode = match (self.fsync, durable) {
            (false, _) => "OFF",
            (true, true) => "FULL",
            (true, false) => "NORMAL",
        };
        self.conn
            .execute_batch(&format!("PRAGMA synchronous={mode}"))
    }

    pub fn load_all(&self) -> rusqlite::Result<Vec<Row>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, dirty, creating, active_run, doc FROM cards")?;
        let rows = stmt.query_map([], |r| {
            Ok(Row {
                id: r.get(0)?,
                dirty: r.get::<_, i64>(1)? != 0,
                creating: r.get::<_, i64>(2)? != 0,
                active_run: r.get::<_, i64>(3)? != 0,
                doc: r.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// Set the dirty/creating marks, committed durably (synchronous=FULL) before the caller writes
    /// to the log.
    pub fn mark(&self, id: &str, dirty: bool, creating: bool) -> Result<()> {
        self.set_sync(true)?;
        let result = self.conn.execute(
            "INSERT INTO cards (id, dirty, creating) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET dirty = excluded.dirty, creating = excluded.creating",
            params![id, dirty as i64, creating as i64],
        );
        self.set_sync(false)?;
        result?;
        Ok(())
    }

    /// Write card rows in one transaction. `dirty` is stored as given; `creating` is cleared.
    pub fn upsert(&mut self, rows: &[(&ThreadCard, bool, bool, String)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO cards (id, card_seq, kind, status, parent_thread_id, bot_id, project_id,
                   cwd, archived, updated_at, dirty, creating, active_run, doc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET card_seq = excluded.card_seq, kind = excluded.kind,
                   status = excluded.status, parent_thread_id = excluded.parent_thread_id,
                   bot_id = excluded.bot_id, project_id = excluded.project_id, cwd = excluded.cwd,
                   archived = excluded.archived, updated_at = excluded.updated_at,
                   dirty = excluded.dirty, creating = 0, active_run = excluded.active_run,
                   doc = excluded.doc",
            )?;
            for (card, dirty, active_run, doc) in rows {
                stmt.execute(params![
                    card.id.as_str(),
                    card.card_seq as i64,
                    serde_json::to_value(card.kind)?
                        .as_str()
                        .unwrap_or_default(),
                    serde_json::to_value(card.status)?
                        .as_str()
                        .unwrap_or_default(),
                    card.parent
                        .as_ref()
                        .map(|p| p.thread_id.as_str().to_owned()),
                    card.bot_id.as_ref().map(|b| b.as_str().to_owned()),
                    card.project_id.as_ref().map(|p| p.as_str().to_owned()),
                    card.engine.cwd,
                    card.archived_at.is_some() as i64,
                    card.updated_at,
                    *dirty as i64,
                    *active_run as i64,
                    doc,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM cards WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }
}

/// Decode a row's `doc`.
pub fn decode_doc(doc: &str) -> Option<CardFile> {
    serde_json::from_str::<CardFile>(doc)
        .ok()
        .filter(|f| f.v == crate::contract::CARD_FILE_FORMAT_VERSION)
}
