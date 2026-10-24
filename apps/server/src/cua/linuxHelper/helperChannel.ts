// Frames are decoded with the protocol schemas; JSON.parse only finds a frame's id for a refusal.
// @effect-diagnostics preferSchemaOverJson:off
import {
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseHello,
  ComputerUseObservation,
  ComputerUseRequestFrame,
  computerUseReplyImageProblem,
  negotiateComputerUseVersion,
  type ComputerUseCapabilities,
  type ComputerUseHelperBinding,
  type ComputerUseHelloReply,
  type ComputerUseRefusal,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

import type { LinuxHelper } from "./LinuxComputerUseHelper.ts";

/**
 * The helper's end of the stdio channel (D8): NDJSON, the client's hello first, then request
 * frames answered once each. A screenshot rides beside its result as `image`, so the result
 * itself never carries pixels (D3). The pipe is the authentication: only the process that
 * spawned the helper holds its stdin and stdout.
 */

const decodeHello = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseHello));
const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseRequestFrame));
const decodeObservation = Schema.decodeUnknownOption(ComputerUseObservation);

/** The observation a result declares a screenshot in: the result itself or an action's diff. */
const observationOf = (result: unknown) => {
  const direct = decodeObservation(result);
  if (direct._tag === "Some") return direct.value;
  const nested =
    typeof result === "object" && result !== null && "observation" in result
      ? decodeObservation(result.observation)
      : undefined;
  return nested?._tag === "Some" ? nested.value : undefined;
};

const refusal = (reason: ComputerUseRefusal["reason"], message: string): ComputerUseRefusal => ({
  outcome: "refused",
  reason,
  message,
});

/** A frame's id, when it has one, so even a refused frame gets its answer. */
const frameId = (line: string): string | undefined => {
  try {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    return typeof id === "string" && id.trim() !== "" ? id : undefined;
  } catch {
    return /^\s*\{\s*"id"\s*:\s*"([^"]{1,200})"/u.exec(line)?.[1];
  }
};

const NEWLINE = 0x0a;
/**
 * Room every reply needs beyond the request's id: generation, result and a refusal message.
 * Requests are held this far below the frame limit so even the reply to the largest request fits.
 */
const ENVELOPE_RESERVE = 4096;

/**
 * Splits input into lines without holding more than maxBytes of one: a longer line is dropped
 * as it streams in, and only its first bytes are kept to find its id.
 */
function boundedLines(
  input: NodeJS.ReadableStream,
  maxBytes: number,
  handlers: {
    readonly line: (line: string) => void;
    readonly oversized: (prefix: string) => void;
    readonly end: () => void;
  },
) {
  let parts: Buffer[] = [];
  let size = 0;
  let overflow: string | undefined;
  input.on("data", (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    while (data.length > 0) {
      const newline = data.indexOf(NEWLINE);
      const piece = newline === -1 ? data : data.subarray(0, newline);
      if (overflow === undefined) {
        if (size + piece.length + 1 > maxBytes) {
          overflow = Buffer.concat([...parts, piece])
            .subarray(0, 512)
            .toString("utf8");
          parts = [];
          size = 0;
        } else {
          parts.push(piece);
          size += piece.length;
        }
      }
      if (newline === -1) break;
      if (overflow !== undefined) handlers.oversized(overflow);
      else handlers.line(Buffer.concat(parts).toString("utf8").replace(/\r$/u, ""));
      parts = [];
      size = 0;
      overflow = undefined;
      data = data.subarray(newline + 1);
    }
  });
  input.once("end", handlers.end);
  input.once("close", handlers.end);
}

