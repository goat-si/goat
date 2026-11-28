//! `goat.jsonl` file access: create, append, header, backward scan, forward scan, tail repair.

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::contract::{Epoch, LOG_FORMAT_VERSION, LogHeader};
use crate::line::{self, Parsed};

pub const LOG_FILE: &str = "goat.jsonl";
const CHUNK: u64 = 64 * 1024;
const HEADER_MAX: u64 = 4096;

pub fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = file.seek_read(&mut buf[done..], offset + done as u64)?;
            if n == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            done += n;
        }
        Ok(())
    }
}

fn read_range(file: &File, start: u64, end: u64) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; (end - start) as usize];
    read_at(file, &mut buf, start)?;
    Ok(buf)
}

/// Create a new log with its header and first line. Fails if the file exists.
pub fn create(path: &Path, epoch: &Epoch, first: &[u8], fsync: bool) -> io::Result<(u64, u64)> {
    let mut header =
        serde_json::to_vec(&LogHeader::new(epoch.clone())).map_err(io::Error::other)?;
    header.push(b'\n');
    let header_end = header.len() as u64;
    header.extend_from_slice(first);
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(&header)?;
    if fsync {
        file.sync_all()?;
    }
    Ok((header_end, header.len() as u64))
}

/// Problems with the start of a log.
#[derive(Debug)]
pub enum TailError {
    Io(io::Error),
    /// No file.
    Missing,
    /// Empty file, unterminated or invalid header.
    BadHeader(String),
    /// A complete line that is not valid, or a seq gap at the end.
    Corrupt(String),
}

impl From<io::Error> for TailError {
    fn from(e: io::Error) -> Self {
        TailError::Io(e)
    }
}

/// Read the header line. Returns the header and the offset right after it.
pub fn read_header(file: &File, len: u64) -> Result<(LogHeader, u64), TailError> {
    if len == 0 {
        return Err(TailError::BadHeader("empty file".into()));
    }
    let buf = read_range(file, 0, len.min(HEADER_MAX))?;
    let nl = buf
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| TailError::BadHeader("header line is not terminated".into()))?;
    let header: LogHeader = serde_json::from_slice(&buf[..nl])
        .map_err(|e| TailError::BadHeader(format!("header does not decode: {e}")))?;
    if header.v != LOG_FORMAT_VERSION {
        return Err(TailError::BadHeader(format!(
            "header v {} is not supported",
            header.v
        )));
    }
    Ok((header, nl as u64 + 1))
}

/// Position of the last newline in [start, end), reading backwards in chunks.
fn rfind_newline(file: &File, start: u64, end: u64) -> io::Result<Option<u64>> {
    let mut hi = end;
    while hi > start {
        let lo = hi.saturating_sub(CHUNK).max(start);
        let buf = read_range(file, lo, hi)?;
        if let Some(i) = buf.iter().rposition(|&b| b == b'\n') {
            return Ok(Some(lo + i as u64));
        }
        hi = lo;
    }
    Ok(None)
}

/// Call `f(line_start, line_bytes)` for every complete line in [start, end), newest first, until it
/// returns false. `end` must be a line boundary.
pub fn scan_back<E: From<io::Error>>(
    file: &File,
    start: u64,
    end: u64,
    mut f: impl FnMut(u64, &[u8]) -> Result<bool, E>,
) -> Result<(), E> {
    let mut buf: Vec<u8> = Vec::new();
    let mut buf_start = end;
    loop {
        if buf.is_empty() {
            if buf_start <= start {
                return Ok(());
            }
            let lo = buf_start.saturating_sub(CHUNK).max(start);
            buf = read_range(file, lo, buf_start)?;
            buf_start = lo;
        }
        // buf covers [buf_start, x) and ends with a newline.
        let search_end = buf.len() - 1;
        match buf[..search_end].iter().rposition(|&b| b == b'\n') {
            Some(i) => {
                if !f(buf_start + i as u64 + 1, &buf[i + 1..search_end])? {
                    return Ok(());
                }
                buf.truncate(i + 1);
            }
            None if buf_start <= start => {
                f(buf_start, &buf[..search_end])?;
                return Ok(());
            }
            None => {
                // A line longer than the buffer: find its start once and read the rest in one go,
                // so a multi-MiB line (a large checkpoint) costs time linear in its length instead
                // of re-copying the growing buffer for every 64 KiB chunk.
                let line_start = rfind_newline(file, start, buf_start)?.map_or(start, |nl| nl + 1);
                let mut line = read_range(file, line_start, buf_start)?;
                line.extend_from_slice(&buf[..search_end]);
                if !f(line_start, &line)? {
                    return Ok(());
                }
                // The bytes before line_start end with the newline at line_start - 1.
                buf.clear();
                buf_start = line_start;
            }
        }
    }
}

