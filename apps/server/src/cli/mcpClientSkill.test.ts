// @effect-diagnostics nodeBuiltinImport:off - the contract is with a file outside the bundle.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import * as NodeFS from "node:fs";

import { cli } from "../binCli.ts";

const installableSkill = NodeFS.readFileSync(
  new URL("../../../../skills/goat-mcp/SKILL.md", import.meta.url),
  "utf8",
);

describe("goat mcp skill", () => {
  it.effect("prints the installable skills/goat-mcp/SKILL.md byte for byte", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.0" })(["mcp", "skill"]);
      const printed = (yield* TestConsole.logLines).join("\n") + "\n";
      // When this fails, regenerate mcpClientSkill.ts from SKILL.md; installers read the file.
      assert.strictEqual(printed, installableSkill);
      assert.match(installableSkill, /^---\nname: goat-mcp\ndescription: \S/);
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
    ),
  );
});
