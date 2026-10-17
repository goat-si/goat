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
   the `app_mention` and `message.im` events, then install the app to your
   workspace.
3. In GOAT, open **Settings → Integrations → Slack** for the machine that
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
- Ask GOAT Bot to remember a standing rule ("always reply in Korean") and it
  follows it from then on, in Slack and in GOAT. It keeps a note only when the
  message you send asks for it, and each note names the message it came from.
  Notes live in
  `goat-bot/memory.md` in GOAT's data folder on that machine; edit the file
  to change them. Put written procedures in `goat-bot/skills/` as Markdown
  files, and the bot points its coding agents to the one that fits.
- For memories used in coding conversations and shared between devices, see
  [Memory](./memory.md).
- Work you start from Slack is capped at the access level chosen when you
  created the link code. Its coding agents can use GOAT memory only as far as
  the link allows, and a link you narrow later applies to work that has not
  started yet.
- When you connect to several machines, Slack runs only on the machine GOAT
  Bot lives on. Change it in **Settings → Integrations → GOAT Bot**; set up
  Slack on that machine.
