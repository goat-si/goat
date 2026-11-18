import * as Schema from "effect/Schema";
import * as AcpSchema from "../schema.ts";
import * as AcpError from "../errors.ts";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

/** A decoded wire message and the length of the JSON line it arrived on. */
export interface AcpDecodedWireMessage {
  readonly message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded;
  readonly lineLength: number;
}

// ndJsonRpc skips lines that are not JSON. A malformed agent line has to end the
// session, so frames are split here and each one goes through the strict codec.
export const makeStrictNdJsonRpcParser = () => {
  const codec = RpcSerialization.jsonRpc().makeUnsafe();
  const decoder = new TextDecoder();
  const maxFrameCharacters = 16 * 1024 * 1024;
  let fragments: Array<string> = [];
  let pendingCharacters = 0;
  return {
    // Every message in a batch line is charged the whole line.
    decode: (bytes: Uint8Array | string): ReadonlyArray<AcpDecodedWireMessage> => {
      const chunk = typeof bytes === "string" ? bytes : decoder.decode(bytes, { stream: true });
      const lines = chunk.split("\n");
      const decoded: Array<AcpDecodedWireMessage> = [];
      for (const [index, fragment] of lines.entries()) {
        pendingCharacters += fragment.length;
        if (pendingCharacters > maxFrameCharacters) {
          throw new Error("ACP frame exceeds the maximum size");
        }
        if (fragment.length > 0) fragments.push(fragment);
        if (index < lines.length - 1) {
          const line = fragments.join("");
          // Every message in a batch line is charged the whole line.
          decoded.push(
            ...codec.decode(line).map((message) => ({
              message: message as RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
              lineLength: line.length,
            })),
          );
          fragments = [];
          pendingCharacters = 0;
        }
      }
      return decoded;
    },
    end: (): ReadonlyArray<AcpDecodedWireMessage> => {
      const suffix = decoder.decode();
      if (pendingCharacters + suffix.length > maxFrameCharacters)
        throw new Error("ACP frame exceeds the maximum size");
      const line = fragments.join("") + suffix;
      fragments = [];
      pendingCharacters = 0;
      try {
        // Every message in a batch line is charged the whole line.
        return line.trim() === ""
          ? []
          : codec.decode(line).map((message) => ({
              message: message as RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
              lineLength: line.length,
            }));
      } catch {
        return [];
      }
    },
    encode: (response: Parameters<typeof codec.encode>[0]) => {
      const encoded = codec.encode(response);
      if (encoded === undefined) return undefined;
      const json = typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded);
      if (!json.includes('"_tag":"Cause"')) return `${json}\n`;
      return `${JSON.stringify(normalizeOutgoingFrame(JSON.parse(json)))}\n`;
    },
  };
};

const isCauseResponse = Schema.is(
  Schema.Struct({ error: Schema.TaggedStruct("Cause", { data: Schema.Array(Schema.Unknown) }) }),
);
const isProtocolFailure = Schema.is(Schema.TaggedStruct("Fail", { error: AcpSchema.Error }));
const isInterruptReason = Schema.is(Schema.TaggedStruct("Interrupt", {}));

function normalizeOutgoingFrame(frame: unknown): unknown {
  if (Array.isArray(frame)) return frame.map(normalizeOutgoingFrame);
  if (!isCauseResponse(frame)) return frame;
  const reasons = frame.error.data.filter((reason) => !isInterruptReason(reason));
  const [failure] = reasons;
  const error =
    reasons.length === 1 && isProtocolFailure(failure)
      ? failure.error
      : AcpError.AcpRequestError.internalError().toProtocolError();
  return {
    ...frame,
    error: {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}
