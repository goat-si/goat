/**
 * Git hooks, `git rebase --exec` and `git bisect run` export GIT_DIR, GIT_INDEX_FILE and friends
 * for the checkout that started them. A git child that inherits them ignores its cwd: `git init`
 * reinitializes that checkout's git directory and `git config` writes the shared config every
 * linked worktree reads (#1114).
 */
const isGitEnvName = (name: string) => name.toUpperCase().startsWith("GIT_");

// Test setup hands its own git settings to every child (apps/server/src/testUtils/gitConfig.setup.ts)
// once the inherited GIT_* variables are gone.
const TEST_GIT_CONFIG_NAME = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i;

/** Deletes every GIT_* variable. Test setup runs this before it adds any of its own. */
export const removeInheritedGitEnv = (env: NodeJS.ProcessEnv): void => {
  for (const name of Object.keys(env)) {
    if (isGitEnvName(name)) delete env[name];
  }
};

/** The environment for a git child that must act only on the repository at its cwd. */
export const isolatedGitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(env).filter(([name]) => !isGitEnvName(name) || TEST_GIT_CONFIG_NAME.test(name)),
  );
