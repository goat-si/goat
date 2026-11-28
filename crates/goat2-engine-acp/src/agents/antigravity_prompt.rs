//! What Antigravity receives for a turn's attachments.
//!
//! v1 `buildAntigravityPrompt` (`apps/server/src/provider/acp/AntigravityAcpSupport.ts:356-597` at
//! 916b5ccc1b2): images, audio and text files inline when the agent takes them, PDFs (and MP4 on
//! the qualified 1.4.5 runtime with a Gemini model) as `resource_link`, everything else path-only
//! (the turn text already names the saved path). The shared driver puts the text block first.

use std::io::Read;
use std::path::Path;

use base64::Engine as _;
use goat2_contracts::ChatAttachmentType;
use serde_json::{Value, json};

use crate::flavor::PromptAttachment;
use crate::wire::InitializeInfo;

/// v1 `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` (contracts chatAttachment.ts:15).
pub const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// v1 `PROVIDER_SEND_TURN_MAX_FILE_BYTES` (contracts chatAttachment.ts:17).
pub const PROVIDER_SEND_TURN_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const ANTIGRAVITY_MAX_VIDEO_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

const IMAGE_MIME_TYPES: [&str; 4] = ["image/bmp", "image/jpeg", "image/png", "image/webp"];
const AUDIO_MIME_TYPES: [&str; 11] = [
    "audio/aac",
    "audio/flac",
    "audio/mp3",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
];
const TEXT_MIME_TYPES: [&str; 8] = [
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/x-sh",
];
const TEXT_FILE_EXTENSIONS: [&str; 47] = [
    ".txt", ".md", ".mdx", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv",
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".html", ".css", ".scss", ".less", ".py", ".rs",
    ".go", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php",
    ".sh", ".bash", ".zsh", ".sql", ".graphql", ".svelte", ".vue", ".log", ".diff", ".patch",
    ".ini", ".conf",
];

/// v1 `isQualifiedAntigravityRelease` (:92-98): the release GOAT qualified for native range reads
/// and linked video.
pub fn is_qualified_release(version: Option<&str>) -> bool {
    version.is_some_and(|v| v.trim() == "1.4.5")
}

/// v1 `antigravityModelAcceptsVideo` (:374-382): only Gemini takes video.
fn model_accepts_video(model: Option<(&str, Option<&str>)>) -> bool {
    model.is_some_and(|(id, name)| {
        id.to_ascii_lowercase().starts_with("gemini-")
            || name.is_some_and(|n| {
                let lower = n.to_ascii_lowercase();
                lower == "gemini"
                    || lower.starts_with("gemini")
                        && !lower[6..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
            })
    })
}

fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_default()
}

/// v1 TextDecoder with a BOM-chosen encoding (:574-587); None for other encodings or binary.
fn decode_text(bytes: &[u8]) -> Option<String> {
    let utf16 = |rest: &[u8], little: bool| -> Option<String> {
        if !rest.len().is_multiple_of(2) {
            return None;
        }
        let units = rest.chunks(2).map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        });
        char::decode_utf16(units)
            .collect::<Result<String, _>>()
            .ok()
    };
    let text = match bytes {
        [0xff, 0xfe, rest @ ..] => utf16(rest, true)?,
        [0xfe, 0xff, rest @ ..] => utf16(rest, false)?,
        _ => {
            let text = std::str::from_utf8(bytes).ok()?;
            text.strip_prefix('\u{feff}').unwrap_or(text).to_owned()
        }
    };
    (!text.contains('\0')).then_some(text)
}

