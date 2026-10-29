import * as Schema from "effect/Schema";
import type * as GitHubRest from "./GitHubRest.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const remotesOutput = (...entries: ReadonlyArray<readonly [string, string]>) =>
  entries
    .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join("\n");

export const restResponse = (body: unknown, status = 200): GitHubRest.GitHubRestResponse => ({
  status,
  headers: {},
  body: body === undefined ? "" : encodeJson(body),
  truncated: false,
  invalidUtf8: false,
});

export const node = (number: number, headRefName: string, owner = "acme") => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/web/pull/${number}`,
  baseRefName: "main",
  headRefName,
  headRefOid: "f".repeat(40),
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  closedAt: null,
  isCrossRepository: owner !== "acme",
  updatedAt: "2026-01-02T00:00:00Z",
  headRepository: { name: "web", nameWithOwner: `${owner}/web` },
  headRepositoryOwner: { __typename: "User", login: owner },
});
