#!/usr/bin/env node
// engine-helper entry: stdio JSONL server for one engine session (see ../PROTOCOL.md).
import * as Util from "node:util";

import { engineLoaders } from "./engines.ts";
import { createServer } from "./server.ts";
import { classifyRejection } from "./rejections.ts";

// stdout belongs to the protocol. Anything else that writes there (SDK logging, console.*) goes to
// stderr, before any SDK loads.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
  (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
for (const method of ["log", "info", "debug", "warn", "error", "trace"] as const) {
  console[method] = (...args: unknown[]) => {
    process.stderr.write(`${Util.format(...args)}\n`);
  };
}

const server = createServer({
  engines: engineLoaders,
  write: (line, done) => {
    protocolWrite(`${line}\n`, done === undefined ? undefined : () => done());
  },
  exit: (code) => process.exit(code),
});

process.on("uncaughtException", (error) => {
  server.fail(`engine-helper crashed: ${error instanceof Error ? error.message : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  const benign = classifyRejection(reason);
  if (benign !== undefined) {
    server.log("warn", benign);
    return;
  }
  server.fail(`engine-helper crashed: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// Readline splits on U+2028/U+2029 too (v1 provider-pi/src/server/rpc.ts:1), so frame by LF only.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    server.handleLine(line);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffer.length > 0) server.handleLine(buffer);
  buffer = "";
  void server.close();
});
