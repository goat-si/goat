// @effect-diagnostics preferSchemaOverJson:off - Moved test fixtures encode recorded gh output.
import { SourceControlProviderKind } from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const processOutput = (
  stdout: string,
  exitCode = 0,
): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

interface GraphQlCall {
  readonly host: string;
  readonly operationName: string;
  readonly query: string;
  readonly lookups: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

type GraphQlAnswer = unknown;
type GraphQlRespond = (
  lookup: Readonly<Record<string, unknown>>,
  call: GraphQlCall,
) => GraphQlAnswer | Response;

function graphQlHttp(respond: GraphQlRespond, calls: Array<GraphQlCall>) {
  return HttpClient.make((request) =>
    Effect.sync(() => {
      const sent =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              readonly query: string;
              readonly operationName: string;
              readonly variables: Readonly<Record<string, unknown>>;
            })
          : { query: "", operationName: "", variables: {} };
      const prefixes = [
        ...new Set(Object.keys(sent.variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
      ];
      const lookups =
        prefixes.length === 0
          ? [sent.variables]
          : prefixes.map((prefix) =>
              Object.fromEntries(
                Object.entries(sent.variables)
                  .filter(([key]) => key.startsWith(prefix))
                  .map(([key, value]) => [key.slice(prefix.length), value]),
              ),
            );
      const call: GraphQlCall = {
        host: new URL(request.url).hostname.replace(/^api\./, ""),
        operationName: sent.operationName,
        query: sent.query,
        lookups,
      };
      calls.push(call);
      const answers = lookups.map((lookup) => respond(lookup, call));
      const refusal = answers.find((answer) => answer instanceof Response);
      const response =
        refusal ??
        new Response(
          encodeJson({
            data: Object.fromEntries(
              answers.map((answer, index) => [
                prefixes.length === 0 ? "repository" : `${prefixes[index]}repository`,
                answer,
              ]),
            ),
          }),
          { headers: { "content-type": "application/json" } },
        );
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
}

export function harness(input: {
  readonly remotes: string;
  readonly api?: Partial<GitHubRest.GitHubRest["Service"]>;
  readonly graphql?: GraphQlRespond;
  readonly credential?: (
    host: string,
  ) => Effect.Effect<
    GitHubCredentials.GitHubCredential,
    GitHubCredentials.GitHubCredentialUnavailableError
  >;
  readonly localBranches?: ReadonlyArray<string>;
  readonly resolved?: string;
  readonly gitFailure?: unknown;
}) {
  const git: Array<readonly [string, unknown]> = [];
  const graphqlCalls: Array<GraphQlCall> = [];
  const record =
    <A>(name: string, value: A) =>
    (args: unknown) =>
      Effect.sync(() => {
        git.push([name, args]);
        return value;
      });
  const hostGit: Partial<SourceControlHost.SourceControlHost["Service"]["git"]> = {
    execute: (args) =>
      Effect.sync(() => {
        git.push(["execute", args.args]);
        return processOutput("");
      }),
    resolvePrimaryRemoteName: () => Effect.succeed("origin"),
    readConfigValue: () => Effect.succeed("git@github.com:acme/web.git"),
    ensureRemote: (args) =>
      Effect.sync(() => {
        git.push(["ensureRemote", args]);
        return args.preferredName;
      }),
    fetchRemoteTrackingBranch: (args) => record("fetchRemoteTrackingBranch", undefined)(args),
    setBranchUpstream: (args) => record("setBranchUpstream", undefined)(args),
    createBranch: (args) => record("createBranch", undefined)(args),
    writeConfigValue: (args) => record("writeConfigValue", undefined)(args),
    switchRef: (args) => record("switchRef", { refName: args.refName })(args) as never,
    listLocalBranchNames: () =>
      input.gitFailure === undefined
        ? Effect.succeed([...(input.localBranches ?? [])])
        : Effect.fail(input.gitFailure as never),
    resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
  };
  const host = TestSourceControlHost.layer({
    git: hostGit,
    process: {
      run: (args) =>
        Effect.succeed(
          args.args[0] === "remote"
            ? processOutput(input.remotes)
            : processOutput(input.resolved ?? "", input.resolved ? 0 : 1),
        ),
    },
  });
  const graphql =
    input.graphql ??
    (() => {
      throw new Error("Unexpected GraphQL read");
    });
  const policy = GitHubRequestPolicy.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GitHubCredentials.GitHubCredentials, {
          get:
            input.credential ??
            ((host) =>
              Effect.succeed({
                host,
                token: Redacted.make("token"),
                source: "gh" as const,
                fingerprint: `${host}:token`,
              })),
          invalidate: () => Effect.void,
        }),
        GitHubQuota.layer,
        SourceControlRateLimit.layer,
      ),
    ),
  );
  const layer = Layer.mergeAll(
    host,
    Layer.mock(GitHubRest.GitHubRest)(input.api ?? {}),
    policy,
    Layer.succeed(HttpClient.HttpClient, graphQlHttp(graphql, graphqlCalls)),
    NodeServices.layer,
    NodeCrypto.layer,
  );
  return { layer, git, graphqlCalls };
}

export const makeProvider = (api: Partial<GitHubRest.GitHubRest["Service"]>) =>
  GitHubSourceControlProvider.make.pipe(Effect.provide(harness({ remotes: "", api }).layer));

export const githubContext = (host: string) => ({
  provider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: `https://${host}`,
  },
  remoteName: "origin",
  remoteUrl: `git@${host}:acme/web.git`,
});
