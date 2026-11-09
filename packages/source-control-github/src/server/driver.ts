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

const starredPath = (repository: string) => {
  const segments = repository.split("/");
  // "." and ".." survive encoding and would normalize the URL out of user/starred.
  return segments.length === 2 && segments.every((segment) => !["", ".", ".."].includes(segment))
    ? `user/starred/${segments.map(encodeURIComponent).join("/")}`
    : undefined;
};

// Only 204 means starred; failures other than not-found make the check unavailable.
export const makeIsRepositoryStarred = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubDriver.isRepositoryStarred")((host: string, repository: string) =>
    Effect.gen(function* () {
      if (repository !== GOAT_REPOSITORY) return false;
      const path = starredPath(GOAT_REPOSITORY);
      if (path === undefined) return false;
      return yield* api
        .rest({
          host,
          operation: "isRepositoryStarred",
          path,
          allowReserve: false,
        })
        .pipe(
          Effect.map((response) => response.status === 204),
          Effect.catchTags({ GitHubApiNotFoundError: () => Effect.succeed(false) }),
          Effect.orElseSucceed(() => null),
        );
    }),
  );
});

// False on any failure, such as a token or app sign-in without permission to star.
export const makeStarRepository = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;
  return Effect.fn("GitHubDriver.starRepository")((host: string, repository: string) =>
    Effect.gen(function* () {
      if (repository !== GOAT_REPOSITORY) return false;
      const path = starredPath(GOAT_REPOSITORY);
      if (path === undefined) return false;
      const response = yield* api.rest({ host, operation: "starRepository", method: "PUT", path });
      return response.status === 204;
    }).pipe(Effect.orElseSucceed(() => false)),
  );
});

const makeInstance = Effect.all({
  sourceControl: GitHubSourceControlProvider.make,
  discovery: GitHubSourceControlProvider.makeDiscovery,
  pullRequests: GitHubPullRequestProvider.make,
  fetchMedia: GitHubMediaFetch.make,
  isRepositoryStarred: makeIsRepositoryStarred,
  starRepository: makeStarRepository,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
