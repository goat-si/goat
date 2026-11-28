//! Codex input items for a turn start or steer, ported from GOAT v1 (origin/dev 916b5ccc):
//! - `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:2636-2696` (`toCodexInput`,
//!   `resolveCodexAttachment`): text item when non-empty, then every native image as a data URL;
//!   an unresolvable or unreadable image is an error before anything is sent.
//! - `packages/provider-core/src/server/attachmentPrompt.ts:154-176`
//!   (`isProviderNativeImageAttachment`, `providerMessageTextWithAttachmentPaths`): every
//!   attachment is named in the text with its saved path, or marked unavailable.
//! - `apps/server/src/orchestration-v2/Adapters/CodexTextHelpers.ts:14` with
//!   `packages/shared/src/composerInlineTokens.ts:25-30`: a skill typed with any currency sign
//!   (`€review`) becomes Codex's `$review`.
//!
//! GOAT 2 has no document text extraction and no captured-window sources, so those v1 branches
//! have nothing to carry.

use std::path::PathBuf;
use std::sync::Arc;

use goat2_contracts::{ChatAttachment, ChatAttachmentType, ThreadId};
use goat2_engine_api::EngineInput;

use crate::protocol::client::UserInput;

/// A saved attachment the host found: where it is (named in the text) and, when the driver asked
/// for them, its bytes, read by the host (safely, from its own store) so the driver never opens a
/// host path itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAttachment {
    pub path: PathBuf,
    pub bytes: Option<Vec<u8>>,
}

/// Finds the saved file of an attachment (the host knows the thread folder; v1
/// `resolveAttachmentPath`). The flag asks for the bytes too (native images are sent inline).
/// `None` means it cannot be found or read.
pub type AttachmentResolver =
    Arc<dyn Fn(&ThreadId, &ChatAttachment, bool) -> Option<ResolvedAttachment> + Send + Sync>;

/// v1 `PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES` (packages/contracts/src/chatAttachment.ts:18-23).
const NATIVE_IMAGE_MIME_TYPES: [&str; 4] = ["image/gif", "image/jpeg", "image/png", "image/webp"];

/// v1 `isProviderNativeImageAttachment`.
pub fn is_native_image(attachment: &ChatAttachment) -> bool {
    attachment.kind == ChatAttachmentType::Image
        && NATIVE_IMAGE_MIME_TYPES.contains(&attachment.mime_type.as_str())
}

