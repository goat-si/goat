import { describe, expect, it } from "vitest";
import { decodeGitText } from "./gitTextDecoder.ts";

describe("Git text decoding", () => {
  it("decodes GB18030 lines alongside UTF-8 and preserves the BOM", () => {
    const bytes = Buffer.concat([
      Buffer.from("\uFEFFemoji 😀\n"),
      Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a]),
    ]);
    expect(decodeGitText(bytes)).toBe("\uFEFFemoji 😀\n你好\n");
  });
  it("does not mistake a truncated UTF-8 character for another encoding", () => {
    expect(decodeGitText(Buffer.from([0x61, 0xf0, 0x9f]), true)).toBe("a�");
  });
});
