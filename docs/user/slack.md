# Slack

Mention the GOAT bot in a Slack channel or send it a direct message, and GOAT
answers in that Slack thread, starts the work in its own coding thread, and
posts the result back to the same thread. The conversation stays in Slack; the
GOAT Bot screen shows only a chip for the work and its final report.

## Set up

1. Create a Slack app with **Socket Mode** turned on. GOAT opens the
   connection itself, so the app needs no public URL.
2. Give it an app-level token with `connections:write`, and a bot token with
   `chat:write`, `app_mentions:read`, and `im:history`. Subscribe the bot to
   the `app_mention` and `message.im` events. Turn on **Interactivity** —
   Socket Mode delivers button presses, so the app needs no Request URL — then
   install the app to your workspace.
3. In GOAT, open **Settings → GOAT Bot → Slack** for the machine that
   should do the work. Paste both tokens, list the channel IDs where mentions
   may start work, and turn on **Use Slack**. Tokens stay on that machine and
   are never shown again.
4. Under **Link your Slack account**, create a one-time code and send it to
   the bot in a direct message as `link <code>`. Until you link, the bot only
   explains how to link.

## Good to know

- In a channel, invite the bot and mention it in each message; it does not
  read other channel messages. Direct messages always work.
- Replies, questions, and results go to the thread where you asked, and
  questions tag the person who asked.
- **Default project** decides where work from Slack runs when your message
  doesn't name a project. Without it, GOAT picks the project from the
  conversation and asks only when it can't tell, suggesting the one you worked
  in most recently. **This machine (no project)** runs work that isn't about a
  repository.
- GOAT Bot answers questions about the machine it runs on, such as its name,
  OS, memory, and what is running, without starting work.
- For questions that need a look around but no code change (what fills the
  disk, what several threads concluded, something on the web), GOAT Bot says
  it is on it and looks into it itself, then answers in the same conversation.
  Messages you send while it works are added to what it is doing. It uses the
  model chosen under **Settings → GOAT Bot** (by default, the default model for
  new threads). It runs with full access, never more than the person who asked
  may use, so it can read files, logs, and status anywhere on the machine
  without asking. It is told to change nothing itself and to start a coding
  task or ask you when something needs changing. That rule is part of its
  instructions; GOAT does not block changes, so link people at a lower access
  level if they should not be able to make the bot change things.
- GOAT Bot and work started from Slack never see or control this computer's
  screen on their own, even when [computer use](./computer-use.md) is on. When
  a task needs it, GOAT asks for approval in that task's thread, for a set time.
  Someone allowed to change GOAT's settings approves it in the GOAT app on
  desktop, web, or mobile; replying in Slack does not approve it. Approval
  admits that thread until the time shown, not each action, and you can end it
  early from the request.
