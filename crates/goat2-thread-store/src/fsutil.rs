use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use crate::error::{Result, StoreError};

/// Current UTC time as RFC 3339.
pub fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("RFC 3339 formatting of the current UTC time")
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn random_hex(n: usize) -> String {
    let s = uuid::Uuid::new_v4().simple().to_string();
    s[..n.min(s.len())].to_owned()
}

/// Thread ids are folder names: 1-128 of `A-Z a-z 0-9 . _ -`, not starting with a dot (dot names are
/// reserved for the store's own entries such as `.trash-*`).
pub fn validate_thread_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(StoreError::InvalidThreadId(id.to_owned()))
    }
}

/// A file-name-safe version of `s` (at most 64 characters, never empty, never starting with a dot).
pub fn sanitize_name(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    if out.is_empty() {
        out.push('x');
    }
    out
}

/// fsync a directory so a create/rename inside it is durable. No-op where directories cannot be
/// opened for sync.
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Write `bytes` to `path` through a unique temp file in the same directory, then rename it over
/// `path`. With `fsync` the temp file is synced before the rename and the directory after it.
pub fn atomic_write(path: &Path, bytes: &[u8], fsync: bool) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("path without a parent directory"))?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::other("path without a UTF-8 file name"))?;
    let tmp = dir.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        random_hex(8)
    ));
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        if fsync {
            file.sync_all()?;
        }
        drop(file);
        fs::rename(&tmp, path)?;
        if fsync {
            sync_dir(dir)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
