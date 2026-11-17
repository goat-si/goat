import { describe, expect, it } from "@effect/vitest";
import {
  AssetCreateUrlInput,
  PullRequestOperationError,
  SOURCE_CONTROL_MEDIA_ASSET,
} from "@goat/contracts";
import { makeSignedInMediaFetch } from "@goat/source-control-github/server/gitHubMediaFetch.testkit";
import { fakeSourceControlDriverInstance } from "@goat/source-control-testing/fakeSourceControlDriver";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { layerTest } from "./AssetAccess.testkit.ts";
import { sourceControlMediaResponse } from "./sourceControlMediaResponse.ts";

const raw = (repository: string) => `https://raw.githubusercontent.com/${repository}/main/a.png`;
const decodeCreateUrlInput = Schema.decodeEffect(AssetCreateUrlInput);

/**
 * A server signed in to GitHub whose active projects use `projects` and whose checkout at every cwd
 * is `cwdRepository`; GitHub serves a private file only to a request that carries the token.
 */
const makeServer = (input: {
  readonly projects: Set<string>;
  readonly cwdRepository?: string;
  readonly lookup?: "fails" | "never answers" | "dies" | "fails and dies" | "is interrupted";
}) => {
  const authorizations: Array<string | null> = [];
  const github = sourceControlDefinitions.find("github");
  if (github === undefined) throw new Error("GitHub is not a source control definition");
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      authorizations.push(request.headers.authorization ?? null);
      return HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: request.headers.authorization ? 200 : 404,
          headers: { "content-type": "image/png" },
        }),
      );
    }),
  );
  const [owner, name] = input.cwdRepository?.split("/") ?? [];
  const layer = Layer.mergeAll(
    layerTest,
    Layer.effect(
      BuiltInDrivers.SourceControlDrivers,
      Effect.map(makeSignedInMediaFetch("owner-token", httpClient), (fetchMedia) => [
        {
          driver: { kind: github.kind, definition: github },
          instance: fakeSourceControlDriverInstance(github.kind, {
            pullRequests: null,
            fetchMedia,
          }),
        },
      ]),
    ),
    Layer.mock(PullRequestService.PullRequestService)({
      hasProjectRepository: ({ host, repository }) => {
        const down = new PullRequestOperationError({ operation: "listProjects", detail: "down" });
        switch (input.lookup) {
          case "fails":
            return Effect.fail(down);
          case "never answers":
            return Effect.never;
          case "dies":
            return Effect.die(new Error("lookup died"));
          case "fails and dies":
            return Effect.failCause(Cause.combine(Cause.fail(down), Cause.die("lookup died")));
          case "is interrupted":
            return Effect.interrupt;
          default:
            return Effect.succeed(
              host === "github.com" && input.projects.has(repository.toLowerCase()),
            );
        }
      },
    }),
    Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
      resolve: () =>
        Effect.succeed(
          owner && name
            ? {
                canonicalKey: `github.com/${owner}/${name}`,
                locator: { source: "git-remote", remoteName: "origin", remoteUrl: "" },
                provider: github.kind,
                owner,
                name,
              }
            : null,
        ),
    }),
  );
  return { authorizations, layer };
};

/** Mints the URL as assets.createUrl does, from what the client sent, and resolves its claims. */
const mint = (resource: {
  readonly cwd: string;
  readonly url: string;
  readonly repository?: string;
}) =>
  Effect.gen(function* () {
    const decoded = yield* decodeCreateUrlInput({
      resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, ...resource },
    });
    if (decoded.resource._tag !== SOURCE_CONTROL_MEDIA_ASSET) return yield* Effect.die("not media");
    const issued = yield* issueAssetUrl({ resource: decoded.resource });
    const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separator = suffix.indexOf("/");
    const asset = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
    if (asset?.kind !== "source-control-media") return yield* Effect.die("not media");
    return asset;
  });

const status = (asset: Effect.Success<ReturnType<typeof mint>>) =>
  Effect.map(sourceControlMediaResponse(asset, {}), (response) => response.status);

describe("GitHub media credential at the asset route", () => {
  it.effect(
    "a repository no project uses, named by the client, never gets the GitHub token",
    () => {
      const server = makeServer({ projects: new Set(["owner/repo"]) });
      return Effect.gen(function* () {
        for (const url of [
          raw("victim/private"),
          "https://github.com/victim/private/blob/main/a.png",
          "https://media.githubusercontent.com/media/victim/private/main/a.mp4",
        ]) {
          const asset = yield* mint({ cwd: "/x", url, repository: "victim/private" });
          expect(yield* status(asset)).toBe(404);
        }
        expect(server.authorizations).toEqual([null, null, null]);
      }).pipe(Effect.provide(server.layer), Effect.scoped);
    },
  );

  it.effect(
    "another active project's repository gets the token, and loses it once that project is removed",
    () => {
      const projects = new Set(["owner/repo", "other/project"]);
      const server = makeServer({ projects, cwdRepository: "owner/repo" });
      return Effect.gen(function* () {
        const asset = yield* mint({
          cwd: "/repo",
          url: raw("other/project"),
          repository: "other/project",
        });
        expect(yield* status(asset)).toBe(200);
        projects.delete("other/project");
        expect(yield* status(asset)).toBe(404);
        expect(server.authorizations).toEqual(["Bearer owner-token", null]);
      }).pipe(Effect.provide(server.layer), Effect.scoped);
    },
  );

  it.effect(
    "an older client's media gets the token only for the cwd checkout's repository while a project uses it",
    () => {
      const projects = new Set(["owner/repo"]);
      const server = makeServer({ projects, cwdRepository: "owner/repo" });
      return Effect.gen(function* () {
        const own = yield* mint({ cwd: "/repo", url: raw("owner/repo") });
        const foreign = yield* mint({ cwd: "/repo", url: raw("victim/private") });
        expect([yield* status(own), yield* status(foreign)]).toEqual([200, 404]);
        // The checkout at cwd stays on disk, but no active project uses it any more.
        projects.clear();
        expect(yield* status(own)).toBe(404);
        expect(server.authorizations).toEqual(["Bearer owner-token", null, null]);
      }).pipe(Effect.provide(server.layer), Effect.scoped);
    },
  );

  it.effect.each(["fails", "never answers", "dies", "fails and dies"] as const)(
    "a project lookup that %s sends no GitHub token",
    (lookup) => {
      const server = makeServer({ projects: new Set(["owner/repo"]), lookup });
      return Effect.gen(function* () {
        const asset = yield* mint({
          cwd: "/repo",
          url: raw("owner/repo"),
          repository: "owner/repo",
        });
        const fetching = yield* status(asset).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(Duration.minutes(1));
        expect(yield* Fiber.join(fetching)).toBe(404);
        expect(server.authorizations).toEqual([null]);
      }).pipe(Effect.provide(server.layer), Effect.scoped);
    },
  );

  it.effect(
    "a project lookup that is interrupted interrupts the media request and sends nothing",
    () => {
      const server = makeServer({ projects: new Set(["owner/repo"]), lookup: "is interrupted" });
      return Effect.gen(function* () {
        const asset = yield* mint({
          cwd: "/repo",
          url: raw("owner/repo"),
          repository: "owner/repo",
        });
        const exit = yield* Effect.exit(status(asset));
        expect(Exit.hasInterrupts(exit)).toBe(true);
        expect(server.authorizations).toEqual([]);
      }).pipe(Effect.provide(server.layer), Effect.scoped);
    },
  );
});