- Ask GOAT Bot about earlier work ("did the login PR merge?", "what did the
  docs thread do?", "when did I mention the lighthouse score?") and it looks
  it up itself and answers, without starting a coding agent. It reads the work
  it started, the pull requests that work linked, the last messages of its
  coding threads, older messages in the conversation, and its notes and
  [memory](./memory.md). It shows you only work from the conversation you are
  in, work you asked for, and, if your link may read GOAT's threads, the rest.
- With every message GOAT Bot also sees a short journal of the latest work
  you may see: what was asked, how it ended, and its pull requests.
- Ask GOAT Bot "what's pending?" to see everything still open: queued,
  running, waiting on you, or finished but not yet reported to you. Say "stop
  everything" (or name one piece of work) to stop it, including anything it
  handed to subagents, on this machine or another one. A machine still on an
  older GOAT stops only the current turn; subagents it started there finish on
  their own.
- When more than one machine is connected, GOAT Bot spreads research across
  the ones with room to spare and tells you which machine ran what. It never
  starts a Boat cloud machine unless you ask.
- GOAT Bot runs up to four pieces of your work at once. More wait in order and
  start as earlier ones finish; the reply says when something is queued.
- **Settings → GOAT Bot → Automatically choose a worker computer** lets work
  use an already-connected SSH computer with the same repository and requested
  model. It is off by default. Turning it on allows the worker's instructions,
  notes and named skills to go to the selected computer. GOAT prefers ready
  accounts with more quota left and less channel work, and shows why it chose
  one. Naming a computer keeps work there. Unknown or unavailable repositories
  are skipped; GOAT does not prepare computers or sign in for this choice.
  Retrying automatically placed work chooses again; a running worker never
  moves automatically.
- Work counts as waiting on you when the agent working on it, or a subagent it
  started in GOAT, needs your approval or an answer. That includes a subagent
  running in GOAT on another machine. Subagents that run on another service
  are not counted.
- When work needs an approval, GOAT Bot sends a card saying what the agent
  wants to do. Tap Approve or Deny in GOAT. In Slack, tap the button or reply
  with its number (`2` is the second choice), or reply "approve" or "deny".
  The same number works in iMessage, which has no buttons. If several
  approvals are waiting, add the card's code, such as "approve A2". Only
  people with the same access as whoever asked for the work can answer. An
  approval on another GOAT machine is sent there; if that machine can't take
  it, answer it in that thread.
- Ask GOAT Bot to remember a standing rule ("always reply in Korean") and it
  follows it from then on, in Slack and in GOAT. It keeps a note only when the
  message you send asks for it, and each note names the message it came from.
  Notes live in
  `goat-bot/memory.md` in GOAT's data folder on that machine; edit the file
  to change them. Put written procedures in `goat-bot/skills/` as Markdown
  files, and the bot points its coding agents to the one that fits. Work sent
  to another machine gets the notes, and any procedure the request names, in
  its first message.
- If a machine running your work goes to sleep or disconnects, GOAT Bot tells
  you. Say "continue on <another host>" to continue from the last copy of its
  work, taken each time the work finishes a turn. New files over 2 MiB and new
  files that look like secrets are not copied. The work on the original machine
  is not deleted.
- When a provider has more than one signed-in account on the machine running
  the work, GOAT uses the one with more quota left and the task card says why,
  such as "Codex (work) · 20% weekly used".
- For memories used in coding conversations and shared between devices, see
  [Memory](./memory.md).
- Work you start from Slack is capped at the access level chosen when you
  created the link code. Its coding agents can use GOAT memory only as far as
  the link allows, and a link you narrow later applies to work that has not
  started yet.
- When you connect to several machines, Slack runs only on the machine GOAT
  Bot lives on. Change it in **Settings → Integrations → GOAT Bot**; set up
  Slack on that machine.
- If the machine GOAT Bot lives on is gone or stays disconnected, GOAT Bot
  stops answering on every machine and its screen says so. Use **Move GOAT Bot
  to …** there, or pick another machine in **Settings → Integrations → GOAT
  Bot**. An agent with full access can do the same on the machine it runs on
  with the `channel_bot_home_claim` tool. Other machines follow the move once
  a GOAT app connected to them is open.
- When GOAT Bot can't read a message, its reply says why, such as a model that
  needs you to sign in again or a usage limit, so you know whether resending
  helps.

## iMessage (Mac)

GOAT can read direct text messages from allowed iMessage handles on the Mac running its server
and reply in the same conversation. Group chats and attachments are not supported. An approval
or question lists choices as `1.`, `2.`, and so on; reply with that number to choose it. Give the
app that launches the server **Full Disk Access** to read Messages. macOS asks separately for
**Automation** access when GOAT sends through Messages; Messages must be signed in.

Run `goat imessage enable --allow +15551234567` on that Mac, then
`goat imessage link-code`. From the allowed phone or email, send `link 123456` to the Mac's
Messages account, replacing the example with the printed code. The connection starts with an
approval-required access ceiling; `--full-access` on enable is an explicit opt-in. Restart an
already running server after enabling. `goat imessage status` shows whether the channel is
enabled and whether the local database can be opened without printing handles or message text.
Run `goat imessage disable` to stop it and `goat imessage unlink <handle>` to revoke a linked
sender. An installed server uses its own data directory; pass `--base-dir` when managing a
different local server.
