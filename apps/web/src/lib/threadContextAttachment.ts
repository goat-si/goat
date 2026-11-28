import type { EnvironmentId, OrchestrationV2ThreadTranscript } from "@goat/contracts";
import { toKindScopedComposerContextId } from "@goat/shared/composerContextReferences";
import { threadTranscriptHeader } from "@goat/shared/threadTranscript";
import * as DateTime from "effect/DateTime";

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function threadContextAttachment(
  environmentId: EnvironmentId,
  transcript: OrchestrationV2ThreadTranscript,
): File {
  const updatedAt = DateTime.formatIso(transcript.updatedAt);
  const name = toKindScopedComposerContextId(
    "thread",
    `${environmentId}:${transcript.threadId}:${updatedAt}`,
  );
  const sanitized = transcript.title.replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const title = sanitized.slice(0, splitsSurrogatePair(sanitized, 64) ? 63 : 64) || "Thread";
  return new File(
    [
      threadTranscriptHeader(environmentId, transcript),
      ...transcript.items.map((row) => `${JSON.stringify(row)}\n`),
    ],
    `${title}-${name.slice(-16)}.jsonl`,
    { type: "application/x-ndjson" },
  );
}
