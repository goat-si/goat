import { SourceControlProviderKind } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeProject } from "../mcp/toolkits/pullRequests/handlers.testkit.ts";
import { resolveTarget } from "./pullRequestTarget.ts";

it.effect("expands an Azure repository name before building its PR URL", () =>
  Effect.gen(function* () {
    const project = makeProject({
      canonicalKey: "dev.azure.com/contoso/project/_git/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://dev.azure.com/contoso/project/_git/repo",
      },
      provider: SourceControlProviderKind.make("azure-devops"),
      displayName: "contoso/project/_git/repo",
      owner: "contoso",
      name: "repo",
    });
    expect(yield* resolveTarget({ repository: "repo", number: 123 }, project)).toMatchObject({
      host: "dev.azure.com",
      repository: "contoso/project/_git/repo",
      number: 123,
      url: "https://dev.azure.com/contoso/project/_git/repo/pullrequest/123",
    });
  }),
);
