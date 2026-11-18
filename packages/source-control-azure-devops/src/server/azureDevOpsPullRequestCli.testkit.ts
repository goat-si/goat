import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsPullRequestCli from "./AzureDevOpsPullRequestCli.ts";

export const mockedExecute = vi.fn<AzureDevOpsCli.AzureDevOpsCli["Service"]["execute"]>();

export const layer = it.layer(
  AzureDevOpsPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
        execute: mockedExecute,
      }),
    ),
    Layer.provide(NodeServices.layer),
  ),
);

export function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

export function argsOfCall(index: number): ReadonlyArray<string> {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0].args;
}
