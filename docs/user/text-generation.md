# Text generation

GOAT uses a text generation model for thread titles, commit messages, pull request text, and branch names. You can use a coding provider or connect a model API on the environment that runs the work.

## Connect a model API

On web or desktop, open **Settings → Providers → Text generators**. Add an OpenAI-compatible or Anthropic endpoint, its base URL and model ID, and an API key if it needs one. Local endpoints can use a URL such as `http://localhost:11434/v1`; localhost refers to the server's machine. GOAT stores the key in that environment's secret store.

Choose **Use for text generation** to make the model API the environment's default for titles and source-control text, or **Use for source control** to use it only for commits, pull requests, and branch names. You can remove a generator from the same settings section. When a request fails, the calling task reports or handles the error as it normally would.

The configured API receives the text needed for the task, such as conversation context for a title or the staged diff for a commit. Review guides and memory need a coding provider and do not use API text generators.
