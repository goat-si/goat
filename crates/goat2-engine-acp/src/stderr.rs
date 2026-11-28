//! What the driver keeps of an agent's stderr, and how it is cleaned before any of it leaves the
//! process (startup errors, exit reasons; the host stores those in the thread log).
//!
//! v1 `packages/provider-acp/src/server/stderr.ts` (`ACP_STDERR_TAIL_MAX_CHARS`,
//! `sanitizeAcpStderrExcerpt`) and the bounded stderr reading v1 tests in
//! `apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts:419-441`.

use std::sync::OnceLock;

use regex::Regex;
use tokio::io::{AsyncRead, AsyncReadExt};

/// v1 `ACP_STDERR_TAIL_MAX_CHARS`.
pub const STDERR_TAIL_MAX_CHARS: usize = 4_096;
/// Longest piece of a line without a newline handed on at once; a longer run is split (v1 logs
/// stderr in chunks of at most 32 KiB).
pub const STDERR_LINE_MAX_BYTES: usize = 32 * 1024;

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)https?://\S*/pair#\S*", "[pairing-url]"),
            (r"(?i)https?://accounts\.google\.com\S*", "[sign-in-url]"),
            (r"(?i)\bBearer\s+[A-Za-z0-9._\-+=/]+", "Bearer [redacted]"),
            (r"(?i)\bAuthorization:\s*Basic\s+\S+", "Authorization: Basic [redacted]"),
            (r"(?i)\bx-api-key:\s*\S+", "x-api-key: [redacted]"),
            (
                r"\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}|ghp_[A-Za-z0-9]+|xox[a-zA-Z]-[A-Za-z0-9-]+)\b",
                "[redacted]",
            ),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
        .collect()
    })
}

/// [sanitize_stderr_excerpt] without the final trim (pieces of a stream keep their newlines).
fn clean_text(text: &str, homes: &[String]) -> String {
    let mut result = text.replace('\0', "");
    let mut seen = Vec::new();
    for home in homes.iter().filter(|h| h.len() > 1) {
        if !seen.contains(home) {
            result = result.replace(home.as_str(), "~");
            seen.push(home.clone());
        }
    }
    for (pattern, replacement) in patterns() {
        result = pattern.replace_all(&result, *replacement).into_owned();
    }
    result
}

/// v1 `sanitizeAcpStderrExcerpt`: drop NULs, home directories become `~`, sign-in and pairing
/// links and credentials are replaced, the result trimmed.
pub fn sanitize_stderr_excerpt(text: &str, homes: &[String]) -> String {
    clean_text(text, homes).trim().to_owned()
}

/// A credential key whose value may follow on the next piece.
fn dangling_key() -> &'static Regex {
    static KEY: OnceLock<Regex> = OnceLock::new();
    KEY.get_or_init(|| {
        Regex::new(r"(?i)(\bBearer|\bAuthorization:(\s*Basic)?|\bx-api-key:)\s*$").expect("valid")
    })
}

/// Replace the first (or last) run of non-whitespace characters with `[redacted]`.
fn redact_edge_run(text: &str, leading: bool) -> String {
    let is_space = |c: char| c.is_whitespace();
    let (start, end) = if leading {
        let start = text.find(|c: char| !is_space(c)).unwrap_or(text.len());
        let end = text[start..]
            .find(is_space)
            .map_or(text.len(), |i| start + i);
        (start, end)
    } else {
        let end = text
            .char_indices()
            .rev()
            .find(|(_, c)| !is_space(*c))
            .map_or(0, |(i, c)| i + c.len_utf8());
        let start = text[..end]
            .char_indices()
            .rev()
            .find(|(_, c)| is_space(*c))
            .map_or(0, |(i, c)| i + c.len_utf8());
        (start, end)
    };
    if start == end {
        return text.to_owned();
    }
    format!("{}[redacted]{}", &text[..start], &text[end..])
}

