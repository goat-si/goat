import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  normalizeMarkdownLinkDestination,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "./markdownLinks.ts";
import { parseFileUrlHref } from "./fileLinks.ts";
import remarkRehype from "remark-rehype";
import { CHAT_MARKDOWN_REMARK_PLUGINS, CHAT_MARKDOWN_REHYPE_PLUGINS } from "./markdownPipeline.ts";
import {
  isUncPath,
  isWindowsDrivePath,
  normalizeProjectPathForComparison,
  stripSlashPrefixedWindowsDrive,
} from "./path.ts";

const parser = unified().use(remarkParse);
const imageSourceProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

type ImageNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: ImageNode[];
};

function chatMarkdownImageSources(markdown: string): string[] {
  const sources: string[] = [];
  const visit = (node: ImageNode) => {
    if (node.type === "element" && node.tagName === "img") {
      const { src, dataLocalSrc } = node.properties ?? {};
      if (typeof dataLocalSrc === "string") {
        sources.push(normalizeMarkdownLinkDestination(dataLocalSrc).replaceAll("\\", "/"));
      } else if (typeof src === "string") {
        sources.push(normalizeMarkdownLinkDestination(src));
      }
    }
    node.children?.forEach(visit);
  };
  visit(imageSourceProcessor.runSync(imageSourceProcessor.parse(markdown)) as ImageNode);
  return sources;
}

function markdownDestinationHostPath(source: string): string | null {
  const target = /^file:/i.test(source)
    ? parseFileUrlHref(source)
    : splitMarkdownLinkSearchAndHash(source);
  return target === null
    ? null
    : stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path));
}

function imageEmbed(path: string, alt: string): string {
  // Forward slashes read the same in every client parser; UNC paths also need file: to
  // distinguish them from protocol-relative web URLs.
  const destination = isWindowsDrivePath(path)
    ? path.replaceAll("\\", "/")
    : isUncPath(path)
      ? `file:${path.replaceAll("\\", "/")}`
      : path;
  // Clients split `?`/`#`, decode `%` and `&` entities, and read POSIX backslashes as escapes;
  // line breaks end an angle destination.
  const escaped = destination.replace(/[%?#&\\\r\n]/g, encodeURIComponent).replace(/[<>]/g, "\\$&");
  return `![${alt}](<${escaped}>)`;
}

// An unclosed fence or raw HTML block swallows the rest of the reply. Only a root-level block
// can swallow appended embeds; nested ones end with their container.
function unclosedBlockEnd(text: string): string | undefined {
  const last = parser.parse(text).children.at(-1);
  const source = text.slice(last?.position?.start.offset, last?.position?.end.offset);
  if (last?.type === "html") {
    const tag = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(source)?.[1];
    if (tag !== undefined) {
      return /<\/(?:script|pre|style|textarea)>/i.test(source) ? undefined : `</${tag}>`;
    }
    return /^ {0,3}<!--/.test(source) && !source.includes("-->") ? "-->" : undefined;
  }
  if (last?.type !== "code") return undefined;
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(source)?.[1];
  if (fence === undefined) return undefined;
  const lines = source.split(/\r\n|\r|\n/);
  const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(lines.at(-1) ?? "")?.[1];
  const closed =
    lines.length > 1 &&
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length;
  return closed ? undefined : fence;
}

/** Appends an embed for each saved image the reply does not already show. */
export function appendGeneratedImageEmbeds(
  text: string,
  savedPaths: Iterable<string>,
  alt = "",
): string {
  const shown = new Set(
    chatMarkdownImageSources(text).flatMap((source) => {
      const path = markdownDestinationHostPath(source);
      return path === null ? [] : [normalizeProjectPathForComparison(path)];
    }),
  );
  const missing = new Map<string, string>();
  for (const path of savedPaths) {
    const key = normalizeProjectPathForComparison(path);
    if (!shown.has(key) && !missing.has(key)) missing.set(key, path);
  }
  if (missing.size === 0) return text;
  const end = unclosedBlockEnd(text);
  let result = end === undefined ? text : `${text}${/[\r\n]$/.test(text) ? "" : "\n"}${end}`;
  for (const path of missing.values()) {
    result += `${result.length > 0 ? "\n\n" : ""}${imageEmbed(path, alt)}`;
  }
  return result;
}
