import type { ProviderDriverKind, ProviderReplayTranscript } from "@goat/contracts";

import { buildRuntimeInstructions } from "@goat/provider-core/server/runtimeInstructions";

export function materializeReplayTranscriptRuntimeInstructions(
  transcript: ProviderReplayTranscript,
  runtime: { readonly driver: ProviderDriverKind; readonly model: string },
): ProviderReplayTranscript {
  const harness =
    runtime.driver === "cursor"
      ? "Cursor"
      : runtime.driver === "grok"
        ? "Grok"
        : runtime.driver === "acpRegistry"
          ? "acpRegistry"
          : runtime.driver === "fx"
            ? "fx"
            : undefined;
  if (harness === undefined) return transcript;
  const instructions = buildRuntimeInstructions({ harness, model: runtime.model });
  let cursorDelivered: string | undefined;
  let cursorPending: { instructions: string | undefined; compacted: boolean } | undefined;

  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (runtime.driver === "cursor" && entry.type === "emit_inbound") {
        const frame = entry.frame;
        if (typeof frame === "object" && frame !== null && "type" in frame) {
          if (
            frame.type === "interaction.update" &&
            "update" in frame &&
            typeof frame.update === "object" &&
            frame.update !== null &&
            "type" in frame.update &&
            frame.update.type === "summary-completed" &&
            !("failed" in frame.update && frame.update.failed === true)
          ) {
            cursorDelivered = undefined;
            if (cursorPending !== undefined) cursorPending.compacted = true;
          }
          if (frame.type === "run.completed" && cursorPending !== undefined) {
            const result = "result" in frame ? frame.result : undefined;
            const finished =
              typeof result === "object" &&
              result !== null &&
              "status" in result &&
              result.status === "finished";
            if (cursorPending.compacted) cursorDelivered = undefined;
            else if (cursorPending.instructions !== undefined)
              cursorDelivered = finished ? cursorPending.instructions : undefined;
            cursorPending = undefined;
          }
        }
        return entry;
      }
      if (entry.type !== "expect_outbound") return entry;
      const frame = entry.frame;
      if (typeof frame !== "object" || frame === null) return entry;
      if (runtime.driver === "cursor" && "type" in frame && frame.type === "agent.close") {
        cursorDelivered = undefined;
      }
      if (
        runtime.driver === "cursor" &&
        "type" in frame &&
        frame.type === "run.start" &&
        "message" in frame &&
        typeof frame.message === "string"
      ) {
        if (frame.message.trim() === "/compress") {
          cursorPending = { instructions: undefined, compacted: false };
          return entry;
        }
        const shouldSend = cursorDelivered !== instructions;
        cursorPending = { instructions: shouldSend ? instructions : undefined, compacted: false };
        return !shouldSend || frame.message.endsWith(instructions)
          ? entry
          : { ...entry, frame: { ...frame, message: `${frame.message}\n\n${instructions}` } };
      }
      if (
        "method" in frame &&
        frame.method === "session/prompt" &&
        "params" in frame &&
        typeof frame.params === "object" &&
        frame.params !== null &&
        "prompt" in frame.params &&
        Array.isArray(frame.params.prompt)
      ) {
        const prompt: ReadonlyArray<unknown> = frame.params.prompt;
        const lastPart = prompt.at(-1);
        if (
          typeof lastPart === "object" &&
          lastPart !== null &&
          "type" in lastPart &&
          lastPart.type === "text" &&
          "text" in lastPart &&
          lastPart.text === instructions
        ) {
          return entry;
        }
        return {
          ...entry,
          frame: {
            ...frame,
            params: { ...frame.params, prompt: [...prompt, { type: "text", text: instructions }] },
          },
        };
      }
      return entry;
    }),
  };
}
