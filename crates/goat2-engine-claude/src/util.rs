//! Small helpers: timestamps, ids, base64.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// RFC 3339 UTC with milliseconds (same conversion as the Codex driver's `rfc3339_ms`).
pub fn rfc3339_ms(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86400);
    let time = seconds.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        time / 3600,
        time % 3600 / 60,
        time % 60,
        ms.rem_euclid(1000)
    )
}

/// Current time as RFC 3339.
pub fn now_rfc3339() -> String {
    rfc3339_ms(now_ms())
}

/// RFC 3339 UTC time `after` from now.
pub fn rfc3339_after(after: std::time::Duration) -> String {
    rfc3339_ms(now_ms().saturating_add(after.as_millis() as i64))
}

/// A random UUID v4 string.
pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Diagnostic text without credentials: the GOAT MCP bearer token and any `Bearer <value>` are
/// replaced, as Claude's errors can echo request headers.
pub fn redact_secrets(text: &str, token: &str) -> String {
    let mut out = if token.is_empty() {
        text.to_string()
    } else {
        text.replace(token, "[redacted]")
    };
    let mut from = 0;
    while let Some(found) = out[from..].find("Bearer ") {
        let start = from + found + "Bearer ".len();
        let end = out[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '"' | '\'' | ',' | ';'))
            .map_or(out.len(), |n| start + n);
        if &out[start..end] != "[redacted]" {
            out.replace_range(start..end, "[redacted]");
        }
        from = start + "[redacted]".len();
    }
    out
}

/// Reads a regular file without following a symlink at its final component (`O_NOFOLLOW`), so a
/// file swapped for a symlink after the host checked it is refused.
pub fn read_no_follow(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn rfc3339_epoch() {
        assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[cfg(unix)]
    #[test]
    fn read_no_follow_refuses_a_symlink() {
        let dir = std::env::temp_dir().join(format!("goat2-claude-nofollow-{}", super::uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("real.png"), b"png").unwrap();
        std::os::unix::fs::symlink(dir.join("real.png"), dir.join("link.png")).unwrap();
        assert_eq!(
            super::read_no_follow(&dir.join("real.png")).unwrap(),
            b"png"
        );
        assert!(super::read_no_follow(&dir.join("link.png")).is_err());
        assert!(
            super::read_no_follow(&dir).is_err(),
            "a directory is not read"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
