//! Pi's generated GOAT MCP extension, lifted from v1 commit 916b5ccc1b2.
//!
//! The adjacent TypeScript file is the evaluated `PI_GOAT_MCP_EXTENSION_SOURCE`,
//! including the registry-derived read targets and all interpolated instructions.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const PI_GOAT_MCP_EXTENSION_FILENAME: &str = "pi-goat-mcp-extension.ts";
pub const PI_GOAT_MCP_EXTENSION_SOURCE: &str = include_str!("pi-goat-mcp-extension.ts");

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Materialize the embedded source in `cache_dir`, returning its absolute or
/// relative path according to the supplied directory. Concurrent writers use
/// separate same-directory staging files, so readers never see a partial file.
pub fn materialize_pi_goat_mcp_extension(cache_dir: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(cache_dir)?;
    let dest = cache_dir.join(PI_GOAT_MCP_EXTENSION_FILENAME);
    match fs::read(&dest) {
        Ok(existing) if existing == PI_GOAT_MCP_EXTENSION_SOURCE.as_bytes() => return Ok(dest),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    // create_new avoids collisions with other processes and stale staging files.
    let (staging, mut file) = loop {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = cache_dir.join(format!(
            ".{PI_GOAT_MCP_EXTENSION_FILENAME}.{}.{}.tmp",
            std::process::id(),
            serial
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => break (StagingFile(path), file),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    };
    file.write_all(PI_GOAT_MCP_EXTENSION_SOURCE.as_bytes())?;
    drop(file);
    fs::rename(&staging.0, &dest)?;
    Ok(dest)
}

// Remove only our own staging file on a failed write or rename.
struct StagingFile(PathBuf);

impl Drop for StagingFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
