import { recognizeRemoteWith } from "@goat/source-control-core/shared/definition";
import { expect, it } from "vite-plus/test";
import { definition } from "./definition.ts";

it.each([
  "git@ssh.bitbucket.org:workspace/repo.git",
  "ssh://git@altssh.bitbucket.org:443/workspace/repo.git",
])("identifies Cloud SSH remote %s", (url) => {
  expect(recognizeRemoteWith(definition, url)).toEqual({
    kind: "bitbucket",
    name: "Bitbucket",
    baseUrl: "https://bitbucket.org",
  });
});
