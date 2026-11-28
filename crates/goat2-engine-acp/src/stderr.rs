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

/// v1 `sanitizeAcpStderrExcerpt`: drop NULs, home directories become `~`, sign-in and pairing
/// links and credentials are replaced, the result trimmed.
pub fn sanitize_stderr_excerpt(text: &str, homes: &[String]) -> String {
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
    result.trim().to_owned()
}

/// The home directories v1 strips (`HOME`, `USERPROFILE`).
pub fn home_directories() -> Vec<String> {
    ["HOME", "USERPROFILE"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .collect()
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
pub async fn read_bounded_lines<R: AsyncRead + Unpin>(
    mut reader: R,
    mut on_line: impl FnMut(&[u8]),
) {
    let mut chunk = vec![0u8; 16 * 1024];
    let mut line: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
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
}
