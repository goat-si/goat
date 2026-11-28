import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import { createModelSelection } from "@goat/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import { SYNTHETIC_CLAUDE_CAPABLE_MODEL } from "../provider/ClaudeModelCatalog.testFixtures.ts";
import {
  layerClaudeTextGenerationTest,
  withFakeClaudeEnv,
} from "./ClaudeTextGeneration.testkit.ts";

const reviewGuideInput = {
  number: 12,
  title: "Review a change",
  description: "",
  baseBranch: "main",
  baseCommit: "base",
  settledReview: "",
  modelSelection: createModelSelection(
    ProviderInstanceId.make("claudeAgent"),
    SYNTHETIC_CLAUDE_CAPABLE_MODEL,
  ),
};

it.layer(layerClaudeTextGenerationTest)("Claude investigation settings", (it) => {
  it.effect("resolves relative --settings against the project folder, not the PR checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-guide-" });
      const project = path.join(root, "project");
      const checkout = path.join(root, "checkout");
      yield* fs.makeDirectory(project);
      yield* fs.makeDirectory(checkout);
      yield* fs.writeFileString(
        path.join(project, "claude.json"),
        JSON.stringify({ env: { ORIGIN: "project" } }),
      );
      yield* fs.writeFileString(
        path.join(checkout, "claude.json"),
        JSON.stringify({ env: { ORIGIN: "untrusted-pr" } }),
      );
      const settingsLog = path.join(root, "settings.json");
      yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({ structured_output: { stops: [] } }),
          argsMustContain: "--setting-sources  --disable-slash-commands",
          expectedTools: "Read,Grep,Glob,Bash",
          settingsLog,
          claudeConfig: { homePath: path.join(root, "home"), launchArgs: "--settings claude.json" },
        },
        (textGeneration) =>
          textGeneration.generateReviewGuide({
            ...reviewGuideInput,
            cwd: checkout,
            projectCwd: project,
          }),
      );
      expect(JSON.parse(yield* fs.readFileString(settingsLog))).toEqual({
        env: { ORIGIN: "project" },
        disableAllHooks: true,
      });
    }),
  );

  it.effect("gives a review guide the user's settings without their pre-approved tools", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-guide-" });
      const home = path.join(root, "home");
      yield* fs.makeDirectory(home);
      yield* fs.writeFileString(
        path.join(home, "settings.json"),
        JSON.stringify({
          env: { ENDPOINT: "user", SHARED: "user" },
          permissions: { allow: ["Bash(touch:*)"], deny: ["Read(./private/**)"] },
        }),
      );
      const settingsLog = path.join(root, "settings.json");
      const launchSettings = JSON.stringify({
        env: { SHARED: "launch" },
        permissions: { allow: ["Bash(npm test:*)"], deny: ["Read(./keys/**)"] },
      });
      yield* withFakeClaudeEnv(
        {
          output: JSON.stringify({ structured_output: { stops: [] } }),
          // The CLI loads no settings file of its own.
          argsMustContain: "--setting-sources  --disable-slash-commands",
          argsMustNotContain: "ENDPOINT",
          expectedTools: "Read,Grep,Glob,Bash",
          settingsLog,
          claudeConfig: { homePath: home, launchArgs: `--settings '${launchSettings}'` },
        },
        (textGeneration) =>
          textGeneration.generateReviewGuide({
            ...reviewGuideInput,
            cwd: process.cwd(),
            projectCwd: process.cwd(),
          }),
      );
      expect(JSON.parse(yield* fs.readFileString(settingsLog))).toEqual({
        env: { ENDPOINT: "user", SHARED: "launch" },
        permissions: { deny: ["Read(./private/**)", "Read(./keys/**)"] },
        disableAllHooks: true,
      });
    }),
  );
});
