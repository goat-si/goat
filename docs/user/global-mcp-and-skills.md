# GOAT MCP servers and skills

GOAT can give its agents MCP servers and skills of its own, on top of the ones
each provider already has. You set them up once per environment, and every
supported provider gets them in new threads. They live on the machine that runs
the environment, so a remote environment uses its own servers and skills.

This is the opposite direction of [outside agents](./outside-agents.md), which
lets agents outside GOAT call into it.

## Add MCP servers

In **Settings → Integrations → MCP servers**, add a server for the selected
environment: a command to run (stdio) or an HTTPS address (HTTP). Put tokens in
environment variables or headers; GOAT stores those values as secrets and shows
them masked. Don't put secrets in the address itself.

Servers apply to threads started after you add them. Agents see each one as
`<name>_goat`.

| Provider                                        | stdio | HTTP |
| ----------------------------------------------- | ----- | ---- |
| Codex, Claude, Cursor                           | Yes   | Yes  |
| ACP agents (Grok, Antigravity, registry agents) | Yes   | No   |
| OpenCode, Pi, Muse, cloud agents                | No    | No   |

If a provider already has its own server with exactly the same name, Codex keeps
its own and skips GOAT's, Claude uses GOAT's, and Cursor and ACP agents decide
for themselves. Names ending in `_goat` are GOAT's, so avoid them in provider
settings.

## Add skills

A skill is a folder with a `SKILL.md` file. To give one to every provider, put
the folder in the GOAT skills folder on the machine that runs the environment
(normally `~/.goat/skills`). In **Settings → Integrations → GOAT skills**,
choose **Rescan**; the section then shows the exact folder path and lists the
skill. The folder name must use lowercase letters, digits, and hyphens.

Call a skill in a message with `$goat:<folder-name>`. The composer's `$`
menu lists GOAT skills with a **GOAT** badge, next to the provider's own skills.
GOAT reads the skill when you send the message, so edits apply right away.

Turn a skill off or remove it in the same section. Removing deletes the folder;
if the folder is a link, only the link is removed.

A message carries up to eight GOAT skills. Very long skills are shortened, and
the agent is told where to read the full file.
