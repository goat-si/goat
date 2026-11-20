// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { guardErrors } from "@goat/shared/errorGuards";

export function isRegularFile(fd: number): boolean {
  try {
    return NodeFS.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024;

export function appendOutput(source: NodeJS.ReadableStream, fd: number): void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let writing = false;
  const flush = () => {
    if (pending.length === 0) {
      writing = false;
      return;
    }
    writing = true;
    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    const write = (offset: number) => {
      NodeFS.write(fd, chunk, offset, chunk.length - offset, null, (error, written) => {
        if (!error && written > 0 && offset + written < chunk.length) write(offset + written);
        else flush();
      });
    };
    write(0);
  };
  guardErrors(source, () => {}).on("data", (chunk: Buffer) => {
    if (pendingBytes + chunk.length > MAX_PENDING_OUTPUT_BYTES) return;
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (!writing) flush();
  });
}
