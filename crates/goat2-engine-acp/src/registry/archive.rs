//! Registry archive rules and extraction, from v1 `registryArchive.ts` (all 44 lines) and the
//! extraction steps of `AcpRegistrySupport.ts:1382-1418` at 916b5ccc1b2.
//!
//! v1 lists an archive with `tar -t` / `unzip -Z1`, rejects the whole archive when any entry name
//! fails [validate_archive_entries], then extracts with `tar -x` / `unzip`. GOAT 2 reads and extracts
//! in process (tar, flate2, bzip2, zip crates) with the same entry rule, so no external `tar` or
//! `unzip` is needed (v1's Windows `System32\tar.exe` choice, `cliRelease.ts:37-45`, falls away).
//! Extraction also refuses to write through a link that leaves the destination.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// v1 `AcpRegistrySupport.ts:79`: listings above this are refused (v1 caps `tar -t` output).
pub const MAX_ARCHIVE_LISTING_BYTES: usize = 64 * 1024 * 1024;
/// GOAT 2: the most an archive may expand to. v1 caps only the download (1 GiB,
/// AcpRegistrySupport.ts:74) and lets `tar`/`unzip` write whatever it expands to
/// (:1402-1416); a highly compressed archive could fill the disk (final review 6 finding C1).
pub const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// GOAT 2: the most entries an archive may hold (final review 6 finding C1).
pub const MAX_ARCHIVE_ENTRIES: usize = 200_000;

/// How far listing and extraction go before the archive is refused with
/// [io::ErrorKind::FileTooLarge].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveLimits {
    pub max_bytes: u64,
    pub max_entries: usize,
}

impl ArchiveLimits {
    pub const DEFAULT: Self = Self {
        max_bytes: MAX_EXTRACTED_BYTES,
        max_entries: MAX_ARCHIVE_ENTRIES,
    };
}

/// What is left of the limits while an archive is read: every entry and its expanded size are
/// charged before the entry is written.
struct Budget {
    bytes: u64,
    entries: usize,
}

impl Budget {
    fn new(limits: ArchiveLimits) -> Self {
        Self {
            bytes: limits.max_bytes,
            entries: limits.max_entries,
        }
    }

    fn charge(&mut self, bytes: u64) -> io::Result<()> {
        if self.entries == 0 || bytes > self.bytes {
            return Err(too_large());
        }
        self.entries -= 1;
        self.bytes -= bytes;
        Ok(())
    }
}

fn too_large() -> io::Error {
    io::Error::new(
        io::ErrorKind::FileTooLarge,
        "archive expands past the extraction limit",
    )
}

/// The bytes a tar entry expands to: its data, or a GNU sparse file's full size.
fn tar_entry_bytes<R: Read>(entry: &tar::Entry<'_, R>) -> u64 {
    let header = entry.header();
    let sparse = header.entry_type().is_gnu_sparse().then(|| {
        header
            .as_gnu()
            .and_then(|gnu| gnu.real_size().ok())
            .unwrap_or(u64::MAX)
    });
    entry.size().max(sparse.unwrap_or(0))
}

/// v1 `registryArchive.ts:1-13`: relative segments of a registry command or archive entry, or
/// None for an absolute, drive-letter, empty or `.`/`..` path.
pub fn normalize_registry_command_path(command: &str) -> Option<Vec<String>> {
    let normalized = command.trim().replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    let bytes = normalized.as_bytes();
    if normalized.starts_with('/')
        || bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    {
        return None;
    }
    let segments: Vec<String> = normalized
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if segments.is_empty() || segments.iter().any(|s| s == "." || s == "..") {
        None
    } else {
        Some(segments)
    }
}

/// v1 `registryArchive.ts:15-21`: every listed entry is `./` or a safe relative path.
pub fn validate_archive_entries(listing: &str) -> bool {
    listing
        .split('\n')
        .map(|e| e.strip_suffix('\r').unwrap_or(e).trim())
        .filter(|e| !e.is_empty())
        .all(|e| e == "./" || normalize_registry_command_path(e).is_some())
}

/// v1 `registryArchive.ts:23`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    Raw,
    TarBz2,
    TarGz,
    Zip,
}

