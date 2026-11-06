/**
 * Embeds in note markdown: which files a note may load, and what a standalone image, link or URL
 * shows as. Notes keep plain markdown; signed URLs exist only while rendering.
 */

export const NOTE_ATTACHMENT_PATH_PATTERN = /^\.attachments\/[0-9a-f]{16}\.[a-z0-9]{1,10}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP = /^https?:\/\//i;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a"]);

/** "url" is a bare URL as written; "autolink" is one in angle brackets. */
export type NoteEmbedSyntax = "image" | "link" | "url" | "autolink";

export type NoteEmbed =
  | {
      readonly kind: "image" | "video" | "audio";
      readonly file: string | null;
      readonly url: string | null;
    }
  | { readonly kind: "file"; readonly file: string; readonly name: string }
  | {
      readonly kind: "player";
      readonly provider: string;
      readonly embedUrl: string;
      readonly url: string;
    }
  | { readonly kind: "link"; readonly url: string; readonly host: string; readonly path: string }
  | { readonly kind: "unsupported" };

/** The notes-root path of an attachment a note references, or null for anything else. */
export function resolveNoteFilePath(notePath: string, src: string): string | null {
  if (SCHEME.test(src) || src.startsWith("//")) return null;
  const segments = src.startsWith("/") ? [] : notePath.split("/").slice(0, -1);
  for (const raw of src.split("/")) {
    if (raw === "" || raw === ".") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  const path = segments.join("/");
  return NOTE_ATTACHMENT_PATH_PATTERN.test(path) ? path : null;
}

/**
 * How a note refers to an attachment: from the notes root, so the reference survives moving the
 * note between folders. Note-relative references written by hand resolve too.
 */
export function noteFileRef(file: string): string {
  return `/${file}`;
}

const extensionOf = (path: string) => /\.([a-z0-9]{1,10})$/i.exec(path)?.[1]?.toLowerCase() ?? "";

function httpUrl(src: string): URL | null {
  if (!HTTP.test(src)) return null;
  try {
    return new URL(src);
  } catch {
    return null;
  }
}

// Players come only from these templates with a validated id, never from the note's URL itself.
function player(url: URL): { provider: string; embedUrl: string } | null {
  const host = url.hostname.replace(/^(www\.|m\.)/, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "youtube.com" || host === "youtu.be" || host === "youtube-nocookie.com") {
    const id =
      host === "youtu.be"
        ? parts[0]
        : parts[0] === "watch"
          ? url.searchParams.get("v")
          : ["shorts", "embed", "live"].includes(parts[0] ?? "")
            ? parts[1]
            : undefined;
    return id && /^[\w-]{11}$/.test(id)
      ? { provider: "YouTube", embedUrl: `https://www.youtube-nocookie.com/embed/${id}` }
      : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = host === "vimeo.com" ? parts[0] : parts[0] === "video" ? parts[1] : undefined;
    return id && /^\d{1,20}$/.test(id)
      ? { provider: "Vimeo", embedUrl: `https://player.vimeo.com/video/${id}` }
      : null;
  }
  if (host === "loom.com" && (parts[0] === "share" || parts[0] === "embed")) {
    const id = parts[1];
    return id && /^[0-9a-f]{32}$/i.test(id)
      ? { provider: "Loom", embedUrl: `https://www.loom.com/embed/${id.toLowerCase()}` }
      : null;
  }
  return null;
}

export function classifyNoteEmbed(
  notePath: string,
  src: string,
  syntax: NoteEmbedSyntax,
  text = "",
): NoteEmbed {
  const file = resolveNoteFilePath(notePath, src);
  const url = file === null ? httpUrl(src) : null;
  if (file === null && url === null) return { kind: "unsupported" };
  if (syntax === "image") {
    const extension = extensionOf(file ?? url?.pathname ?? "");
    const media = VIDEO_EXTENSIONS.has(extension)
      ? "video"
      : AUDIO_EXTENSIONS.has(extension)
        ? "audio"
        : file !== null && !IMAGE_EXTENSIONS.has(extension)
          ? null
          : "image";
    if (media !== null) return { kind: media, file, url: url?.href ?? null };
  }
  if (file !== null)
    return { kind: "file", file, name: text || file.slice(file.lastIndexOf("/") + 1) };
  if (url === null) return { kind: "unsupported" };
  const embed = player(url);
  if (embed) return { kind: "player", ...embed, url: url.href };
  return { kind: "link", url: url.href, host: url.host, path: url.pathname + url.search };
}
