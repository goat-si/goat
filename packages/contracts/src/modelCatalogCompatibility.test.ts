import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";

describe("model catalog refresh capability", () => {
  it("decodes bot task lookup capability on old and new servers", () => {
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
    expect(decode({}).goatBotTaskLookupSearch).toBeUndefined();
    expect(decode({ goatBotTaskLookupSearch: true }).goatBotTaskLookupSearch).toBe(true);
  });
  it("accepts both older descriptors and the new advertised capability", () => {
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
    expect(decode({}).modelCatalogRefresh).toBeUndefined();
    expect(decode({ modelCatalogRefresh: true }).modelCatalogRefresh).toBe(true);
  });
});