/// v1 `registryArchive.ts:25-31`: by the URL path's suffix.
pub fn archive_kind(url: &str) -> ArchiveKind {
    let path = reqwest::Url::parse(url)
        .map(|u| u.path().to_lowercase())
        .unwrap_or_default();
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        ArchiveKind::TarGz
    } else if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
        ArchiveKind::TarBz2
    } else if path.ends_with(".zip") {
        ArchiveKind::Zip
    } else {
        ArchiveKind::Raw
    }
}

/// v1 `registryArchive.ts:33-44`.
pub fn archive_file_name(kind: ArchiveKind) -> &'static str {
    match kind {
        ArchiveKind::TarGz => "agent.tar.gz",
        ArchiveKind::TarBz2 => "agent.tar.bz2",
        ArchiveKind::Zip => "agent.zip",
        ArchiveKind::Raw => "agent.bin",
    }
}

fn tar_reader(kind: ArchiveKind, path: &Path) -> io::Result<tar::Archive<Box<dyn Read>>> {
    let file = File::open(path)?;
    let reader: Box<dyn Read> = match kind {
        ArchiveKind::TarGz => Box::new(flate2::read::GzDecoder::new(file)),
        ArchiveKind::TarBz2 => Box::new(bzip2::read::BzDecoder::new(file)),
        _ => return Err(io::Error::other("not a tar archive")),
    };
    Ok(tar::Archive::new(reader))
}

/// The entry names, newline separated, as `tar -t` / `unzip -Z1` print them. None when the
/// listing exceeds [MAX_ARCHIVE_LISTING_BYTES]; [io::ErrorKind::FileTooLarge] when the archive
/// would expand past [ArchiveLimits::DEFAULT] (checked from the headers, before a tar entry's
/// data is read past).
pub fn list_entries(kind: ArchiveKind, path: &Path) -> io::Result<Option<String>> {
    let mut budget = Budget::new(ArchiveLimits::DEFAULT);
    let mut listing = String::new();
    let mut push = |name: &str| {
        listing.push_str(name);
        listing.push('\n');
        listing.len() <= MAX_ARCHIVE_LISTING_BYTES
    };
    match kind {
        ArchiveKind::Raw => {}
        ArchiveKind::Zip => {
            let mut archive = zip::ZipArchive::new(File::open(path)?).map_err(io::Error::other)?;
            for index in 0..archive.len() {
                let entry = archive.by_index_raw(index).map_err(io::Error::other)?;
                budget.charge(entry.size())?;
                if !push(&String::from_utf8_lossy(entry.name_raw())) {
                    return Ok(None);
                }
            }
        }
        ArchiveKind::TarGz | ArchiveKind::TarBz2 => {
            let mut archive = tar_reader(kind, path)?;
            for entry in archive.entries()? {
                let entry = entry?;
                budget.charge(tar_entry_bytes(&entry))?;
                if !push(&String::from_utf8_lossy(&entry.path_bytes())) {
                    return Ok(None);
                }
            }
        }
    }
    Ok(Some(listing))
}

/// Whether `path` stays under `root` once its existing parent is resolved.
fn inside(root: &Path, path: &Path) -> io::Result<bool> {
    let parent = path.parent().unwrap_or(root);
    Ok(fs::canonicalize(parent)?.starts_with(fs::canonicalize(root)?))
}

/// Where a zip entry lands. v1 checks the listing with the normalized form
/// (`registryArchive.ts:15-20`) and then `unzip` writes each entry under its own name
/// (`AcpRegistrySupport.ts:1402-1416`): the check and the output name are separate, so spaces and
/// (on Unix) backslashes in a name are kept.
fn zip_target(destination: &Path, name: &str) -> io::Result<Option<PathBuf>> {
    let unsafe_entry = || io::Error::new(io::ErrorKind::InvalidData, "unsafe archive entry");
    if name.trim() == "./" {
        return Ok(None);
    }
    normalize_registry_command_path(name).ok_or_else(unsafe_entry)?;
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let mut segments = name.split(separators).filter(|s| !s.is_empty()).peekable();
    // `unzip` drops a leading `./`; the check above already accepted it.
    if segments.peek() == Some(&".") {
        segments.next();
    }
    let mut target = destination.to_path_buf();
    let mut any = false;
    for segment in segments {
        // Windows drops trailing dots and spaces, so `.. ` would climb; refuse such names.
        let effective = if cfg!(windows) {
            segment.trim_end_matches(['.', ' '])
        } else {
            segment
        };
        if segment == "." || segment == ".." || effective.is_empty() {
            return Err(unsafe_entry());
        }
        target.push(segment);
        any = true;
    }
    Ok(any.then_some(target))
}