/// The stderr an agent printed, as errors and exit reasons may show it (v1 `appendAcpStderrTail`
/// then `sanitizeAcpStderrExcerpt`, stderr.ts:11-13,28-34). Each line is cleaned when it is
/// complete and only then kept, so the bounded tail is never cut before cleaning: a cut after
/// "Bearer " cannot leave the token behind (final review finding 4). A line longer than
/// [STDERR_LINE_MAX_BYTES] is cleaned in pieces, and the runs that touch a cut are redacted, as is
/// a value on the line after a credential key. The line still arriving counts at once (v1
/// AcpSessionRuntime.ts:835 updates the tail per chunk, final review finding 21).
#[derive(Debug, Default)]
pub struct StderrTail {
    homes: Vec<String>,
    /// Cleaned text of finished pieces, at most [STDERR_TAIL_MAX_CHARS] characters.
    kept: String,
    /// The piece still arriving, shorter than [STDERR_LINE_MAX_BYTES].
    current: Vec<u8>,
    /// The last kept piece may end inside a credential: redact the next piece's first run.
    redact_next: bool,
}

impl StderrTail {
    /// A tail that replaces these home directories with `~`.
    pub fn new(homes: Vec<String>) -> Self {
        Self {
            homes,
            ..Self::default()
        }
    }

    /// Take a chunk as it was read.
    pub fn push(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            self.current.push(byte);
            if byte == b'\n' {
                self.keep(false);
            } else if self.current.len() >= STDERR_LINE_MAX_BYTES {
                self.keep(true);
            }
        }
    }

    /// The piece in `current` is done; `cut` when it ended without a newline.
    fn keep(&mut self, cut: bool) {
        let raw = String::from_utf8_lossy(&self.current).into_owned();
        self.current.clear();
        let (clean, redact_next) = self.clean(&raw, cut);
        self.redact_next = redact_next;
        append_tail(&mut self.kept, &clean);
    }

    /// The cleaned piece, and whether the piece after it starts inside a credential.
    fn clean(&self, raw: &str, cut: bool) -> (String, bool) {
        let blank = raw.trim().is_empty();
        let mut text = raw.to_owned();
        if self.redact_next {
            text = redact_edge_run(&text, true);
        }
        if cut {
            text = redact_edge_run(&text, false);
        }
        let clean = clean_text(&text, &self.homes);
        let redact_next = cut
            || (self.redact_next && blank)
            || dangling_key().is_match(clean.trim_end_matches(['\r', '\n']));
        (clean, redact_next)
    }

    /// The last [STDERR_TAIL_MAX_CHARS] characters, cleaned, the line still arriving included.
    pub fn text(&self) -> String {
        let mut tail = self.kept.clone();
        if !self.current.is_empty() {
            let (clean, _) = self.clean(&String::from_utf8_lossy(&self.current), false);
            append_tail(&mut tail, &clean);
        }
        tail.trim().to_owned()
    }
}

/// The home directories v1 strips: `HOME`, `USERPROFILE` and `os.homedir()` (v1 stderr.ts:22,
/// whose callers pass `os.homedir()`). `os.homedir()` falls back to the account record, which
/// can differ from a changed `HOME`.
pub fn home_directories() -> Vec<String> {
    home_directories_from(
        ["HOME", "USERPROFILE"].map(|name| std::env::var(name).ok()),
        account_home(),
    )
}

/// [home_directories] from the variables' values and the account's home, each once.
fn home_directories_from(
    variables: impl IntoIterator<Item = Option<String>>,
    account: Option<String>,
) -> Vec<String> {
    let mut homes: Vec<String> = Vec::new();
    for home in variables.into_iter().chain([account]).flatten() {
        if !homes.contains(&home) {
            homes.push(home);
        }
    }
    homes
}

/// The current account's home directory from the password database (`getpwuid_r`, as libuv's
/// `os.homedir()` reads it when `HOME` is unset).
#[cfg(unix)]
pub fn account_home() -> Option<String> {
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: zeroed passwd is a valid out parameter; the buffer outlives every read of it.
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() || entry.pw_dir.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_dir points to a NUL-terminated string in `buffer`.
    let dir = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) };
    let dir = dir.to_str().ok()?;
    (!dir.is_empty()).then(|| dir.to_owned())
}

