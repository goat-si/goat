import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Probe from "./BrowserDriverCapabilityProbe.ts";

it.live("reads get_config structured content over the server driver connection", () =>
  Effect.gen(function* () {
    const read = yield* Probe.makeBrowserDriverGetConfig();
    const script = `
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
        if (request.method === "tools/call" && request.params.name === "get_config") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: false, structuredContent: { capability_manifest: { sha256: "a", file_sha256: "a", reload_error: null } } } }) + "\\n");
      });
    `;
    expect(
      yield* read({ command: process.execPath, args: ["-e", script], environment: [] }),
    ).toEqual({ capability_manifest: { sha256: "a", file_sha256: "a", reload_error: null } });
  }).pipe(Effect.provideService(HostProcess.Environment, {})),
);

it.live("rejects get_config tool errors", () =>
  Effect.gen(function* () {
    const read = yield* Probe.makeBrowserDriverGetConfig();
    const script = `
      const readline = require("node:readline");
      readline.createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
        if (request.method === "tools/call") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, structuredContent: {} } }) + "\\n");
      });
    `;
    const result = yield* Effect.exit(
      read({ command: process.execPath, args: ["-e", script], environment: [] }),
    );
    expect(Exit.isFailure(result)).toBe(true);
  }).pipe(Effect.provideService(HostProcess.Environment, {})),
);
