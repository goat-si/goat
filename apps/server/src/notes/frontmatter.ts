import {
  ThreadId,
  type NoteAuthor,
  type NoteStatus,
  type NoteThreadLink,
  type NoteThreadRef,
} from "@goat/contracts";
import { isMap, isSeq, parseDocument, stringify, type Document } from "yaml";

export interface NoteContents {
  readonly body: string;
  readonly status: NoteStatus;
  readonly pinned: boolean;
  readonly related: ReadonlyArray<NoteThreadRef>;
  readonly threads: ReadonlyArray<NoteThreadLink>;
  readonly updatedBy: NoteAuthor | null;
  readonly metadata: Document | null;
}

export function parseNote(contents: string): NoteContents {
  const candidate = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/mu.exec(contents);
  const match = candidate?.index === 0 ? candidate : null;
  const metadata = match ? parseDocument(match[1]!, { uniqueKeys: true }) : null;
  if (
    metadata &&
    (metadata.errors.length > 0 || (metadata.contents !== null && !isMap(metadata.contents)))
  )
    throw new Error("Invalid note frontmatter");
  const status = metadata?.get("status");
  const updatedBy = metadata?.get("updatedBy");
  const refs = (key: string): Array<NoteThreadRef> => {
    const node = metadata?.get(key, true);
    const raw: unknown = isSeq(node) ? node.toJSON() : [];
    return (Array.isArray(raw) ? raw : []).flatMap((entry: unknown) => {
      if (typeof entry !== "string" || entry.length === 0) return [];
      const split = entry.lastIndexOf("@");
      const threadId = split < 0 ? entry : entry.slice(0, split);
      const host = split < 0 ? null : entry.slice(split + 1);
      if (!threadId.trim() || (host !== null && !host.trim())) return [];
      return [{ threadId: ThreadId.make(threadId), host }];
    });
  };
  return {
    body: match ? contents.slice(match[0].length) : contents,
    status: status === "doing" || status === "done" ? status : "idea",
    pinned: metadata?.get("pinned") === true,
    related: refs("related"),
    threads: refs("threads").map((ref) => ({ ...ref, lastResult: null })),
    updatedBy: updatedBy === "user" || updatedBy === "agent" ? updatedBy : null,
    metadata,
  };
}

export function serializeNote(note: NoteContents): string {
  const metadata = note.metadata?.clone();
  const fields = {
    ...(note.pinned ? { pinned: true } : {}),
    ...(note.related.length > 0
      ? {
          related: note.related.map((ref) =>
            ref.host === null ? ref.threadId : `${ref.threadId}@${ref.host}`,
          ),
        }
      : {}),
    status: note.status,
    threads: note.threads.map((link) =>
      link.host === null ? link.threadId : `${link.threadId}@${link.host}`,
    ),
    updatedBy: note.updatedBy,
  };
  if (!note.pinned && isMap(metadata?.contents)) metadata.delete("pinned");
  if (note.related.length === 0 && isMap(metadata?.contents)) metadata.delete("related");
  if (metadata) for (const [key, value] of Object.entries(fields)) metadata.set(key, value);
  return `---\n${metadata ? metadata.toString() : stringify(fields)}---\n${note.body}`;
}