/// Windows: `os.homedir()` is `USERPROFILE`, already in [home_directories].
#[cfg(not(unix))]
pub fn account_home() -> Option<String> {
    None
}

/// v1 `appendAcpStderrTail`: the last [STDERR_TAIL_MAX_CHARS] characters.
pub fn append_tail(current: &mut String, chunk: &str) {
    current.push_str(chunk);
    let chars = current.chars().count();
    if chars > STDERR_TAIL_MAX_CHARS {
        let cut = current
            .char_indices()
            .nth(chars - STDERR_TAIL_MAX_CHARS)
            .map(|(i, _)| i)
            .unwrap_or(0);
        current.drain(..cut);
    }
}

/// Read `reader` to its end in bounded chunks and hand on each line (newline included) or each
/// [STDERR_LINE_MAX_BYTES] piece of a longer run, so an agent that never prints a newline cannot
/// grow host memory.
pub async fn read_bounded_lines<R: AsyncRead + Unpin>(reader: R, on_line: impl FnMut(&[u8])) {
    read_bounded(reader, |_| {}, on_line).await;
}

/// [read_bounded_lines], also handing on every chunk as soon as it is read (the tail must not
/// wait for a newline or end of file, final review finding 21).
pub async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    mut on_chunk: impl FnMut(&[u8]),
    mut on_line: impl FnMut(&[u8]),
) {
    let mut chunk = vec![0u8; 16 * 1024];
    let mut line: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        on_chunk(&chunk[..read]);
        for &byte in &chunk[..read] {
            line.push(byte);
            if byte == b'\n' || line.len() >= STDERR_LINE_MAX_BYTES {
                on_line(&line);
                line.clear();
            }
        }
    }
    if !line.is_empty() {
        on_line(&line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v1 AcpJsonRpcConnection.test.ts:1071-1093 and stderr.ts patterns.
    #[test]
    fn excerpts_are_sanitized_like_v1() {
        let text = "Invalid project config: Unrecognized key in cli.json\nAuthorization: Bearer secret-token-value\n";
        assert_eq!(
            sanitize_stderr_excerpt(text, &[]),
            "Invalid project config: Unrecognized key in cli.json\nAuthorization: Bearer [redacted]"
        );
        let text = "\0at /home/me/proj x-api-key: k1 Authorization: Basic abc sk-abcdefgh123 ghp_X1 xoxb-1-2 https://accounts.google.com/o?code=1 https://h.example/pair#tok";
        assert_eq!(
            sanitize_stderr_excerpt(text, &["/home/me".into(), "/".into()]),
            "at ~/proj x-api-key: [redacted] Authorization: Basic [redacted] [redacted] [redacted] [redacted] [sign-in-url] [pairing-url]"
        );
    }

    /// v1 stderr.ts:22 strips `os.homedir()` too: the account's home stays a home directory when
    /// `HOME` points elsewhere (round 7 part 2.5).
    #[test]
    fn the_account_home_is_a_home_directory() {
        assert_eq!(
            home_directories_from(
                [Some("/tmp/other".to_owned()), None],
                Some("/Users/alice".to_owned())
            ),
            vec!["/tmp/other".to_owned(), "/Users/alice".to_owned()]
        );
        assert_eq!(
            home_directories_from(
                [Some("/Users/alice".to_owned())],
                Some("/Users/alice".into())
            ),
            vec!["/Users/alice".to_owned()]
        );
        #[cfg(unix)]
        {
            let account = account_home().expect("the test account has a home directory");
            assert!(account.starts_with('/'));
            assert!(home_directories().contains(&account));
        }
    }

    #[test]
    fn the_tail_keeps_the_last_characters() {
        let mut tail = String::new();
        append_tail(&mut tail, &"a".repeat(STDERR_TAIL_MAX_CHARS));
        append_tail(&mut tail, "bé");
        assert_eq!(tail.chars().count(), STDERR_TAIL_MAX_CHARS);
        assert!(tail.ends_with("bé"));
    }

    /// A long run without newlines is handed on in bounded pieces while the writer stays open.
    #[tokio::test]
    async fn newline_free_stderr_is_read_in_bounded_pieces() {
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        let feed = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let block = vec![b'x'; 64 * 1024];
            for _ in 0..32 {
                writer.write_all(&block).await.unwrap();
            }
            writer.write_all(b"end\n").await.unwrap();
        });
        let mut longest = 0;
        let mut total = 0;
        read_bounded_lines(reader, |line| {
            longest = longest.max(line.len());
            total += line.len();
        })
        .await;
        feed.await.unwrap();
        assert_eq!(total, 32 * 64 * 1024 + 4);
        assert!(longest <= STDERR_LINE_MAX_BYTES, "{longest}");
    }

    /// Final review finding 4: cleaning happens before any cut, at both buffer boundaries.
    #[test]
    fn the_tail_is_cleaned_before_it_is_cut() {
        let token = |n: usize| "S".repeat(n);
        // The 4096-character tail would start inside the token.
        let mut tail = StderrTail::new(vec![]);
        tail.push(format!("Authorization: Bearer {}\n", token(5_000)).as_bytes());
        assert_eq!(tail.text(), "Authorization: Bearer [redacted]");
        // A token across the 32 KiB piece boundary, fed in odd chunk sizes.
        let mut tail = StderrTail::new(vec![]);
        let line = format!("x-api-key: {}\nnext line\n", token(70_000));
        for chunk in line.as_bytes().chunks(7_777) {
            tail.push(chunk);
        }
        assert!(!tail.text().contains(&token(8)), "{}", tail.text());
        assert!(tail.text().ends_with("next line"));
        // A piece cut right after the key: the run that starts the next piece is redacted.
        let mut tail = StderrTail::new(vec![]);
        let pad = "p".repeat(STDERR_LINE_MAX_BYTES - "Bearer ".len() - 1);
        tail.push(format!("{pad} Bearer {}\n", token(100)).as_bytes());
        assert!(!tail.text().contains(&token(8)), "{}", tail.text());
        // The value on the line after a bare key.
        let mut tail = StderrTail::new(vec![]);
        tail.push(format!("Authorization: Bearer\n\n{} trailing\n", token(40)).as_bytes());
        assert_eq!(tail.text(), "Authorization: Bearer\n\n[redacted] trailing");
        // A home directory split by a cut is not left half-visible.
        let mut tail = StderrTail::new(vec!["/Users/someone".into()]);
        let pad = "p".repeat(STDERR_LINE_MAX_BYTES - "at /Users/so".len());
        tail.push(format!("{pad}at /Users/someone/project\n").as_bytes());
        assert!(!tail.text().contains("/Users/so"), "{}", tail.text());
    }

    /// Final review finding 21: a line without a newline is in the tail as soon as it is read.
    #[tokio::test]
    async fn a_partial_line_reaches_the_tail_at_once() {
        let mut tail = StderrTail::new(vec![]);
        tail.push(b"fatal: config missing");
        assert_eq!(tail.text(), "fatal: config missing");
        tail.push(b" token Bearer abc.def");
        assert_eq!(tail.text(), "fatal: config missing token Bearer [redacted]");
        let (mut writer, reader) = tokio::io::duplex(1024);
        use tokio::io::AsyncWriteExt;
        writer.write_all(b"no newline").await.unwrap();
        drop(writer);
        let mut chunks = Vec::new();
        let mut lines = Vec::new();
        read_bounded(
            reader,
            |chunk| chunks.push(chunk.to_vec()),
            |line| lines.push(line.to_vec()),
        )
        .await;
        assert_eq!(chunks, [b"no newline".to_vec()]);
        assert_eq!(lines, [b"no newline".to_vec()]);
    }
}
