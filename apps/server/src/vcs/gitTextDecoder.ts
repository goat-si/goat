const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8Decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const gb18030Decoder = new TextDecoder("gb18030", { ignoreBOM: true });

// A byte cap can cut the last UTF-8 character; that tail is not evidence of another encoding.
const decodeStrictUtf8 = (bytes: Uint8Array, truncated: boolean): string => {
  if (!truncated) return strictUtf8Decoder.decode(bytes);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const text = decoder.decode(bytes, { stream: true });
  try {
    return text + decoder.decode();
  } catch {
    return `${text}\uFFFD`;
  }
};

const decodeUtf8OrGb18030 = (bytes: Uint8Array, truncated: boolean): string => {
  try {
    return decodeStrictUtf8(bytes, truncated);
  } catch {
    const fallback = gb18030Decoder.decode(bytes);
    return fallback.includes("\uFFFD") ? lenientUtf8Decoder.decode(bytes) : fallback;
  }
};

// Git emits file bytes as stored; without a working-tree-encoding attribute, GBK/GB18030
// sources are not UTF-8. Decode per LF line or NUL record (`-z` output) so one such file or
// path does not garble UTF-8 neighbours.
export const decodeGitText = (bytes: Uint8Array, truncated = false): string => {
  try {
    return decodeStrictUtf8(bytes, truncated);
  } catch {
    let text = "";
    let start = 0;
    while (start < bytes.length) {
      let end = start;
      while (end < bytes.length && bytes[end] !== 0x0a && bytes[end] !== 0x00) end += 1;
      end = Math.min(end + 1, bytes.length);
      text += decodeUtf8OrGb18030(bytes.subarray(start, end), truncated && end === bytes.length);
      start = end;
    }
    return text;
  }
};
