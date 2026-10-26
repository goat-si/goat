// Agent shells carry real provider credentials (CLIProxy sets ANTHROPIC_AUTH_TOKEN and
// ANTHROPIC_BASE_URL) and the agent's own GOAT state: a GOAT thread's MCP credential, CLI
// launcher, and home. Tests that read the ambient environment then pass or fail by who runs
// them. Tests that need one of these variables set it themselves. Set
// GOAT_TEST_KEEP_PROVIDER_ENV=1 to keep them, for example for a live run.
const PROVIDER_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "GOAT_", "T3CODE_"];

// Test harness knobs: the temp sandbox guard, opt-in fixtures, and the keep flag itself.
const KEPT_ENV_PREFIXES = ["GOAT_TEST_"];

const KEPT_ENV = new Set([
  // CI sets these so the transfer budget integration test writes its report for the job summary.
  "GOAT_TRANSFER_BUDGET_REPORT_PATH",
  "GOAT_TRANSFER_BUDGET_RESULT_PATH",
  // CI's memory growth task, and the baseline run of the same suite.
  "GOAT_MEMORY_GROWTH",
  "GOAT_RECEIVE_BASELINE",
  // Opt-in: the shell the SSH runner tests use, and the live second-machine check.
  "GOAT_SSH_TEST_SHELL",
  "GOAT_REMOTE_LIVE_HOST",
  "GOAT_REMOTE_LIVE_PROJECT_ID",
]);

export const removeAmbientProviderEnv = (env: NodeJS.ProcessEnv): void => {
  if (env.GOAT_TEST_KEEP_PROVIDER_ENV === "1") return;
  for (const key of Object.keys(env)) {
    if (KEPT_ENV.has(key) || KEPT_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
};

removeAmbientProviderEnv(process.env);