/// Build the Codex input for these messages. Errors carry v1's wording and mean nothing was sent.
pub fn codex_input(
    thread: &ThreadId,
    inputs: &[EngineInput],
    resolver: Option<&AttachmentResolver>,
) -> Result<Vec<UserInput>, String> {
    let resolve = |a: &ChatAttachment, bytes: bool| resolver.and_then(|r| r(thread, a, bytes));
    let mut text = skill_mention_text(
        &inputs
            .iter()
            .map(|input| input.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
    );
    let attachments: Vec<&ChatAttachment> =
        inputs.iter().flat_map(|i| i.attachments.iter()).collect();
    for attachment in &attachments {
        let kind = match attachment.kind {
            ChatAttachmentType::Image => "image",
            ChatAttachmentType::File => "file",
        };
        let context = match resolve(attachment, false) {
            Some(found) => format!(
                "[Attached {kind} \"{}\" is saved at: {}]",
                attachment.name,
                found.path.display()
            ),
            None => format!(
                "[Attached {kind} \"{}\" is unavailable: could not resolve a saved path for attachment '{}'.]",
                attachment.name, attachment.id
            ),
        };
        text = if text.is_empty() {
            context
        } else {
            format!("{text}\n\n{context}")
        };
    }
    let mut items = Vec::new();
    if !text.is_empty() {
        items.push(UserInput::text(text));
    }
    for attachment in attachments.into_iter().filter(|a| is_native_image(a)) {
        let found = resolve(attachment, true)
            .ok_or_else(|| format!("Invalid attachment id '{}'", attachment.id))?;
        let bytes = found
            .bytes
            .ok_or_else(|| format!("Failed to read attachment '{}'.", attachment.id))?;
        items.push(UserInput::Image {
            url: format!("data:{};base64,{}", attachment.mime_type, base64(&bytes)),
        });
    }
    if items.is_empty() {
        return Err("Turn requires non-empty text or attachments.".into());
    }
    Ok(items)
}

/// Unicode general category Sc (currency symbols), the `\p{Sc}` of v1's skill pattern.
fn is_currency_symbol(c: char) -> bool {
    matches!(c as u32,
        0x24 | 0xA2..=0xA5 | 0x58F | 0x60B | 0x7FE..=0x7FF | 0x9F2..=0x9F3 | 0x9FB | 0xAF1
        | 0xBF9 | 0xE3F | 0x17DB | 0x20A0..=0x20C0 | 0xA838 | 0xFDFC | 0xFE69 | 0xFF04
        | 0xFFE0..=0xFFE1 | 0xFFE5..=0xFFE6 | 0x11FDD..=0x11FE0 | 0x1E2FF | 0x1ECB0)
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-')
}

/// `€5k`, `$12`, `£3e4` stay money: v1's negative lookahead
/// `[0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$)`.
fn looks_like_amount(rest: &[char]) -> bool {
    let mut i = 0;
    if !rest.first().is_some_and(char::is_ascii_digit) {
        return false;
    }
    while rest.get(i).is_some_and(|c| c.is_ascii_digit() || *c == '_') {
        i += 1;
    }
    let ends = |j: usize| rest.get(j).is_none_or(|c| c.is_whitespace());
    if ends(i) {
        return true;
    }
    match rest[i] {
        'k' | 'K' | 'm' | 'M' | 'b' | 'B' | 't' | 'T' => ends(i + 1),
        'e' | 'E' => {
            let mut j = i + 1;
            if !rest.get(j).is_some_and(char::is_ascii_digit) {
                return false;
            }
            while rest.get(j).is_some_and(char::is_ascii_digit) {
                j += 1;
            }
            ends(j)
        }
        _ => false,
    }
}

/// v1 `codexSkillMentionText`: `(^|\s)\p{Sc}name(?=\s|$)` -> `$1$name`.
pub fn skill_mention_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let at_boundary = i == 0 || chars[i - 1].is_whitespace();
        if at_boundary && is_currency_symbol(c) {
            let rest = &chars[i + 1..];
            let len = rest.iter().take_while(|c| is_name_char(**c)).count();
            let name = &rest[..len];
            let matches = len > 0
                && name[0].is_ascii_alphanumeric()
                && name.iter().any(char::is_ascii_alphabetic)
                && rest.get(len).is_none_or(|c| c.is_whitespace())
                && !looks_like_amount(rest);
            if matches {
                out.push('$');
                out.extend(name);
                i += 1 + len;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Standard base64 with padding (no extra dependency for one encoder).
fn base64(bytes: &[u8]) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), expected);
        }
    }

    #[test]
    fn skill_mentions_follow_v1_pattern() {
        assert_eq!(skill_mention_text("€review this"), "$review this");
        assert_eq!(skill_mention_text("use £plan-v2"), "use $plan-v2");
        assert_eq!(skill_mention_text("€a €b"), "$a $b");
        // Money and non-tokens stay.
        assert_eq!(skill_mention_text("costs €5k now"), "costs €5k now");
        assert_eq!(skill_mention_text("€12 and $3e4"), "€12 and $3e4");
        assert_eq!(skill_mention_text("x€review"), "x€review");
        assert_eq!(skill_mention_text("€review."), "€review.");
        assert_eq!(skill_mention_text("€_x"), "€_x");
        // A name needs a letter; digits followed by letters are a name.
        assert_eq!(skill_mention_text("€123"), "€123");
        assert_eq!(skill_mention_text("€1password"), "$1password");
        assert_eq!(skill_mention_text("$review"), "$review");
    }
}