/// Extract a validated archive into `destination` (v1 `tar -x -C` / `unzip -q -d`) within
/// [ArchiveLimits::DEFAULT].
pub fn extract(kind: ArchiveKind, archive_path: &Path, destination: &Path) -> io::Result<()> {
    extract_within(kind, archive_path, destination, ArchiveLimits::DEFAULT)
}

/// [extract] within `limits`: each entry is charged against the entry count and the expanded
/// bytes before it is written, and a zip entry is cut off if it expands past what it declared.
/// On any failure `destination` is emptied, so no partial extraction is left behind.
pub fn extract_within(
    kind: ArchiveKind,
    archive_path: &Path,
    destination: &Path,
    limits: ArchiveLimits,
) -> io::Result<()> {
    let result = extract_into(kind, archive_path, destination, Budget::new(limits));
    if result.is_err() {
        empty_directory(destination);
    }
    result
}

/// Remove everything inside `dir` without following links.
fn empty_directory(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {
                let _ = fs::remove_dir_all(&path);
            }
            _ => {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

fn extract_into(
    kind: ArchiveKind,
    archive_path: &Path,
    destination: &Path,
    mut budget: Budget,
) -> io::Result<()> {
    match kind {
        ArchiveKind::Raw => Ok(()),
        ArchiveKind::TarGz | ArchiveKind::TarBz2 => {
            let mut archive = tar_reader(kind, archive_path)?;
            archive.set_overwrite(true);
            for entry in archive.entries()? {
                let mut entry = entry?;
                budget.charge(tar_entry_bytes(&entry))?;
                // The tar crate also refuses entries that would land outside `destination`.
                if !entry.unpack_in(destination)? {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "archive entry escapes the destination",
                    ));
                }
            }
            Ok(())
        }
        ArchiveKind::Zip => {
            let mut archive =
                zip::ZipArchive::new(File::open(archive_path)?).map_err(io::Error::other)?;
            // Declared sizes first, so a bomb is refused before its first entry is written.
            let mut declared = Budget {
                bytes: budget.bytes,
                entries: budget.entries,
            };
            for index in 0..archive.len() {
                declared.charge(
                    archive
                        .by_index_raw(index)
                        .map_err(io::Error::other)?
                        .size(),
                )?;
            }
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index).map_err(io::Error::other)?;
                let size = entry.size();
                budget.charge(size)?;
                let name = String::from_utf8_lossy(entry.name_raw()).into_owned();
                let Some(target) = zip_target(destination, &name)? else {
                    continue;
                };
                if entry.is_dir() {
                    create_dirs_within(destination, &target)?;
                    continue;
                }
                if let Some(parent) = target.parent() {
                    create_dirs_within(destination, parent)?;
                }
                if !inside(destination, &target)? {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "archive entry escapes the destination",
                    ));
                }
                let mode = entry.unix_mode();
                let is_link = mode.is_some_and(|m| m & 0o170000 == 0o120000);
                if is_link {
                    let mut link = String::new();
                    (&mut entry)
                        .take(size.min(64 * 1024))
                        .read_to_string(&mut link)?;
                    let _ = fs::remove_file(&target);
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&link, &target)?;
                    #[cfg(not(unix))]
                    fs::write(&target, link)?;
                    continue;
                }
                let _ = fs::remove_file(&target);
                let mut out = File::create(&target)?;
                // An entry that expands past its declared size is not trusted further.
                if io::copy(&mut (&mut entry).take(size + 1), &mut out)? > size {
                    return Err(too_large());
                }
                #[cfg(unix)]
                if let Some(mode) = mode {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, fs::Permissions::from_mode(mode & 0o777))?;
                }
            }
            Ok(())
        }
    }
}