/// Call `f(line_start, line_bytes)` for every complete line in [start, end), oldest first, until it
/// returns false.
pub fn scan_forward<E: From<io::Error>>(
    file: &File,
    start: u64,
    end: u64,
    mut f: impl FnMut(u64, &[u8]) -> Result<bool, E>,
) -> Result<(), E> {
    let mut handle = file.try_clone()?;
    handle.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::with_capacity(CHUNK as usize, handle.take(end - start));
    let mut pos = start;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            return Ok(());
        }
        let line = if buf.last() == Some(&b'\n') {
            &buf[..n - 1]
        } else {
            &buf[..n]
        };
        if !f(pos, line)? {
            return Ok(());
        }
        pos += n as u64;
    }
}

/// What tail repair did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Repair {
    /// Bytes after the last valid line were copied to `saved_to` and cut off.
    Truncated { bytes: u64, saved_to: PathBuf },
    /// The last line was complete but had no newline; one was added.
    NewlineAdded,
}

/// State of a log after verifying (and, if needed, repairing) its tail.
#[derive(Debug)]
pub struct Tail {
    pub epoch: Epoch,
    pub header_end: u64,
    pub len: u64,
    /// The last line, if any.
    pub last: Option<Parsed>,
    pub repair: Option<Repair>,
}

impl Tail {
    pub fn last_seq(&self) -> u64 {
        self.last.as_ref().map_or(0, Parsed::seq)
    }
}

/// Verify the end of a log. Only a demonstrably incomplete tail is repaired: bytes after the last
/// newline that are not a complete next line, and trailing lines made only of NUL bytes
/// (zero-filled growth after a crash). A complete line that does not decode is `Corrupt` and the
/// file is left as it is.
pub fn verify_tail(path: &Path, fsync: bool) -> Result<Tail, TailError> {
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(TailError::Missing),
        Err(e) => return Err(e.into()),
    };
    let len = file.metadata()?.len();
    let (header, header_end) = read_header(&file, len)?;
    let last_nl = rfind_newline(&file, header_end, len)?;
    let mut frag_start = last_nl.map_or(header_end, |p| p + 1);
    let unterminated_only = frag_start;
    // Trailing complete lines made only of NUL bytes belong to the incomplete tail.
    while frag_start > header_end {
        let prev = rfind_newline(&file, header_end, frag_start - 1)?;
        let line_start = prev.map_or(header_end, |q| q + 1);
        let bytes = read_range(&file, line_start, frag_start - 1)?;
        if !bytes.is_empty() && bytes.iter().all(|&b| b == 0) {
            frag_start = line_start;
        } else {
            break;
        }
    }
    // The last complete line before the fragment must decode.
    let mut last = None;
    if frag_start > header_end {
        let prev = rfind_newline(&file, header_end, frag_start - 1)?;
        let line_start = prev.map_or(header_end, |q| q + 1);
        let bytes = read_range(&file, line_start, frag_start - 1)?;
        last = Some(line::decode(&bytes).map_err(TailError::Corrupt)?);
    }
    let prev_seq = last.as_ref().map_or(0, Parsed::seq);
    let mut repair = None;
    let mut new_len = len;
    if frag_start < len {
        let frag = read_range(&file, frag_start, len)?;
        let only_nul = frag.iter().all(|&b| b == 0 || b == b'\n');
        let candidate = if only_nul || frag_start != unterminated_only {
            // Zero-filled growth (possibly ending in a partial line): incomplete.
            if !only_nul {
                let tail_part = &frag[(unterminated_only - frag_start) as usize..];
                if !is_incomplete_json(tail_part) {
                    return Err(TailError::Corrupt(
                        "bytes after zero-filled lines are not an incomplete line".into(),
                    ));
                }
            }
            None
        } else if is_incomplete_json(&frag) {
            None
        } else {
            // A complete JSON value: keep it only if it is the next valid line, else fail closed.
            match line::decode(&frag) {
                Ok(parsed) if parsed.seq() == prev_seq + 1 => Some(parsed),
                Ok(parsed) => {
                    return Err(TailError::Corrupt(format!(
                        "unterminated last line has seq {}, expected {}",
                        parsed.seq(),
                        prev_seq + 1
                    )));
                }
                Err(detail) => {
                    return Err(TailError::Corrupt(format!(
                        "unterminated last line is complete but invalid: {detail}"
                    )));
                }
            }
        };
        let mut writer = &file;
        if let Some(parsed) = candidate {
            writer.seek(SeekFrom::End(0))?;
            writer.write_all(b"\n")?;
            new_len = len + 1;
            last = Some(parsed);
            repair = Some(Repair::NewlineAdded);
        } else {
            // Keep the cut bytes for inspection, durably, before the log shrinks.
            let saved_to = torn_path(path);
            let mut backup = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&saved_to)?;
            backup.write_all(&frag)?;
            if fsync {
                backup.sync_all()?;
                if let Some(dir) = path.parent() {
                    crate::fsutil::sync_dir(dir)?;
                }
            }
            file.set_len(frag_start)?;
            new_len = frag_start;
            repair = Some(Repair::Truncated {
                bytes: len - frag_start,
                saved_to,
            });
        }
        if fsync {
            file.sync_all()?;
        }
    }
    Ok(Tail {
        epoch: header.epoch,
        header_end,
        len: new_len,
        last,
        repair,
    })
}

