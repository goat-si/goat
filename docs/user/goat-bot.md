# GOAT Bot

GOAT Bot is a messenger for your agents. Text it like a person: it answers, starts the work in
its own task threads, and reports back in the same conversation. Choose **Bots** in the sidebar
on web and desktop, or the Bots segment on mobile Home. To reach it from Slack or iMessage, see
[Slack](./slack.md).

The conversation holds only what you and the bot say: its answers, its questions, a line while it
works and how the work ended. On web and desktop, the tasks it starts open from **Work** in the
bot's header, where each one has its own view.

## Bots

The main bot is GOAT Bot. On servers that support it, **New bot** creates more bots, each with a
name, an emoji, a purpose and a model, and its own conversation and task list. A bot answers
under its own name and purpose from its next conversation session.

- Edit any bot, including the main one, from its row menu (long press on mobile), its name at the
  top of its chat, or **Settings → GOAT Bot → Profile**. A new name also changes how the main bot
  introduces itself in Slack and iMessage.
- An added bot's model can change in its edit dialog or from the model button at the top of its
  chat; its next turn uses it. **Use GOAT Bot's model** makes it follow the main
  bot's model again.
- **Hide** moves a bot under **Hidden bots**; it still answers there. **Delete** archives its
  conversation and moves it under **Deleted bots**, where **Restore** brings it back with its
  history. A bot with open tasks can't be deleted until they finish or you stop them.
- Bots you add are reachable in the GOAT app only. Slack and iMessage talk to the main bot.
- Notes and skills are shared by all bots on the machine GOAT Bot lives on.
- A bot can read files on the machine it lives on. It looks at private data such as browser
  history, mail, messages or saved credentials only when you ask about it.
- Agents can list your bots with `goat_channel_bot_list`; they can't create bots or send work to
  them.

## The face

Each bot's avatar shows what it is doing:

| Face                                   | Meaning                                              |
| -------------------------------------- | ---------------------------------------------------- |
| Open eyes                              | Idle                                                 |
| Eyes reading, then working with a ring | Reading your message, then working                   |
| Amber dot                              | Waiting for you: an approval, an answer or a sign-in |
| Red ring                               | The last work failed                                 |
| Happy closed eyes                      | Just finished                                        |
| Closed eyes with "z"                   | Quiet for two hours                                  |

While a bot reads or works, its eyes move now and then. Only one face moves at a time, and none
move when the window is hidden or when your system asks to reduce motion.

## Work

**Work** in the bot's header opens the bot's home. **Home** is one page: a status note when
something needs fixing, the machines its work runs on, its tasks, and its routines. Selecting a
task shows its conversation right there, beside the chat; **Go to thread** opens it in full.
**Library** holds the files the bot saved and its memory.

- The status note says why the bot can't work right now: the machine it answers on, its model,
  open and waiting work, or Slack. Each problem comes with the action that fixes it when you're
  allowed to take it. The full status stays in **Settings → GOAT Bot**.
- **Routines** lists routines that post into this conversation, when they run next, how the last
  run went, and a switch to pause them. **Check in on me** sets up a routine on the days and
  hours you choose: the bot looks over its tasks and writes only when something needs you. A
  routine whose last run failed shows **Run now**.
- A task that failed or that you stopped shows **Retry** in its task view; each
  retry runs it again as its next attempt (**Attempt 2**, then 3). While the stopped work is still
  ending, Retry is refused; try again once it has ended. Work that ran on another computer is not
  retried from here: check it on that computer, then ask the bot again.
- **Memory** shows the notes GOAT Bot keeps, newest first, with where each was asked for. **Ask
  to change** or **Ask to forget** puts a request quoting the note in the message box for you to
  send. Sent as is, it changes or forgets that note at once without starting other work, and the
  bot answers "Changed that note." or "Forgot that note." If another note change is still
  running, the note can't be found, or the file is too large to edit, the bot's answer says so
  instead. When you correct something you told it before,
  the new note replaces the old one; the old one moves behind **Show replaced notes**. The bot
  uses changed notes from your next message, and older notes that match what you ask about.
  When `memory.md` is larger than 64 KB, the tab lists only notes from its newest 64 KB; the
  file itself is unchanged.
- **Library** lists the files the bot saved, newest first. Images and text open in place; other
  files download, or open the share sheet on mobile. Files over 20 MB don't open.
- **Machines** shows which machines the bot's running tasks use.

## Going back to an older GOAT

An older GOAT keeps your bots' data, but it doesn't know about added bots. Before you go back,
let added bots finish or stop their tasks, and don't edit added bots while the older version
runs. Work that one of them had already accepted runs as the main bot there, and its replies
stay in the main chat. After you update again, check the added bots' conversations; their tasks
return to them, but replies already shown in the main chat stay there.
