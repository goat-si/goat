import * as RpcSerialization from "effect/rpc/RpcSerialization";

// ndJsonRpc skips lines that are not JSON. A malformed agent line has to end the
// session, so frames are split here and each one goes through the strict codec.
export const makeStrictNdJsonRpcParser = () => {
  const codec = RpcSerialization.jsonRpc().makeUnsafe();
  const decoder = new TextDecoder();
  const maxFrameCharacters = 16 * 1024 * 1024;
  let fragments: Array<string> = [];
  let pendingCharacters = 0;
  return {
    decode: (bytes: Uint8Array | string): ReadonlyArray<unknown> => {
      const chunk = typeof bytes === "string" ? bytes : decoder.decode(bytes, { stream: true });
      const lines = chunk.split("\n");
      const decoded: Array<unknown> = [];
      for (const [index, fragment] of lines.entries()) {
        pendingCharacters += fragment.length;
        if (pendingCharacters > maxFrameCharacters) {
          throw new Error("ACP frame exceeds the maximum size");
        }
        if (fragment.length > 0) fragments.push(fragment);
        if (index < lines.length - 1) {
          decoded.push(...codec.decode(fragments.join("")));
          fragments = [];
          pendingCharacters = 0;
        }
      }
      return decoded;
    },
    end: (): ReadonlyArray<unknown> => {
      const suffix = decoder.decode();
      if (pendingCharacters + suffix.length > maxFrameCharacters)
        throw new Error("ACP frame exceeds the maximum size");
      const line = fragments.join("") + suffix;
      fragments = [];
      pendingCharacters = 0;
      try {
        return line.trim() === "" ? [] : codec.decode(line);
      } catch {
        return [];
      }
    },
    encode: (response: Parameters<typeof codec.encode>[0]) => {
      const encoded = codec.encode(response);
      return encoded === undefined ? undefined : `${encoded}\n`;
    },
  };
};
