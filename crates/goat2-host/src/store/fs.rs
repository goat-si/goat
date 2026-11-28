//! Interim file-backed [ThreadStore] (see the module docs in `store/mod.rs`).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use goat2_contracts::{
    Epoch, Fold, InputAccepted, InputId, LogEvent, LogHeader, LogLine, ThreadCard, ThreadCreated,
    ThreadId,
};
use serde::{Deserialize, Serialize};

use super::fold::{CardFold, fold_line, new_fold};
use super::{Appended, StoreError, StoreResult, ThreadStore};
use crate::util::now_rfc3339;

const LOG_FILE: &str = "goat.jsonl";
const CARD_FILE: &str = "card.json";

#[derive(Serialize, Deserialize)]
struct CardFile {
    v: u32,
    card: ThreadCard,
    fold: Fold,
}

struct ThreadFile {
    dir: PathBuf,
    log: File,
    epoch: Epoch,
    last_seq: u64,
    cf: CardFold,
}

/// File-backed store rooted at `<dataDir>/threads`.
pub struct FsStore {
    root: PathBuf,
    index_epoch: Epoch,
    card_seq: AtomicU64,
    threads: RwLock<HashMap<ThreadId, Arc<Mutex<ThreadFile>>>>,
}

impl FsStore {
    /// Open (or create) `<data_dir>/threads` and load every card. Threads whose card is
    /// missing, unreadable, or behind the log are re-folded from `goat.jsonl`.
    pub fn open(data_dir: &Path) -> StoreResult<Self> {
        let root = data_dir.join("threads");
        fs::create_dir_all(&root)?;
        let store = Self {
            root,
            index_epoch: Epoch::new(uuid::Uuid::new_v4().to_string()),
            card_seq: AtomicU64::new(0),
            threads: RwLock::new(HashMap::new()),
        };
        let mut loaded = Vec::new();
        for entry in fs::read_dir(&store.root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = ThreadId::new(entry.file_name().to_string_lossy().into_owned());
            match load_thread(&entry.path(), &id) {
                Ok(Some(file)) => loaded.push((id, file)),
                Ok(None) => {}
                Err(err) => tracing::warn!(thread = %id, %err, "skipping unreadable thread"),
            }
        }
        // Fresh index epoch: card_seq runs 1..N in last-update order.
        loaded.sort_by(|a, b| a.1.cf.card.updated_at.cmp(&b.1.cf.card.updated_at));
        let mut map = store.threads.write().expect("store lock");
        for (id, mut file) in loaded {
            file.cf.card.card_seq = store.card_seq.fetch_add(1, Ordering::SeqCst) + 1;
            map.insert(id, Arc::new(Mutex::new(file)));
        }
        drop(map);
        Ok(store)
    }

    fn get(&self, id: &ThreadId) -> StoreResult<Arc<Mutex<ThreadFile>>> {
        self.threads
            .read()
            .expect("store lock")
            .get(id)
            .cloned()
            .ok_or_else(|| StoreError::NotFound(id.clone()))
    }

    fn log_path(&self, id: &ThreadId) -> PathBuf {
        self.root.join(id.as_str()).join(LOG_FILE)
    }

    fn append_inner(
        &self,
        id: &ThreadId,
        events: Vec<LogEvent>,
        durable: bool,
    ) -> StoreResult<Appended> {
        let thread = self.get(id)?;
        let mut file = thread.lock().expect("thread lock");
        let mut lines = Vec::with_capacity(events.len());
        let mut buf = String::new();
        let mut cf = file.cf.clone();
        let mut seq = file.last_seq;
        for event in events {
            seq += 1;
            let line = LogLine::new(seq, now_rfc3339(), event);
            buf.push_str(&serde_json::to_string(&line).map_err(io_err)?);
            buf.push('\n');
            fold_line(&mut cf, &line);
            lines.push(line);
        }
        file.log.write_all(buf.as_bytes())?;
        if durable {
            file.log.sync_data()?;
        }
        file.last_seq = seq;
        cf.card.card_seq = self.card_seq.fetch_add(1, Ordering::SeqCst) + 1;
        write_card(&file.dir, &cf)?;
        file.cf = cf;
        Ok(Appended {
            lines,
            card: file.cf.card.clone(),
            fold: file.cf.fold.clone(),
        })
    }

