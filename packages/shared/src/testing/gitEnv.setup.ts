import { removeInheritedGitEnv } from "./gitEnv.ts";

// A test run started from a git hook, `git rebase --exec` or `git bisect run` inherits GIT_DIR and
// friends. Without this, every git child of a test, including server code under test, would act on
// the checkout that started the run (#1114).
removeInheritedGitEnv(process.env);
