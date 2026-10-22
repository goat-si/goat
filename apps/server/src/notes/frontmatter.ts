import { ThreadId, type NoteAuthor, type NoteStatus, type NoteThreadLink } from "@goat/contracts";
import { isMap, isSeq, parseDocument, stringify, type Document } from "yaml";

export interface NoteContents {
  readonly body: string;
  readonly status: NoteStatus;
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
  const threadNode = metadata?.get("threads", true);
  const rawThreads: unknown = isSeq(threadNode) ? threadNode.toJSON() : [];
  const threads: Array<NoteThreadLink> = [];
  for (const entry of Array.isArray(rawThreads) ? rawThreads : []) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    const split = entry.lastIndexOf("@");
    const threadId = split < 0 ? entry : entry.slice(0, split);
    const host = split < 0 ? null : entry.slice(split + 1);
    if (!threadId.trim() || (host !== null && !host.trim())) continue;
    threads.push({ threadId: ThreadId.make(threadId), host, lastResult: null });
  }
  return {
    body: match ? contents.slice(match[0].length) : contents,
    status: status === "doing" || status === "done" ? status : "idea",
    threads,
    updatedBy: updatedBy === "user" || updatedBy === "agent" ? updatedBy : null,
    metadata,
  };
}

export function serializeNote(note: NoteContents): string {
  const metadata = note.metadata?.clone();
  const fields = {
    status: note.status,
    threads: note.threads.map((link) =>
      link.host === null ? link.threadId : `${link.threadId}@${link.host}`,
    ),
    updatedBy: note.updatedBy,
  };
  if (metadata) for (const [key, value] of Object.entries(fields)) metadata.set(key, value);
  return `---\n${metadata ? metadata.toString() : stringify(fields)}---\n${note.body}`;
}
