import { expect, it } from "vite-plus/test";
import { sourceRepositoryUrlProblems } from "./release-verify.ts";
import { readUserGuides, withoutSourceRepositoryLinks } from "./user-guides.ts";

it("bundled user guides carry no source repository URL, so release artifacts pass D-10", () => {
  const guides = readUserGuides(`${import.meta.dirname}/../..`);
  const problems = Object.entries(guides).flatMap(([id, text]) =>
    sourceRepositoryUrlProblems(id, text),
  );
  expect(problems).toEqual([]);
  // A link to the repository keeps its text for the agent reading the guide.
  expect(guides["goat-connect-troubleshooting"]).toContain("GitHub. Include:");
  expect(guides.install).toContain(
    "git clone <GOAT repository URL: see https://trygoat.ai/docs/user/install/>",
  );
});

it("strips every form release verification rejects and leaves release links alone", () => {
  const rejected = [
    "[issues](https://github.com/goat-si/goat/issues?q=is%3Aopen#top)",
    "[dev](http://GITHUB.COM/GOAT-SI/GOAT#development)",
    "[bare](github.com/goat-si/goat)",
    "git clone git@github.com:goat-si/goat.git",
    "curl https://api.github.com/repos/goat-si/goat/releases",
    "see https://github.com/goat-si/goat.",
  ];
  for (const line of rejected) {
    expect(sourceRepositoryUrlProblems("before", line)).not.toEqual([]);
    const after = withoutSourceRepositoryLinks(line, "install");
    expect(sourceRepositoryUrlProblems(after, after)).toEqual([]);
  }
  expect(withoutSourceRepositoryLinks(rejected[0] ?? "", "install")).toBe("issues");
  expect(withoutSourceRepositoryLinks(rejected[3] ?? "", "install")).toBe(
    "git clone <GOAT repository URL: see https://trygoat.ai/docs/user/install/>",
  );
  const kept = "[releases](https://github.com/goat-si/goat-releases/releases) goat-si/goat_x";
  expect(withoutSourceRepositoryLinks(kept, "install")).toBe(kept);
});
