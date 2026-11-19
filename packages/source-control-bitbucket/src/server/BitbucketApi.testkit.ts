import { vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@goat/source-control-core/server/SourceControlRateLimit";
import type * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as BitbucketApi from "./BitbucketApi.ts";

type HostGit = SourceControlHost.SourceControlHost["Service"]["git"];

export function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  /** Holds the answer until it resolves, in place of answering at once. */
  readonly answer?: (response: Response) => Effect.Effect<Response>;
  readonly requestFailure?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientError.HttpClientError;
  readonly stall?: boolean;
  readonly git?: Partial<HostGit>;
  readonly env?: Record<string, string>;
  readonly remoteUrl?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    input.stall
      ? Effect.never
      : input.requestFailure
        ? Effect.fail(input.requestFailure(request))
        : (input.answer ?? Effect.succeed)(input.response(request)).pipe(
            Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
          ),
  );
  const gitMock = {
    readConfigValue: vi.fn<HostGit["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@bitbucket.org:goat-si/goat.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<HostGit["resolvePrimaryRemoteName"]>(() =>
      Effect.succeed("origin"),
    ),
    ensureRemote: vi.fn<HostGit["ensureRemote"]>(() => Effect.succeed("octocat")),
    fetchRemoteBranch: vi.fn<HostGit["fetchRemoteBranch"]>(() => Effect.void),
    fetchRemoteTrackingBranch: vi.fn<HostGit["fetchRemoteTrackingBranch"]>(() => Effect.void),
    setBranchUpstream: vi.fn<HostGit["setBranchUpstream"]>(() => Effect.void),
    switchRef: vi.fn<HostGit["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<HostGit["listLocalBranchNames"]>(() => Effect.succeed([])),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<HostGit>;

  const listRemotes = vi.fn(() =>
    Effect.succeed({
      remotes: [
        {
          name: "origin",
          url: input.remoteUrl ?? "git@bitbucket.org:goat-si/goat.git",
          pushUrl: Option.none(),
          isPrimary: true,
        },
      ],
      freshness: {
        source: "live-local" as const,
        observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
        expiresAt: Option.none(),
      },
    }),
  );
  // The outer effect resolves the repository; the inner one lists its remotes.
  const resolve = vi.fn((_cwd: string) => Effect.succeed(Effect.suspend(listRemotes)));

  const layer = BitbucketApi.layer.pipe(
    Layer.provide(SourceControlRateLimit.layer),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            GOAT_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
            GOAT_BITBUCKET_EMAIL: "user@example.com",
            GOAT_BITBUCKET_API_TOKEN: "token",
          },
        }),
      ),
    ),
    Layer.provideMerge(TestSourceControlHost.layer({ git: { ...git, remotes: resolve } })),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, resolve, listRemotes, layer };
}
