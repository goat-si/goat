import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses GOAT_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { GOAT_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when GOAT_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { GOAT_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { GOAT_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
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
