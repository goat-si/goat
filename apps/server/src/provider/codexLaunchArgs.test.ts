import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("OpenCodex Home routing", () => {
  const route = [
    "-c",
    'model_provider="openai"',
    "-c",
    'openai_base_url="http://127.0.0.1:10100/v1"',
    "-c",
    'model_catalog_json="/execution/home/opencodex-catalog.json"',
  ];
  it("keeps the Home endpoint and catalog when environment arguments override instance arguments", () => {
    const selected = resolveCodexLaunchArgs('-c openai_base_url="wrong-instance"', {
      GOAT_CODEX_LAUNCH_ARGS: '-c openai_base_url="wrong-env"',
    });
    NodeAssert.deepStrictEqual(codexAppServerArgs(selected, route).slice(-route.length), route);
    NodeAssert.deepStrictEqual(codexExecLaunchArgs(selected, route).slice(-route.length), route);
  });
  it("passes the same endpoint and catalog to app-server and exec", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs("--profile work --enable feature", route).slice(1),
      codexExecLaunchArgs("--profile work --enable feature", route),
    );
  });
});
