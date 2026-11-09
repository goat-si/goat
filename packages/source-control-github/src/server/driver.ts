import {
  defineSourceControlDriver,
  withOwnServices,
} from "@goat/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubHttpClient from "./GitHubHttpClient.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

// `GitHubRest.layerWithDependencies` carries the quota reserve every GitHub reader shares, so it
// must be built once; the driver is.
const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubRest.layerWithDependencies),
  Layer.provideMerge(GitHubHttpClient.layer),
);

// Pinned by the server so the public star prompt cannot be used for arbitrary repositories.
const GOAT_REPOSITORY = "goat-si/goat";

// Only 204 means starred. A missing repository is not starred; other failures propagate so the
// client can distinguish an unavailable check from a definite answer.
export const makeIsRepositoryStarred = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubDriver.isRepositoryStarred")((host: string, repository: string) =>
    Effect.gen(function* () {
      if (repository !== GOAT_REPOSITORY) return false;
      const response = yield* api
        .rest({
          host,
          operation: "isRepositoryStarred",
          path: `user/starred/${GOAT_REPOSITORY.split("/").map(encodeURIComponent).join("/")}`,
          allowReserve: false,
        })
        .pipe(
          Effect.catchIf(
            (error) => error._tag === "GitHubApiNotFoundError",
            () => Effect.succeed(undefined),
          ),
        );
      return response === undefined ? false : response.status === 204;
    }),
  );
});

const makeInstance = Effect.all({
  sourceControl: GitHubSourceControlProvider.make,
  discovery: GitHubSourceControlProvider.makeDiscovery,
  pullRequests: GitHubPullRequestProvider.make,
  fetchMedia: GitHubMediaFetch.make,
  isRepositoryStarred: makeIsRepositoryStarred,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
