//! Credential shapes removed from diagnostic text GOAT hands on (failed-turn and exit reasons,
//! start and steer reasons, errors, probe messages). Codex and its upstream can quote a key in
//! such text (OpenAI's 401 says "Incorrect API key provided: sk-..."), and the host stores
//! reasons in the thread log. Removed: OpenAI-style `sk-` keys (sk-proj-, sk-svcacct-, sk-ant-
//! and the like), `Bearer` tokens, the value after a credential-named field (`api-key: ...`,
//! `x-api-key=...`, `"api_key": "..."`, token, secret, password), and bare hex runs of 32 or
//! more characters (Azure-style keys). Ids with hyphens or other characters (turn, thread and
//! item ids) are kept. Model output is not diagnostic text and is left as it is.

const REDACTED: &str = "<redacted credential>";
/// Shortest secret part treated as a credential (shorter runs are ordinary words).
const MIN_SECRET: usize = 8;
/// Shortest bare hex run treated as a key (Azure keys are 32 hex characters).
const MIN_HEX: usize = 32;
/// Field names whose value is a credential (compared lowercase; longest first).
const NAMES: [&str; 11] = [
    "x-api-key",
    "access_token",
    "access-token",
    "client_secret",
    "api-key",
    "api_key",
    "apikey",
    "password",
    "secret",
    "token",
    "key",
];

fn key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '*' | '.')
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '*' | '.' | '~' | '+' | '/' | '=')
}

/// Length in bytes of the run of `allowed` characters at the start of `s`.
fn run(s: &str, allowed: fn(char) -> bool) -> usize {
    s.char_indices()
        .find(|&(_, c)| !allowed(c))
        .map_or(s.len(), |(i, _)| i)
}

/// `rest` starts with a credential-named field and its separator: the byte length up to the
/// value (name, optional closing quote, spaces, `:` or `=`, spaces, optional opening quote).
fn field_prefix(rest: &str) -> Option<usize> {
    let lower: String = rest
        .chars()
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    let name = NAMES.iter().find(|n| lower.starts_with(*n))?;
    let after = &rest[name.len()..];
    // The name must end there ("keyboard" is not "key").
    if after.chars().next().is_some_and(key_char) {
        return None;
    }
    let mut i = name.len();
    let bytes = rest.as_bytes();
    if matches!(bytes.get(i), Some(b'"' | b'\'')) {
        i += 1;
    }
    while bytes.get(i) == Some(&b' ') {
        i += 1;
    }
    if !matches!(bytes.get(i), Some(b':' | b'=')) {
        return None;
    }
    i += 1;
    while bytes.get(i) == Some(&b' ') {
        i += 1;
    }
    if matches!(bytes.get(i), Some(b'"' | b'\'')) {
        i += 1;
    }
    Some(i)
}

/// `text` with every credential-shaped token replaced by "<redacted credential>".
pub fn credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev: Option<char> = None;
    while let Some(c) = rest.chars().next() {
        let boundary = prev.is_none_or(|p| !key_char(p));
        if boundary && let Some(at) = field_prefix(rest) {
            let value = &rest[at..];
            let len = run(value, token_char);
            if len >= MIN_SECRET {
                out.push_str(&rest[..at]);
                out.push_str(REDACTED);
                prev = value[..len].chars().last();
                rest = &value[len..];
                continue;
            }
        }
        if boundary {
            let len = run(rest, |c| c.is_ascii_hexdigit());
            let continues = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_');
            if len >= MIN_HEX && !rest[len..].chars().next().is_some_and(continues) {
                out.push_str(REDACTED);
                prev = rest[..len].chars().last();
                rest = &rest[len..];
                continue;
            }
        }
        if boundary && rest.starts_with("sk-") {
            let len = run(rest, key_char);
            if len >= "sk-".len() + MIN_SECRET {
                out.push_str(REDACTED);
                prev = rest[..len].chars().last();
                rest = &rest[len..];
                continue;
            }
        }
        if boundary
            && rest.len() > "bearer ".len()
            && rest.is_char_boundary("bearer ".len())
            && rest[.."bearer ".len()].eq_ignore_ascii_case("bearer ")
        {
            let after = &rest["bearer ".len()..];
            let len = run(after, token_char);
            if len >= MIN_SECRET {
                out.push_str(&rest[.."bearer ".len()]);
                out.push_str(REDACTED);
                prev = after[..len].chars().last();
                rest = &after[len..];
                continue;
            }
        }
        out.push(c);
        prev = Some(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::credentials;

    #[test]
    fn known_key_shapes_are_removed_and_ordinary_text_kept() {
        assert_eq!(
            credentials(
                "401 Unauthorized: Incorrect API key provided: sk-proj-AbC123xyz_-9. See docs."
            ),
            "401 Unauthorized: Incorrect API key provided: <redacted credential> See docs."
        );
        // OpenAI's masked form is removed too.
        assert_eq!(
            credentials("key sk-abc12***************wxyz rejected"),
            "key <redacted credential> rejected"
        );
        assert_eq!(
            credentials("header Authorization: Bearer eyJhbGciOi.payload-x/y+z= failed"),
            "header Authorization: Bearer <redacted credential> failed"
        );
        // Not credentials: short runs, words that merely contain "sk-", ids, other text.
        for kept in [
            "sk-short",
            "task-1234567890abcdef",
            "risk-assessment-0123456789",
            "Bearer token",
            "turn 01a2229b-6ba8-70b2-9917-8dcb2d8b4ae4 failed",
            "한국어 sk- 텍스트",
        ] {
            assert_eq!(credentials(kept), kept);
        }
        assert_eq!(
            credentials("(sk-0123456789abcdef)"),
            "(<redacted credential>)"
        );
        // Review r3 P1: a bare Azure-style key, and values after credential-named fields.
        assert_eq!(
            credentials("api-key: 0123456789abcdef0123456789abcdef rejected"),
            "api-key: <redacted credential> rejected"
        );
        assert_eq!(
            credentials("upstream said 0123456789ABCDEF0123456789abcdef."),
            "upstream said <redacted credential>."
        );
        assert_eq!(
            credentials(r#"{"api_key": "AbCdEfGh12345678", "X-Api-Key=zzzzzzzzzz9"}"#),
            r#"{"api_key": "<redacted credential>", "X-Api-Key=<redacted credential>"}"#
        );
        assert_eq!(
            credentials("password=hunter2hunter2 token: tkn_0123456789"),
            "password=<redacted credential> token: <redacted credential>"
        );
        // Kept: ids with hyphens, short hex, names without a value, words that only start
        // with a name.
        for kept in [
            "turn 01a2229b6ba870b299178dcb2d8b4ae4-x",
            "commit 0123abcd",
            "the key was refused",
            "keyboard: abcdefghijkl",
            "item msg_03b01dcdecd340f0016b0ae85078ac87d09049416bcfdd7f84 failed",
        ] {
            assert_eq!(credentials(kept), kept);
        }
    }
}
