// Frames are decoded with the protocol schemas; JSON.parse only finds a frame's id for a refusal.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeReadline from "node:readline";

import {
  COMPUTER_USE_PROTOCOL_VERSION,
  ComputerUseHello,
  ComputerUseRequestFrame,
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

export function serveHelperChannel(options: {
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  readonly binding: ComputerUseHelperBinding;
  readonly capabilities: ComputerUseCapabilities;
  readonly maxFrameBytes: number;
  readonly helper: LinuxHelper;
}): Promise<void> {
  const { binding, maxFrameBytes } = options;
  const send = (value: object) => options.write(JSON.stringify(value) + "\n");
  const reply = (
    id: string,
    result: unknown,
    image?: { readonly mimeType: string; readonly data: string },
  ) => {
    const line = JSON.stringify({
      id,
      generation: binding.generation,
      result,
      ...(image ? { image } : {}),
    });
    if (Buffer.byteLength(line) + 1 <= maxFrameBytes) return options.write(line + "\n");
    send({
      id,
      generation: binding.generation,
      result: refusal(
        "frameTooLarge",
        "The answer is larger than this channel's " +
          maxFrameBytes +
          " byte limit. Ask for a smaller screenshot.",
      ),
    });
  };

  let greeted = false;
  const lines = NodeReadline.createInterface({ input: options.input, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!greeted) {
      greeted = true;
      const hello = decodeHello(line);
      const negotiated =
        hello._tag === "None"
          ? refusal("invalidRequest", "The first frame must be a hello.")
          : negotiateComputerUseVersion(hello.value.clientApiVersion);
      if (negotiated !== true) {
        send(negotiated);
        lines.close();
        return;
      }
      send({
        serverApiVersion: COMPUTER_USE_PROTOCOL_VERSION,
        binding,
        capabilities: options.capabilities,
        maxFrameBytes,
      } satisfies ComputerUseHelloReply);
      return;
    }
    if (Buffer.byteLength(line) + 1 > maxFrameBytes) {
      const id = frameId(line.slice(0, 512));
      if (id)
        reply(
          id,
          refusal(
            "frameTooLarge",
            "That request is larger than this channel's " + maxFrameBytes + " byte limit.",
          ),
        );
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
  });
  // A closed stdin is the launcher ending every session: stop the driver now.
  return new Promise((resolve) =>
    lines.once("close", () => void options.helper.close().then(resolve, resolve)),
  );
}