/// The content blocks after the text for `attachments` (v1 `buildAntigravityPrompt` :469-590).
/// `current_model` is the session's model id and display name; `windows` keeps video path-only.
pub fn attachment_blocks(
    init: &InitializeInfo,
    current_model: Option<(&str, Option<&str>)>,
    attachments: &[PromptAttachment<'_>],
    windows: bool,
) -> Result<Vec<Value>, String> {
    let mut blocks = Vec::new();
    let mut total: u64 = 0;
    for PromptAttachment { attachment, path } in attachments {
        let name = attachment.name.as_str();
        let mime = attachment
            .mime_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let is_file = attachment.kind == ChatAttachmentType::File;
        let image = attachment.kind == ChatAttachmentType::Image
            && IMAGE_MIME_TYPES.contains(&mime.as_str());
        let audio = is_file && AUDIO_MIME_TYPES.contains(&mime.as_str());
        let pdf = is_file && mime == "application/pdf";
        let video = is_file
            && mime == "video/mp4"
            && is_qualified_release(init.agent_version.as_deref())
            // The agent drops Windows drives and UNC hosts from file URIs.
            && !windows
            && model_accepts_video(current_model);
        let text_file = is_file
            && (mime.starts_with("text/")
                || TEXT_MIME_TYPES.contains(&mime.as_str())
                || TEXT_FILE_EXTENSIONS.contains(&extension(name).as_str()));
        let path_only = (attachment.kind == ChatAttachmentType::Image
            && (!image || !init.prompt_image))
            || (is_file
                && if audio {
                    !init.prompt_audio
                } else if pdf || text_file {
                    !init.prompt_embedded_context
                } else {
                    !video
                });
        let Some(path) = path else {
            return Err(format!("Invalid attachment '{name}'."));
        };
        let unreadable = || format!("Could not read attachment '{name}'.");
        let info = std::fs::metadata(path).map_err(|_| unreadable())?;
        if !info.is_file() {
            return Err(unreadable());
        }
        if path_only {
            continue;
        }
        let size = info.len();
        let limit = if image {
            PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        } else if audio {
            ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES
        } else if pdf {
            MAX_TOTAL_ATTACHMENT_BYTES
        } else if video {
            ANTIGRAVITY_MAX_VIDEO_ATTACHMENT_BYTES
        } else {
            ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES
        };
        if is_file && (size > limit || total + size > MAX_TOTAL_ATTACHMENT_BYTES) {
            continue;
        }
        total += size;
        if size > limit || total > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(format!(
                "Image '{name}' is too large. Antigravity accepts images up to 10 MiB and 50 MiB of native attachments per message."
            ));
        }
        let uri = url::Url::from_file_path(path)
            .map_err(|_| format!("Invalid attachment '{name}'."))?
            .to_string();
        if pdf || video {
            blocks.push(json!({"type": "resource_link", "uri": uri, "name": name, "mimeType": mime, "size": size}));
            continue;
        }
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .and_then(|file| file.take(limit + 1).read_to_end(&mut bytes))
            .map_err(|_| unreadable())?;
        total = total + bytes.len() as u64 - size;
        if bytes.len() as u64 > limit || total > MAX_TOTAL_ATTACHMENT_BYTES {
            return Err(format!(
                "Attachment '{name}' changed while being read and is too large."
            ));
        }
        let data = || base64::engine::general_purpose::STANDARD.encode(&bytes);
        if image {
            blocks.push(json!({"type": "image", "data": data(), "mimeType": mime}));
        } else if audio {
            blocks.push(json!({"type": "audio", "data": data(), "mimeType": mime}));
        } else {
            // Other encodings and binary data stay path-only; the agent reads them itself.
            let Some(text) = decode_text(&bytes) else {
                total -= bytes.len() as u64;
                continue;
            };
            blocks.push(json!({"type": "resource", "resource": {"uri": uri, "mimeType": mime, "text": text}}));
        }
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use goat2_contracts::ChatAttachment;

    fn attachment(kind: ChatAttachmentType, name: &str, mime: &str) -> ChatAttachment {
        ChatAttachment {
            kind,
            id: name.into(),
            name: name.into(),
            mime_type: mime.into(),
            size_bytes: 0,
            blob: None,
        }
    }

    #[test]
    fn inline_what_the_agent_takes_and_link_pdfs() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        std::fs::write(&png, [1u8, 2, 3]).unwrap();
        let notes = dir.path().join("notes.md");
        std::fs::write(&notes, "# hi").unwrap();
        let pdf = dir.path().join("doc.pdf");
        std::fs::write(&pdf, b"%PDF").unwrap();
        let gif = dir.path().join("a.gif");
        std::fs::write(&gif, b"GIF").unwrap();
        let bin = dir.path().join("blob.txt");
        std::fs::write(&bin, [0u8, 1]).unwrap();
        let init = InitializeInfo {
            prompt_image: true,
            prompt_audio: true,
            prompt_embedded_context: true,
            ..Default::default()
        };
        let items = [
            attachment(ChatAttachmentType::Image, "a.png", "image/png"),
            attachment(
                ChatAttachmentType::File,
                "notes.md",
                "application/octet-stream",
            ),
            attachment(ChatAttachmentType::File, "doc.pdf", "application/pdf"),
            attachment(ChatAttachmentType::Image, "a.gif", "image/gif"),
            attachment(ChatAttachmentType::File, "blob.txt", "text/plain"),
        ];
        let paths = [&png, &notes, &pdf, &gif, &bin];
        let list: Vec<PromptAttachment<'_>> = items
            .iter()
            .zip(paths)
            .map(|(attachment, path)| PromptAttachment {
                attachment,
                path: Some(path.as_path()),
            })
            .collect();
        let blocks = attachment_blocks(&init, None, &list, false).unwrap();
        let kinds: Vec<&str> = blocks.iter().map(|b| b["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["image", "resource", "resource_link"]);
        assert_eq!(blocks[0]["data"], "AQID");
        assert_eq!(blocks[1]["resource"]["text"], "# hi");
        assert!(blocks[2]["uri"].as_str().unwrap().starts_with("file://"));

        let no_embed = InitializeInfo {
            prompt_image: true,
            ..Default::default()
        };
        assert_eq!(
            attachment_blocks(&no_embed, None, &list[1..3], false).unwrap(),
            Vec::<Value>::new()
        );
        let missing = [PromptAttachment {
            attachment: &items[0],
            path: None,
        }];
        assert_eq!(
            attachment_blocks(&init, None, &missing, false).unwrap_err(),
            "Invalid attachment 'a.png'."
        );
    }

    #[test]
    fn video_needs_the_qualified_runtime_and_gemini() {
        assert!(model_accepts_video(Some(("gemini-3.8-pro", None))));
        assert!(model_accepts_video(Some(("agy-model", Some("Gemini 3.8")))));
        assert!(!model_accepts_video(Some(("agy-model", Some("Claude")))));
        assert!(!model_accepts_video(Some(("agy-model", Some("Geminix")))));
        assert!(is_qualified_release(Some(" 1.4.5 ")));
        assert!(!is_qualified_release(Some("1.5.0")));
    }
}
