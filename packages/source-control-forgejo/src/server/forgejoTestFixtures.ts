import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@goat/source-control-testing/TestSourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";

const processOutput = TestSourceControlHost.processOutput;
const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const requiredChecksPullRequest = {
  number: 7,
  title: "Required checks",
  body: "",
  html_url: "https://forgejo.test/acme/web/pulls/7",
  user: { login: "maria" },
  state: "open",
  merged: false,
  head: { ref: "feature", sha: "head", repo: null },
  base: { ref: "release/1.x", sha: "base", repo: null },
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T00:00:00Z",
  closed_at: null,
  merged_at: null,
  labels: [],
};
export const requiredChecksStatuses = [
  ["ci/required-build", "success"],
  ["ci/optional-lint", "failure"],
].map(([context, status]) => ({
  context,
  status,
  description: null,
  target_url: null,
  updated_at: "2026-10-12T00:00:00Z",
}));

export const requiredChecksInput = {
  cwd: "/repo",
  repository: "acme/web",
  host: "forgejo.test",
  number: 7,
};
export const requiredChecksLayer = (
  branch: Effect.Effect<unknown, ForgejoCli.ForgejoCliError>,
  statuses = requiredChecksStatuses,
) =>
  Layer.mock(ForgejoCli.ForgejoCli)({
    api: (input) => {
      const [path, query] = input.path.split("?");
      const respond = (response: unknown) =>
        encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
      switch (path) {
        case "repos/acme/web/pulls/7":
          return respond(requiredChecksPullRequest);
        case "repos/acme/web/statuses/head":
          return respond(new URLSearchParams(query).get("page") === "1" ? statuses : []);
        case "repos/acme/web/branches/release/1.x":
          return Effect.flatMap(branch, respond);
        case "repos/acme/web":
          return respond({ full_name: "acme/web", permissions: { push: true, admin: false } });
        case "user":
          return respond({ login: "maria" });
        default:
          return Effect.die(`Unexpected Forgejo request: ${input.path}`);
      }
    },
  });
