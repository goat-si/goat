//! Blobs: item fields over the 64 KB line threshold, and attachments the host stores.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

use crate::contract::*;
use crate::error::{Result, StoreError};
use crate::fsutil::{random_hex, sanitize_name, sync_dir};

pub const BLOB_DIR: &str = "blobs";
/// How much of an externalized field stays in the log line.
pub const HEAD_BYTES: usize = 2048;

fn encoded_len<T: serde::Serialize>(value: &T) -> Result<usize> {
    Ok(serde_json::to_vec(value)?.len())
}

/// Apply the contract's omission rules (command / dynamic tool output and file patches are not
/// stored) and, if the event is still over [BLOB_THRESHOLD_BYTES], move the item's one blob field
/// out. Returns the full field text to write to the blob. Items with no blob field that are still
/// too large are refused.
pub fn prepare_item(item: &mut ItemCompleted) -> Result<Option<String>> {
    let omitted: Option<&mut Option<bool>> = match &mut item.item.body {
        TurnItemBody::CommandExecution {
            output,
            output_omitted,
            ..
        } => output.take().map(|_| output_omitted),
        TurnItemBody::DynamicTool {
            output,
            output_omitted,
            ..
        } => output.take().map(|_| output_omitted),
        TurnItemBody::FileChange {
            patch,
            patch_omitted,
            ..
        } => patch.take().map(|_| patch_omitted),
        _ => None,
    };
    if let Some(flag) = omitted {
        *flag = Some(true);
    }
    let size = encoded_len(item)?;
    if size <= BLOB_THRESHOLD_BYTES {
        return Ok(None);
    }
    let kind = item.item.body.type_tag();
    let field: Option<&mut String> = match &mut item.item.body {
        TurnItemBody::UserMessage { text, .. }
        | TurnItemBody::AssistantMessage { text, .. }
        | TurnItemBody::Reasoning { text, .. } => Some(text),
        TurnItemBody::ProposedPlan { markdown, .. } => Some(markdown),
        TurnItemBody::FileChange { diff_str, .. } => diff_str.as_mut(),
        TurnItemBody::Subagent { result, .. } => result.as_mut(),
        TurnItemBody::SystemNotice { message, .. } => Some(message),
        TurnItemBody::Compaction { summary, .. } => summary.as_mut(),
        _ => None,
    };
    let Some(field) = field else {
        return Err(StoreError::PayloadTooLarge(format!(
            "{kind} item {} is {size} bytes and has no field that can move to a blob",
            item.item.id
        )));
    };
    let full = std::mem::take(field);
    *field = clamp_bytes(&full, HEAD_BYTES);
    let after = encoded_len(item)?;
    if after > BLOB_THRESHOLD_BYTES {
        return Err(StoreError::PayloadTooLarge(format!(
            "{kind} item {} is still {after} bytes after moving its main text to a blob",
            item.item.id
        )));
    }
    Ok(Some(full))
}

/// Write a new blob file under `<thread>/blobs/` (exclusive create, synced) and return its ref.
pub fn write_blob(
    thread_dir: &Path,
    name_hint: &str,
    bytes: &[u8],
    fsync: bool,
) -> Result<BlobRef> {
    let dir = thread_dir.join(BLOB_DIR);
    if !dir.exists() {
        fs::create_dir(&dir)?;
        if fsync {
            sync_dir(thread_dir)?;
        }
    }
    let name = format!("{}-{}.txt", sanitize_name(name_hint), random_hex(8));
    let path = dir.join(&name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(bytes)?;
    if fsync {
        file.sync_all()?;
        sync_dir(&dir)?;
    }
    Ok(BlobRef {
        path: format!("{BLOB_DIR}/{name}"),
        size_bytes: bytes.len() as u64,
    })
}

fn valid_blob_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Read a blob by its `BlobRef.path` (`blobs/<name>`). The blobs directory and the file are opened
/// without following symlinks.
pub fn read_blob(thread_dir: &Path, blob_path: &str) -> Result<Vec<u8>> {
    let name = blob_path
        .strip_prefix("blobs/")
        .filter(|n| valid_blob_name(n))
        .ok_or_else(|| StoreError::InvalidBlobPath(blob_path.to_owned()))?;
    let mut file = open_no_follow(&thread_dir.join(BLOB_DIR), name, blob_path)?;
    if !file.metadata()?.is_file() {
        return Err(StoreError::InvalidBlobPath(blob_path.to_owned()));
    }
    let mut out = Vec::new();
    file.read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(unix)]
fn open_no_follow(dir: &Path, name: &str, shown: &str) -> Result<File> {
    use std::ffi::CString;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    let refuse = |err: std::io::Error| -> StoreError {
        match err.raw_os_error() {
            Some(libc::ELOOP) | Some(libc::ENOTDIR) => {
                StoreError::InvalidBlobPath(shown.to_owned())
            }
            _ => StoreError::Io(err),
        }
    };
    let c_dir = CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| StoreError::InvalidBlobPath(shown.to_owned()))?;
    let c_name = CString::new(name).map_err(|_| StoreError::InvalidBlobPath(shown.to_owned()))?;
    // SAFETY: c_dir is a valid NUL-terminated path; the returned descriptor is owned below.
    let dir_fd = unsafe {
        libc::open(
            c_dir.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if dir_fd < 0 {
        return Err(refuse(std::io::Error::last_os_error()));
    }
    // SAFETY: dir_fd is a fresh descriptor we own.
    let dir_fd = unsafe { OwnedFd::from_raw_fd(dir_fd) };
    use std::os::fd::AsRawFd;
    // SAFETY: dir_fd is open; c_name is a single path component (validated above).
    let fd = unsafe {
        libc::openat(
            dir_fd.as_raw_fd(),
            c_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(refuse(std::io::Error::last_os_error()));
    }
    // SAFETY: fd is a fresh descriptor we own.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(not(unix))]
fn open_no_follow(dir: &Path, name: &str, shown: &str) -> Result<File> {
    if fs::symlink_metadata(dir)?.file_type().is_symlink() {
        return Err(StoreError::InvalidBlobPath(shown.to_owned()));
    }
    let path = dir.join(name);
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        return Err(StoreError::InvalidBlobPath(shown.to_owned()));
    }
    Ok(File::open(path)?)
}