    fn scan(&self, id: &ThreadId) -> StoreResult<Vec<LogLine>> {
        // Hold the thread lock only to learn the path; reads see whole lines up to last_seq.
        let last = {
            let thread = self.get(id)?;
            let file = thread.lock().expect("thread lock");
            file.last_seq
        };
        let mut lines = read_log(&self.log_path(id), id)?.1;
        lines.retain(|l| l.seq <= last);
        Ok(lines)
    }
}

fn io_err(err: serde_json::Error) -> StoreError {
    StoreError::Io(std::io::Error::other(err))
}

fn write_card(dir: &Path, cf: &CardFold) -> StoreResult<()> {
    let body = serde_json::to_vec(&CardFile {
        v: 1,
        card: cf.card.clone(),
        fold: cf.fold.clone(),
    })
    .map_err(io_err)?;
    let tmp = dir.join(format!("{CARD_FILE}.tmp"));
    {
        let mut f = File::create(&tmp)?;
        f.write_all(&body)?;
    }
    fs::rename(tmp, dir.join(CARD_FILE))?;
    Ok(())
}

/// Read a whole log: header epoch and lines. A torn last line (crash mid-write) is ignored.
fn read_log(path: &Path, id: &ThreadId) -> StoreResult<(Epoch, Vec<LogLine>)> {
    let reader = BufReader::new(File::open(path)?);
    let mut epoch = None;
    let mut lines = Vec::new();
    let mut raw: Vec<String> = Vec::new();
    for line in reader.lines() {
        raw.push(line?);
    }
    let total = raw.len();
    for (i, text) in raw.into_iter().enumerate() {
        if text.trim().is_empty() {
            continue;
        }
        if epoch.is_none() {
            let header: LogHeader =
                serde_json::from_str(&text).map_err(|e| StoreError::Corrupt {
                    thread: id.clone(),
                    message: format!("header: {e}"),
                })?;
            epoch = Some(header.epoch);
            continue;
        }
        match serde_json::from_str::<LogLine>(&text) {
            Ok(line) => lines.push(line),
            Err(_) if i + 1 == total => break,
            Err(e) => {
                return Err(StoreError::Corrupt {
                    thread: id.clone(),
                    message: format!("line {}: {e}", i + 1),
                });
            }
        }
    }
    let epoch = epoch.ok_or_else(|| StoreError::Corrupt {
        thread: id.clone(),
        message: "missing header".to_owned(),
    })?;
    Ok((epoch, lines))
}

