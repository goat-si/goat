//! Credential shapes removed from diagnostic text GOAT hands on (failed-turn and exit reasons,
//! start and steer reasons, errors, probe messages). Codex and its upstream can quote a key in
//! such text (OpenAI's 401 says "Incorrect API key provided: sk-..."), and the host stores
//! reasons in the thread log. Best effort over the known shapes: OpenAI-style `sk-` keys
//! (sk-proj-, sk-svcacct-, sk-ant- and the like) and `Bearer` tokens. Model output is not
//! diagnostic text and is left as it is.

const REDACTED: &str = "<redacted credential>";
/// Shortest secret part treated as a credential (shorter runs are ordinary words).
const MIN_SECRET: usize = 8;

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

/// `text` with every credential-shaped token replaced by "<redacted credential>".
pub fn credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev: Option<char> = None;
    while let Some(c) = rest.chars().next() {
        let boundary = prev.is_none_or(|p| !key_char(p));
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
    }
}