export function serveHelperChannel(options: {
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  readonly binding: ComputerUseHelperBinding;
  readonly capabilities: ComputerUseCapabilities;
  readonly maxFrameBytes: number;
  readonly helper: LinuxHelper;
}): Promise<void> {
  const { binding, maxFrameBytes } = options;
  const fits = (line: string) => Buffer.byteLength(line) + 1 <= maxFrameBytes;
  const send = (value: object) => options.write(JSON.stringify(value) + "\n");
  const reply = (
    id: string,
    result: unknown,
    offered?: { readonly mimeType: string; readonly data: string },
  ) => {
    // An image goes only with an observation that declares a screenshot of its type, and never
    // with a private one; otherwise it is left out rather than shown against the wrong state.
    const image =
      offered && computerUseReplyImageProblem(observationOf(result), offered) === undefined
        ? offered
        : undefined;
    const frame = (value: unknown, withImage: boolean) =>
      JSON.stringify({
        id,
        generation: binding.generation,
        result: value,
        ...(withImage && image ? { image } : {}),
      });
    const whole = frame(result, true);
    if (fits(whole)) return options.write(whole + "\n");
    // Input that was sent keeps its outcome; only the evidence too large to carry is left out,
    // and the agent observes again before acting.
    const sent =
      typeof result === "object" &&
      result !== null &&
      "outcome" in result &&
      result.outcome !== "refused";
    if (sent) {
      const { observation: _observation, ...rest } = result as Record<string, unknown>;
      const trimmed = frame(
        {
          ...rest,
          detail:
            "The screenshot and observation were larger than this channel allows. Observe again.",
        },
        false,
      );
      if (fits(trimmed)) return options.write(trimmed + "\n");
    }
    const fallback = JSON.stringify({
      id,
      generation: binding.generation,
      result: sent
        ? {
            outcome: "unverifiable",
            dispatch: "dispatched_unknown",
            delivery: (result as { delivery?: unknown }).delivery ?? "background",
            detail: "The answer was larger than this channel allows. Observe again.",
          }
        : refusal(
            "frameTooLarge",
            "The answer is larger than this channel's " +
              maxFrameBytes +
              " byte limit. Ask for a smaller screenshot.",
          ),
    });
    // Requests are capped below the frame limit (see ENVELOPE_RESERVE), so this always fits;
    // a reply that still would not is not sent, and the client's deadline answers for it.
    if (fits(fallback)) options.write(fallback + "\n");
  };

  let greeted = false;
  let open = true;
  return new Promise((resolve) => {
    const finish = () => {
      if (!open) return;
      open = false;
      // A closed stdin is the launcher ending every session: stop the driver now.
      void options.helper.close().then(resolve, resolve);
    };
    boundedLines(options.input, maxFrameBytes - ENVELOPE_RESERVE, {
      end: finish,
      oversized: (prefix) => {
        if (!open) return;
        // An oversized hello ends the channel like any other bad hello.
        if (!greeted) {
          greeted = true;
          send(refusal("frameTooLarge", "The hello is larger than " + maxFrameBytes + " bytes."));
          return finish();
        }
        const id = frameId(prefix);
        if (id)
          reply(
            id,
            refusal(
              "frameTooLarge",
              "That request is larger than this channel's " + maxFrameBytes + " byte limit.",
            ),
          );
      },
      line: (line) => {
        if (!open) return;
        if (!greeted) {
          greeted = true;
          const hello = decodeHello(line);
          const negotiated =
            hello._tag === "None"
              ? refusal("invalidRequest", "The first frame must be a hello.")
              : negotiateComputerUseVersion(hello.value.clientApiVersion);
          if (negotiated !== true) {
            send(negotiated);
            return finish();
          }
          send({
            serverApiVersion: COMPUTER_USE_PROTOCOL_VERSION,
            binding,
            capabilities: options.capabilities,
            maxFrameBytes,
          } satisfies ComputerUseHelloReply);
          return;
        }
        const frame = decodeFrame(line);
        if (frame._tag === "None") {
          const id = frameId(line);
          if (id) reply(id, refusal("invalidRequest", "That frame does not match the protocol."));
          return;
        }
        const { id, generation, method, params, deadlineMs } = frame.value;
        if (generation !== binding.generation) {
          reply(
            id,
            refusal(
              "invalidRequest",
              "That request names helper generation " +
                generation +
                ", and this helper is " +
                binding.generation +
                ".",
            ),
          );
          return;
        }
        void options.helper.handle(method, params, deadlineMs).then(
          (answer) => reply(id, answer.result, answer.image),
          (error: unknown) =>
            reply(
              id,
              refusal(
                "helperUnavailable",
                error instanceof Error ? error.message : "The helper failed.",
              ),
            ),
        );
      },
    });
  });
}
