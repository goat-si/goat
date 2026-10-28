import { expect, it } from "vite-plus/test";
import { sourceRepositoryUrlProblems } from "./release-verify.ts";
import { readUserGuides } from "./user-guides.ts";

it("bundled user guides carry no source repository URL, so release artifacts pass D-10", () => {
  const guides = readUserGuides(`${import.meta.dirname}/../..`);
  const problems = Object.entries(guides).flatMap(([id, text]) =>
    sourceRepositoryUrlProblems(id, text),
  );
  expect(problems).toEqual([]);
  // A link to the repository keeps its text for the agent reading the guide.
  expect(guides["goat-connect-troubleshooting"]).toContain("GitHub. Include:");
});
