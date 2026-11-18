import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MCP_APP_MAX_HTML_BYTES } from "@goat/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { readMcpAppHtml } from "./AssetAccess.ts";

describe("AssetAccess", () => {
  describe("readMcpAppHtml", () => {
    it.effect("accepts snapshots at the stored HTML byte limit", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        yield* fileSystem.writeFile(file, new Uint8Array(limit).fill(120));
        const bytes = yield* readMcpAppHtml(file);
        expect(bytes?.byteLength).toBe(limit);
        expect(bytes?.every((byte) => byte === 120)).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
    it.effect("rejects snapshots one byte past the limit and much larger files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        for (const size of [limit + 1, limit * 2]) {
          yield* fileSystem.writeFile(file, new Uint8Array(size).fill(120));
          expect(yield* readMcpAppHtml(file)).toBeNull();
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
    it.effect("preserves UTF-8 bytes across stream chunks and accepts empty snapshots", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-mcp-html-" });
        const file = path.join(directory, "app.html");
        for (const html of ["", "<body>" + "☃".repeat(100_000) + "</body>"]) {
          const expected = new TextEncoder().encode(html);
          yield* fileSystem.writeFile(file, expected);
          const bytes = yield* readMcpAppHtml(file);
          expect(bytes?.byteLength).toBe(expected.byteLength);
          expect(bytes && new TextDecoder().decode(bytes)).toBe(html);
        }
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
    // regression: #17026 apply host color scheme to saved MCP apps
    it.effect("preserves filesystem failures instead of reporting oversized HTML", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-mcp-html-" });
        const error = yield* readMcpAppHtml(path.join(directory, "missing.html")).pipe(Effect.flip);
        expect(error._tag).toBe("PlatformError");
        expect(error.reason._tag).toBe("NotFound");
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
  });
});
