# GOAT Bot

GOAT Bot is a messenger for your agents. Text it like a person: it answers, starts the work in
its own task threads, and reports back in the same conversation. Choose **Bots** in the sidebar
on web and desktop, or the Bots segment on mobile Home. To reach it from Slack or iMessage, see
[Slack](./slack.md).

With a GOAT server that lists the bot's work, the conversation holds only what you and the bot
say: its answers, its questions, a line while it works and how the work ended. The tasks it starts
open from the bot's home: select the bot's name at the top of its chat. Finished work whose ending
the chat never told, such as a request made from Slack, keeps its card. Older servers show each
task as a card in the conversation.

## Bots

The main bot is GOAT Bot. On servers that support it, **New bot** creates more bots, each with its
own conversation and task list. **New bot** in the Bots list, or in the command palette on web and
desktop, creates the bot at once as "New bot" (or "New bot 2", and so on) and opens its chat,
where a row above the message box asks for its name; **More** there opens its look, purpose and
model. If you move on before the bot is ready, it waits in the Bots list instead. A bot answers
under its own name and purpose from its next conversation session.

- Edit any bot, including the main one, from its row menu (long press on mobile), **Edit bot** in
  its home (its name at the top of its chat on web and desktop), or **Settings → GOAT Bot →
  Profile**. A new name also changes how the main bot
  introduces itself in Slack and iMessage.
- An added bot's model can change in its edit dialog or from the model button in its message
  box; its next turn uses it. **Use GOAT Bot's model** makes it follow the main
  bot's model again.
- On web and desktop, with a server that supports it, an added bot can have a color, picked in
  its edit dialog. Its chat shows your messages and the send button in that color.
- **Hide** moves a bot under **Hidden bots**; it still answers there. **Delete** archives its
  conversation and moves it under **Deleted bots**, where **Restore** brings it back with its
  history. A bot with open tasks can't be deleted until they finish or you stop them.
- Bots you add are reachable in the GOAT app only. Slack and iMessage talk to the main bot.
- Notes and skills are shared by all bots on the machine GOAT Bot lives on.
- A bot can read files on the machine it lives on. It looks at private data such as browser
  history, mail, messages or saved credentials only when you ask about it.
- Agents can list your bots with `goat_channel_bot_list`; they can't create bots or send work to
  them.

On web and desktop, **Needs you** above the Bots list collects open questions, approvals and
other requests that need your attention, including requests from hidden bots. Expand it and select
an item to open its task. Use the **Open next bot ask** command to move through them. When more
wait than the list shows, **Show more** lists the next ones.

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

On web and desktop, the bot's name at the top of its chat opens the bot's home, where **Edit
bot** changes its name, face, purpose and model. **Home** is one page: a status note when
something needs fixing, the machines its work runs on, its tasks, and its routines. Selecting a
task shows its conversation right there, beside the chat; **Go to thread** opens it in full.
**Library** holds the files the bot saved and its memory. On mobile, **Work** opens a sheet of the
bot's tasks, and a task opens in its own view.

- The status note says why the bot can't work right now: the machine it answers on, its model,
  open and waiting work, or Slack. Each problem comes with the action that fixes it when you're
  allowed to take it. The full status stays in **Settings → GOAT Bot**.
- **Routines** lists routines that post into this conversation, when they run next, how the last
  run went, and a switch to pause them. **Check in on me** sets up a routine on the days and
  hours you choose: the bot looks over its tasks and writes only when something needs you. A
  routine whose last run failed shows **Run now**. **New routine** starts a routine request in the
  message box for you to finish and send.
- **New routine**, **Ask to change** and **Ask to forget** fill only an empty message box. If it
  already holds your text or files, they stay as they are: send or clear them first.
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
