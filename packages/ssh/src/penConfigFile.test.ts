import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { PEN_CONFIG_MAX_BYTES, readPenConfig } from "./penConfigFile.ts";

it.effect("reads regular bounded files and refuses oversized or nonregular files", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = `${dir}/config`;
    yield* fs.writeFileString(file, "Host pen-node\n");
    expect(yield* readPenConfig(fs, file)).toBe("Host pen-node\n");
    yield* fs.writeFile(file, new Uint8Array(PEN_CONFIG_MAX_BYTES + 1));
    expect((yield* readPenConfig(fs, file).pipe(Effect.flip)).failure).toBe("tooLarge");
    expect((yield* readPenConfig(fs, dir).pipe(Effect.flip)).failure).toBe("notRegular");
  }).pipe(Effect.provide(NodeServices.layer)),
);
