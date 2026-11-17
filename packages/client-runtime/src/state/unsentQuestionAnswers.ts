/**
 * Rules for answers a person typed to an agent's question but never sent, shared by every client
 * surface that answers questions (the thread composer and the Decisions inbox).
 */

/** `/side` or `/side <question>` sent from a thread's composer. */
export function parseSideChatCommand(text: string): { readonly prompt: string } | null {
  const match = /^\/side(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { prompt: match[1]?.trim() ?? "" };
}

/**
 * \`/side\` asks in the side chat, so typed while a question is open it opens the side chat and
 * leaves the question pending. Where no side chat can start, or the answer carries attachments
 * or context, the text stays a literal answer.
 */
export function sideChatCommandOverAnswer(input: {
  readonly answer: string;
  readonly sideChatAvailable: boolean;
  readonly hasAttachmentsOrContext: boolean;
}): { readonly prompt: string } | null {
  if (!input.sideChatAvailable || input.hasAttachmentsOrContext) return null;
  return parseSideChatCommand(input.answer.trim());
}

/** The question draft keys under `prefix` that hold attachments or chips for one of `requestIds`. */
export function questionDraftKeysForRequests(
  keys: Iterable<string>,
  prefix: string,
  requestIds: ReadonlySet<string>,
): string[] {
  return [...keys].flatMap((key) => {
    if (!key.startsWith(prefix)) return [];
    try {
      const [requestId] = JSON.parse(decodeURIComponent(key.slice(prefix.length))) as unknown[];
      return typeof requestId === "string" && requestIds.has(requestId) ? [key] : [];
    } catch {
      return [];
    }
  });
}
