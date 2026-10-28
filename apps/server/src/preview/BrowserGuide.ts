import {
  BROWSER_SKILL_DIRECTORY,
  BROWSER_SKILL_FILE,
  browserSkillFiles,
  makeBrowserGuide,
} from "@goat/provider-core/server/builtinSkills/browserSkillFiles";

import { installSkillFilesAt } from "../orchestration-v2/ScreenCodeSkillInstall.ts";

const installed = new Map<string, string | undefined>();

/** The browser skill under `<stateDir>/skills/browser`, written once per process and state dir. */
const installBrowserSkillAt = (stateDir: string): string | undefined => {
  if (!installed.has(stateDir))
    installed.set(
      stateDir,
      installSkillFilesAt(
        stateDir,
        BROWSER_SKILL_DIRECTORY,
        browserSkillFiles(),
        BROWSER_SKILL_FILE,
      ),
    );
  return installed.get(stateDir);
};

let stateDirectory: string | undefined;
const guide = makeBrowserGuide(() =>
  stateDirectory === undefined ? undefined : installBrowserSkillAt(stateDirectory),
);

/** The guide pointer and site notes a browser result carries for this thread, once each. */
export const browserGuideFor = (
  stateDir: string | undefined,
  threadId: string,
  url: string | undefined,
): string | undefined => {
  stateDirectory ??= stateDir;
  return guide(threadId, url);
};
