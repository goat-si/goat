import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";

describe("model catalog refresh capability", () => {
  it("accepts both older descriptors and the new advertised capability", () => {
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
    expect(decode({}).modelCatalogRefresh).toBeUndefined();
    expect(decode({ modelCatalogRefresh: true }).modelCatalogRefresh).toBe(true);
  });
});
