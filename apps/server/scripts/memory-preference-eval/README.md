# Package manager preference correction

Run three real provider turns against GOAT Memory in two ordinary project threads. The first repository establishes a user-wide npm preference and then corrects it to pnpm. A fresh thread in a second repository asks to use yarn only there. The prompts contain no tool names, record IDs or directions about how to store the correction. Named GOAT Bots have their own channel notes.

From the repository root, run the evaluation with an authenticated provider and its model.

```sh
node apps/server/scripts/memory-preference-eval/run.ts --live --provider codex --model gpt-6.2-sol > preference-result.json
```

Replace the example model with one supported by your CLI. Each invocation creates a new loopback GOAT server, an empty Memory Hub and two temporary Git repositories. It uses the provider configuration and authentication available to the process. To keep provider-native history separate too, run with a dedicated authenticated provider profile. The runner removes its temporary GOAT data when it exits.

The JSON contains each prompt, the run and thread IDs, the model selection, tool actions, and snapshots from the user, project and thread scopes. Each snapshot includes active IDs and the retained revision history of the listed records. You can trace the original user memory through the correction and check whether the project exception changed that user's revision. For interactive providers the runner confirms one identifiable GOAT Memory call at a time. Unexpected approvals or incomplete turns stop the run before a verdict.

Exit status 0 means all checks passed. Status 1 with a JSON verdict means a check failed, for example two active defaults or a changed global revision after the exception. Status 2 flags wording that needs a person to read the recorded text, including a note that names both yarn and pnpm. Provider or setup errors go to stderr. Live results characterize the selected provider and model on this run.

The deterministic scorer cases run without provider credentials.

```sh
vp test run apps/server/scripts/memory-preference-eval/score.test.ts
```