fn load_thread(dir: &Path, id: &ThreadId) -> StoreResult<Option<ThreadFile>> {
    let log_path = dir.join(LOG_FILE);
    if !log_path.exists() {
        return Ok(None);
    }
    let stored: Option<CardFile> = fs::read(dir.join(CARD_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    // Interim policy: always read the log tail to learn last_seq; re-fold lines past appliedSeq.
    let (epoch, lines) = read_log(&log_path, id)?;
    let last_seq = lines.last().map_or(0, |l| l.seq);
    let cf = match stored {
        Some(s) if s.card.epoch == epoch && s.card.applied_seq <= last_seq => {
            let mut cf = CardFold::from_stored(s.card, s.fold);
            let applied = cf.card.applied_seq;
            for line in lines.iter().filter(|l| l.seq > applied) {
                fold_line(&mut cf, line);
            }
            cf
        }
        _ => {
            let Some(first) = lines.first() else {
                return Ok(None);
            };
            let Some(mut cf) = new_fold(id, epoch.clone(), first) else {
                return Err(StoreError::Corrupt {
                    thread: id.clone(),
                    message: "first line is not thread.created".to_owned(),
                });
            };
            for line in &lines[1..] {
                fold_line(&mut cf, line);
            }
            cf
        }
    };
    let log = OpenOptions::new().append(true).open(&log_path)?;
    Ok(Some(ThreadFile {
        dir: dir.to_path_buf(),
        log,
        epoch,
        last_seq,
        cf,
    }))
}

impl ThreadStore for FsStore {
    fn index_epoch(&self) -> Epoch {
        self.index_epoch.clone()
    }

    fn create(&self, id: &ThreadId, created: ThreadCreated) -> StoreResult<Appended> {
        let dir = self.root.join(id.as_str());
        if dir.exists() || self.threads.read().expect("store lock").contains_key(id) {
            return Err(StoreError::Exists(id.clone()));
        }
        fs::create_dir_all(dir.join("blobs"))?;
        let epoch = Epoch::new(uuid::Uuid::new_v4().to_string());
        let header = serde_json::to_string(&LogHeader::new(epoch.clone())).map_err(io_err)?;
        let line = LogLine::new(1, now_rfc3339(), LogEvent::ThreadCreated(created));
        let mut log = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(dir.join(LOG_FILE))?;
        log.write_all(
            format!(
                "{header}\n{}\n",
                serde_json::to_string(&line).map_err(io_err)?
            )
            .as_bytes(),
        )?;
        log.sync_data()?;
        let mut cf = new_fold(id, epoch.clone(), &line).expect("thread.created");
        cf.card.card_seq = self.card_seq.fetch_add(1, Ordering::SeqCst) + 1;
        write_card(&dir, &cf)?;
        let appended = Appended {
            lines: vec![line],
            card: cf.card.clone(),
            fold: cf.fold.clone(),
        };
        self.threads.write().expect("store lock").insert(
            id.clone(),
            Arc::new(Mutex::new(ThreadFile {
                dir,
                log,
                epoch,
                last_seq: 1,
                cf,
            })),
        );
        Ok(appended)
    }

    fn append(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended> {
        self.append_inner(id, events, false)
    }

    fn append_durable(&self, id: &ThreadId, events: Vec<LogEvent>) -> StoreResult<Appended> {
        self.append_inner(id, events, true)
    }

    fn card(&self, id: &ThreadId) -> Option<ThreadCard> {
        let thread = self.get(id).ok()?;
        let file = thread.lock().expect("thread lock");
        Some(file.cf.card.clone())
    }

    fn fold(&self, id: &ThreadId) -> Option<Fold> {
        let thread = self.get(id).ok()?;
        let file = thread.lock().expect("thread lock");
        Some(file.cf.fold.clone())
    }

    fn cards(&self) -> Vec<ThreadCard> {
        let threads: Vec<_> = self
            .threads
            .read()
            .expect("store lock")
            .values()
            .cloned()
            .collect();
        let mut cards: Vec<ThreadCard> = threads
            .iter()
            .map(|t| t.lock().expect("thread lock").cf.card.clone())
            .collect();
        cards.sort_by_key(|c| c.card_seq);
        cards
    }

    fn delete(&self, id: &ThreadId) -> StoreResult<u64> {
        let removed = self.threads.write().expect("store lock").remove(id);
        if removed.is_none() {
            return Err(StoreError::NotFound(id.clone()));
        }
        fs::remove_dir_all(self.root.join(id.as_str()))?;
        Ok(self.card_seq.fetch_add(1, Ordering::SeqCst) + 1)
    }

    fn thread_epoch(&self, id: &ThreadId) -> Option<Epoch> {
        let thread = self.get(id).ok()?;
        let file = thread.lock().expect("thread lock");
        Some(file.epoch.clone())
    }

    fn last_seq(&self, id: &ThreadId) -> Option<u64> {
        let thread = self.get(id).ok()?;
        let file = thread.lock().expect("thread lock");
        Some(file.last_seq)
    }

    fn read_after(&self, id: &ThreadId, after: u64) -> StoreResult<Vec<LogLine>> {
        let mut lines = self.scan(id)?;
        lines.retain(|l| l.seq > after);
        Ok(lines)
    }

    fn read_page(
        &self,
        id: &ThreadId,
        before: u64,
        limit: usize,
    ) -> StoreResult<(Vec<LogLine>, bool)> {
        let mut lines = self.scan(id)?;
        lines.retain(|l| l.seq < before);
        let has_more = lines.len() > limit;
        let start = lines.len().saturating_sub(limit);
        Ok((lines.split_off(start), has_more))
    }

    fn latest_checkpoint_seq(&self, id: &ThreadId) -> StoreResult<Option<u64>> {
        Ok(self
            .scan(id)?
            .iter()
            .rev()
            .find(|l| matches!(l.event, LogEvent::Checkpoint(_)))
            .map(|l| l.seq))
    }

    fn find_inputs(&self, id: &ThreadId, inputs: &[InputId]) -> StoreResult<Vec<InputAccepted>> {
        let mut found: Vec<InputAccepted> = Vec::new();
        for line in self.scan(id)? {
            if let LogEvent::InputAccepted(input) = line.event
                && inputs.contains(&input.input_id)
                && !found.iter().any(|f| f.input_id == input.input_id)
            {
                found.push(input);
            }
        }
        Ok(found)
    }
}
