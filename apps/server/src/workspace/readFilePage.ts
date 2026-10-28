// @effect-diagnostics nodeBuiltinImport:off -- Positioned bounded reads require a file descriptor.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import type { AgentWorkspaceReadResult, ProjectTextFormat } from "@goat/contracts";
import { AGENT_TEXT_MAX_BYTES } from "@goat/contracts";
import { workspaceFileVersion } from "./atomicWorkspaceWrite.ts";

export async function readFilePage(input: {
  readonly absolutePath: string | null;
  readonly path: string;
  readonly offset?: number;
  readonly maxBytes?: number;
}): Promise<AgentWorkspaceReadResult> {
  const offset = input.offset ?? 0;
  const maxBytes = Math.min(input.maxBytes ?? 8192, AGENT_TEXT_MAX_BYTES);
  if (input.absolutePath === null)
    return {
      path: input.path,
      exists: false,
      contents: "",
      byteLength: 0,
      offset,
      nextOffset: offset,
      eof: true,
    };
  const handle = await NodeFSP.open(
    input.absolutePath,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NONBLOCK ?? 0) |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new TypeError("Only regular files can be read.");
    const size = Number(before.size);
    if (offset > size) throw new RangeError("Offset is past the end of the file.");
    const buffer = Buffer.alloc(Math.min(maxBytes + 4, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new TypeError("Binary text is unsupported.");
    if (bytes.length > 0 && ((bytes[0] ?? 0) & 0xc0) === 0x80)
      throw new RangeError("Offset must be a UTF-8 code point boundary.");
    let end = Math.min(bytes.length, maxBytes);
    while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    if (bytes.length > 0 && end === 0)
      throw new RangeError("Budget is smaller than the next UTF-8 code point.");
    const page = bytes.subarray(0, end);
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(page);
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("The file changed during this read.");
    const eof = offset + end === size;
    const crlf = /\r\n/.test(contents),
      lf = /(?<!\r)\n/.test(contents),
      cr = /\r(?!\n)/.test(contents);
    const textFormat: ProjectTextFormat = {
      encoding: "utf-8",
      bom: offset === 0 && page[0] === 0xef && page[1] === 0xbb && page[2] === 0xbf,
      lineEnding:
        Number(crlf) + Number(lf) + Number(cr) > 1 ? "mixed" : crlf ? "crlf" : cr ? "cr" : "lf",
    };
    return {
      path: input.path,
      exists: true,
      contents,
      byteLength: size,
      offset,
      nextOffset: offset + end,
      eof,
      textFormat,
      ...(offset === 0 && eof && size <= AGENT_TEXT_MAX_BYTES
        ? { version: workspaceFileVersion(page) }
        : {}),
    };
  } finally {
    await handle.close();
  }
}
