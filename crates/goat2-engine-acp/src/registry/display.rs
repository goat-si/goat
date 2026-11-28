//! Display helpers, from v1 `shellDisplayToken.ts` (all 5 lines) and `agentVersion.ts` (all 5
//! lines) at 916b5ccc1b2.

use regex::Regex;

/// v1 `shellDisplayToken.ts:1-5`: quote a token for display in a copyable shell command.
pub fn shell_display_token(token: &str) -> String {
    if Regex::new(r"^[A-Za-z0-9_@%+=:,./-]+$")
        .expect("static regex")
        .is_match(token)
    {
        token.to_owned()
    } else {
        format!("'{}'", token.replace('\'', r"'\''"))
    }
}

/// v1 `agentVersion.ts:1-5`: a version an agent reports, without control characters, trimmed and
/// cut to 64 UTF-16 units (a surrogate pair cut in half is dropped).
pub fn bounded_agent_version(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value
        .chars()
        .any(|c| matches!(c, '\u{0000}'..='\u{001f}' | '\u{007f}'..='\u{009f}'))
    {
        return None;
    }
    let trimmed = super::schema::js_trim(value);
    if trimmed.is_empty() {
        return None;
    }
    let mut units = 0;
    Some(
        trimmed
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= 64
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_and_versions() {
        assert_eq!(shell_display_token("npm@1.2.3"), "npm@1.2.3");
        assert_eq!(shell_display_token("it's here"), r"'it'\''s here'");
        assert_eq!(shell_display_token(""), "''");
        assert_eq!(
            bounded_agent_version(Some(" 1.2.3 ")).as_deref(),
            Some("1.2.3")
        );
        assert_eq!(bounded_agent_version(Some("1.0\n")), None);
        assert_eq!(bounded_agent_version(Some("\u{85}")), None);
        assert_eq!(bounded_agent_version(Some("  ")), None);
        assert_eq!(bounded_agent_version(None), None);
        assert_eq!(
            bounded_agent_version(Some(&"9".repeat(80))).unwrap().len(),
            64
        );
    }
}
