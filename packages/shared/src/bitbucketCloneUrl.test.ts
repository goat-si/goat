import { expect, it } from "vite-plus/test";
import { cloneUrlForProtocol } from "./cloneUrl.ts";

it("converts Bitbucket Cloud transport hosts and preserves self-hosted hosts", () => {
  expect(cloneUrlForProtocol("https://bitbucket.org/workspace/repo.git", "ssh")).toBe(
    "git@ssh.bitbucket.org:workspace/repo.git",
  );
  expect(cloneUrlForProtocol("git@ssh.bitbucket.org:workspace/repo.git", "https")).toBe(
    "https://bitbucket.org/workspace/repo.git",
  );
  expect(cloneUrlForProtocol("git@bitbucket.example.test:workspace/repo.git", "https")).toBe(
    "https://bitbucket.example.test/workspace/repo.git",
  );
});