/// Create `target` and its missing parents under `destination`, refusing to pass through any
/// existing component that is a symlink or not a directory. Nothing is created outside
/// `destination`, even when an earlier archive entry planted a link (final review 2 finding 2;
/// v1 extracts with `tar`/`unzip` into a fresh directory, AcpRegistrySupport.ts:1402-1416).
fn create_dirs_within(destination: &Path, target: &Path) -> io::Result<()> {
    let relative = target.strip_prefix(destination).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "archive entry escapes the destination",
        )
    })?;
    let mut current = destination.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "archive entry escapes the destination",
            ));
        };
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "archive entry escapes the destination",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(&current)?,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// A gzip tar with the given (name, contents, mode) entries; names are written raw so
    /// unsafe ones can be built.
    pub(crate) fn tar_gz(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::default(),
        ));
        for (name, data, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(*mode);
            header.set_entry_type(tar::EntryType::Regular);
            let raw = &mut header.as_old_mut().name;
            raw[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    pub(crate) fn zip_bytes(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        for (name, data, mode) in entries {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(*mode);
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else if mode & 0o170000 == 0o120000 {
                writer
                    .add_symlink(*name, std::str::from_utf8(data).unwrap(), options)
                    .unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(data).unwrap();
            }
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn command_paths_and_listings() {
        assert_eq!(
            normalize_registry_command_path(" ./bin\\agent "),
            Some(vec!["bin".into(), "agent".into()])
        );
        for p in ["", "./", "../x", "/x", "C:\\x", "c:x", "a/./b", "a/../b"] {
            assert!(normalize_registry_command_path(p).is_none(), "{p}");
        }
        assert!(validate_archive_entries("./\n./bin/\r\n./bin/agent\n\n"));
        assert!(!validate_archive_entries("bin/agent\n../escape\n"));
        assert!(!validate_archive_entries("/etc/passwd"));
    }

    #[test]
    fn kinds_follow_the_url_path() {
        assert_eq!(
            archive_kind("https://x.test/a.TGZ?x=.zip"),
            ArchiveKind::TarGz
        );
        assert_eq!(
            archive_kind("https://x.test/a.tar.bz2"),
            ArchiveKind::TarBz2
        );
        assert_eq!(archive_kind("https://x.test/a.zip#.tgz"), ArchiveKind::Zip);
        assert_eq!(archive_kind("https://x.test/agent"), ArchiveKind::Raw);
        assert_eq!(archive_file_name(ArchiveKind::TarBz2), "agent.tar.bz2");
    }

    #[test]
    fn lists_and_extracts_tar_and_zip() {
        let dir = tempfile::tempdir().unwrap();
        for (kind, bytes) in [
            (
                ArchiveKind::TarGz,
                tar_gz(&[("bin/agent", b"#!/bin/sh\n", 0o755)]),
            ),
            (
                ArchiveKind::Zip,
                zip_bytes(&[("bin/agent", b"#!/bin/sh\n", 0o755)]),
            ),
        ] {
            let archive = dir.path().join(archive_file_name(kind));
            fs::write(&archive, bytes).unwrap();
            assert_eq!(
                list_entries(kind, &archive).unwrap().unwrap(),
                "bin/agent\n"
            );
            let out = dir.path().join(format!("out-{kind:?}"));
            fs::create_dir(&out).unwrap();
            extract(kind, &archive, &out).unwrap();
            assert_eq!(fs::read(out.join("bin/agent")).unwrap(), b"#!/bin/sh\n");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(out.join("bin/agent"))
                    .unwrap()
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o111, 0o111);
            }
        }
    }

    #[test]
    fn traversal_entries_are_listed_and_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("agent.tar.gz");
        fs::write(&archive, tar_gz(&[("../escape", b"x", 0o644)])).unwrap();
        let listing = list_entries(ArchiveKind::TarGz, &archive).unwrap().unwrap();
        assert!(!validate_archive_entries(&listing));
        let zip = dir.path().join("agent.zip");
        fs::write(&zip, zip_bytes(&[("../escape", b"x", 0o644)])).unwrap();
        let listing = list_entries(ArchiveKind::Zip, &zip).unwrap().unwrap();
        assert!(!validate_archive_entries(&listing));
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        assert!(extract(ArchiveKind::Zip, &zip, &out).is_err());
        assert!(!dir.path().join("escape").exists());
    }

    #[cfg(unix)]
    #[test]
    fn zip_entries_cannot_write_through_an_escaping_link() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let zip = dir.path().join("agent.zip");
        let target = outside.to_str().unwrap().to_owned();
        fs::write(
            &zip,
            zip_bytes(&[
                ("link", target.as_bytes(), 0o120777),
                ("link/file", b"x", 0o644),
            ]),
        )
        .unwrap();
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        assert!(extract(ArchiveKind::Zip, &zip, &out).is_err());
        assert!(!outside.join("file").exists());
    }

    /// Directory entries and the parents of file entries are never created through a planted link
    /// (final review 2 finding 2).
    #[test]
    fn zip_directories_cannot_be_created_through_an_escaping_link() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let target = outside.to_str().unwrap().to_owned();
        for entries in [
            vec![
                ("out", target.as_bytes(), 0o120777),
                ("out/new/", &b""[..], 0o755),
            ],
            vec![
                ("out", target.as_bytes(), 0o120777),
                ("out/deep/file", &b"x"[..], 0o644),
            ],
        ] {
            let zip = dir.path().join("agent.zip");
            fs::write(&zip, zip_bytes(&entries)).unwrap();
            let dest = tempfile::tempdir_in(dir.path()).unwrap();
            assert!(extract(ArchiveKind::Zip, &zip, dest.path()).is_err());
            assert!(!outside.join("new").exists());
            assert!(!outside.join("deep").exists());
        }
    }

    /// A gzip tar whose one entry declares `declared` bytes but carries only `data` (a bomb's
    /// header without the gigabytes behind it).
    pub(crate) fn tar_gz_declaring(name: &str, declared: u64, data: &[u8]) -> Vec<u8> {
        let mut header = tar::Header::new_gnu();
        header.set_path(name).unwrap();
        header.set_size(declared);
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(header.as_bytes()).unwrap();
        gz.write_all(data).unwrap();
        gz.finish().unwrap()
    }

    /// Rewrite every entry's uncompressed size, in the local and central headers.
    fn zip_declaring(mut bytes: Vec<u8>, declared: u32) -> Vec<u8> {
        let size = declared.to_le_bytes();
        let mut i = 0;
        while i + 46 <= bytes.len() {
            match &bytes[i..i + 4] {
                [0x50, 0x4b, 0x03, 0x04] => bytes[i + 22..i + 26].copy_from_slice(&size),
                [0x50, 0x4b, 0x01, 0x02] => bytes[i + 24..i + 28].copy_from_slice(&size),
                _ => {}
            }
            i += 1;
        }
        bytes
    }

    fn is_empty_dir(path: &Path) -> bool {
        fs::read_dir(path).unwrap().next().is_none()
    }

    /// Final review 6 finding C1 (v1 `tar -x` / `unzip` extract whatever expands,
    /// AcpRegistrySupport.ts:1402-1416; only the 1 GiB download is capped): an entry declaring more
    /// than the 4 GiB expansion limit is refused before anything is written, in the listing too.
    #[test]
    fn a_tar_bomb_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("agent.tar.gz");
        // A fixed 4 GiB + 1 (the documented limit), so the test does not follow a changed constant.
        let declared = 4 * 1024 * 1024 * 1024 + 1;
        fs::write(&archive, tar_gz_declaring("agent", declared, &[0; 4096])).unwrap();
        let listed = list_entries(ArchiveKind::TarGz, &archive).unwrap_err();
        assert_eq!(listed.kind(), io::ErrorKind::FileTooLarge, "{listed}");
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        let error = extract(ArchiveKind::TarGz, &archive, &out).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::FileTooLarge, "{error}");
        assert!(is_empty_dir(&out));
    }

    /// C1: zip entries whose declared sizes add up past the limit are refused before any is
    /// written.
    #[test]
    fn a_zip_bomb_is_refused_before_anything_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("agent.zip");
        let entries: Vec<(String, Vec<u8>)> = (0..3)
            .map(|i| (format!("part{i}"), vec![0u8; 1024]))
            .collect();
        let entries: Vec<(&str, &[u8], u32)> = entries
            .iter()
            .map(|(n, d)| (n.as_str(), d.as_slice(), 0o644))
            .collect();
        // Three entries of almost 4 GiB each: past the 4 GiB limit together.
        fs::write(&zip, zip_declaring(zip_bytes(&entries), 0xFFFF_FF00)).unwrap();
        let listed = list_entries(ArchiveKind::Zip, &zip).unwrap_err();
        assert_eq!(listed.kind(), io::ErrorKind::FileTooLarge, "{listed}");
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        let error = extract(ArchiveKind::Zip, &zip, &out).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::FileTooLarge, "{error}");
        assert!(is_empty_dir(&out));
    }

    /// C1 with real data: entries are charged as they come, so the entry that would pass the
    /// cumulative byte limit or the entry count is refused, and what was already written is
    /// removed.
    #[test]
    fn limits_count_real_bytes_and_entries_and_clean_up() {
        let dir = tempfile::tempdir().unwrap();
        let data = vec![0u8; 1000];
        let three: Vec<(&str, &[u8], u32)> = vec![
            ("bin/a", &data, 0o644),
            ("bin/b", &data, 0o644),
            ("bin/c", &data, 0o644),
        ];
        for kind in [ArchiveKind::TarGz, ArchiveKind::Zip] {
            let archive = dir.path().join(archive_file_name(kind));
            let bytes = if kind == ArchiveKind::Zip {
                zip_bytes(&three)
            } else {
                tar_gz(&three)
            };
            fs::write(&archive, bytes).unwrap();
            for limits in [
                ArchiveLimits {
                    max_bytes: 2_500,
                    max_entries: 10,
                },
                ArchiveLimits {
                    max_bytes: 10_000,
                    max_entries: 2,
                },
            ] {
                let out = tempfile::tempdir_in(dir.path()).unwrap();
                let error = extract_within(kind, &archive, out.path(), limits).unwrap_err();
                assert_eq!(
                    error.kind(),
                    io::ErrorKind::FileTooLarge,
                    "{kind:?} {limits:?}"
                );
                assert!(is_empty_dir(out.path()), "{kind:?} {limits:?}");
            }
            let out = tempfile::tempdir_in(dir.path()).unwrap();
            extract_within(
                kind,
                &archive,
                out.path(),
                ArchiveLimits {
                    max_bytes: 3_000,
                    max_entries: 3,
                },
            )
            .unwrap();
            assert_eq!(fs::read(out.path().join("bin/c")).unwrap().len(), 1000);
        }
    }

    /// C1: a zip entry that expands past the size it declared is cut off at that size.
    #[test]
    fn a_zip_entry_cannot_expand_past_its_declared_size() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("agent.zip");
        let data = vec![7u8; 100_000];
        fs::write(&zip, zip_declaring(zip_bytes(&[("big", &data, 0o644)]), 10)).unwrap();
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        assert!(extract(ArchiveKind::Zip, &zip, &out).is_err());
        assert!(is_empty_dir(&out));
    }

    /// v1 validates the listing, then `unzip` extracts each entry under its own name
    /// (registryArchive.ts:15-20, AcpRegistrySupport.ts:1402-1416): the trimmed, slash-normalized
    /// form is only for the safety check (final review finding 12).
    #[cfg(unix)]
    #[test]
    fn zip_extraction_keeps_the_original_entry_names() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("agent.zip");
        fs::write(
            &zip,
            zip_bytes(&[(" bin /agent ", b"a", 0o755), ("dir\\name", b"b", 0o644)]),
        )
        .unwrap();
        let listing = list_entries(ArchiveKind::Zip, &zip).unwrap().unwrap();
        assert!(validate_archive_entries(&listing));
        let out = dir.path().join("out");
        fs::create_dir(&out).unwrap();
        extract(ArchiveKind::Zip, &zip, &out).unwrap();
        let mut names: Vec<String> = fs::read_dir(&out)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [" bin ", "dir\\name"]);
        assert_eq!(fs::read(out.join(" bin ").join("agent ")).unwrap(), b"a");
        assert_eq!(fs::read(out.join("dir\\name")).unwrap(), b"b");
    }
}