/// True when `bytes` are the start of a JSON value cut off before its end (a torn write). A
/// complete value, or a syntax error before the end, is not incomplete.
fn is_incomplete_json(bytes: &[u8]) -> bool {
    match serde_json::from_slice::<serde_json::Value>(bytes) {
        Ok(_) => false,
        Err(e) => e.is_eof(),
    }
}

fn torn_path(path: &Path) -> PathBuf {
    let mut n = 1;
    loop {
        let candidate = path.with_file_name(format!("{LOG_FILE}.torn-{n}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// Open the log for appending.
pub fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().append(true).open(path)
}

/// Open the log for reading.
pub fn open_read(path: &Path) -> io::Result<File> {
    File::open(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn file_with(lines: &[Vec<u8>]) -> (File, Vec<(u64, Vec<u8>)>, u64) {
        let mut f = tempfile::tempfile().unwrap();
        let mut at = 0u64;
        let mut expect = Vec::new();
        for l in lines {
            f.write_all(l).unwrap();
            f.write_all(b"\n").unwrap();
            expect.push((at, l.clone()));
            at += l.len() as u64 + 1;
        }
        (f, expect, at)
    }

    fn back(file: &File, start: u64, end: u64, stop_after: usize) -> Vec<(u64, Vec<u8>)> {
        let mut got = Vec::new();
        scan_back::<io::Error>(file, start, end, |at, bytes| {
            got.push((at, bytes.to_vec()));
            Ok(got.len() < stop_after)
        })
        .unwrap();
        got
    }

    #[test]
    fn scan_back_returns_lines_longer_than_many_chunks_whole_and_in_order() {
        let huge_a = vec![b'a'; 3 * CHUNK as usize + 17];
        let huge_b = vec![b'b'; 7 * CHUNK as usize + 3];
        let lines = vec![
            huge_a.clone(),
            b"one".to_vec(),
            huge_b.clone(),
            b"two".to_vec(),
            vec![b'c'; CHUNK as usize],
        ];
        let (file, expect, end) = file_with(&lines);
        let mut newest_first = expect.clone();
        newest_first.reverse();
        // From the start of the file: the first line has no newline before it.
        assert_eq!(back(&file, 0, end, usize::MAX), newest_first);
        // A range that starts inside the file, on a line boundary.
        let from = expect[1].0;
        assert_eq!(
            back(&file, from, end, usize::MAX),
            newest_first[..4].to_vec()
        );
        // Stopping right after a huge line.
        assert_eq!(back(&file, 0, end, 3), newest_first[..3].to_vec());
    }
}
