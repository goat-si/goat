import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildGoatProjectFileJsonSchema,
  parseGoatProjectFile,
  GoatProjectFileFromJson,
} from "./goatProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(GoatProjectFileFromJson);

describe("GoatProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseGoatProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseGoatProjectFile(`{
        /* See https://exa.test/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});

it("publishes GOAT check-in script options", () => {
  const schema = buildGoatProjectFileJsonSchema();
  expect(schema).toHaveProperty("properties.scripts.items.properties.checkInSharedCheckout");
  expect(schema).toHaveProperty("properties.scripts.items.properties.runAsCheck");
});
