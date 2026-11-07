# GOAT Bot

GOAT Bot is a messenger for your agents. Text it like a person: it answers, starts the work in
its own task threads, and reports back in the same conversation. Choose **Bots** in the sidebar
on web and desktop, or the Bots segment on mobile Home. To reach it from Slack or iMessage, see
[Slack](./slack.md).

## Bots

The main bot is GOAT Bot. On servers that support it, **New bot** creates more bots, each with a
name, an emoji, a purpose and a model, and its own conversation and task list. A bot answers
under its own name and purpose from its next conversation session.

- Edit any bot, including the main one, from its row menu (long press on mobile) or **Settings →
  GOAT Bot → Profile**. A new name also changes how the main bot introduces itself in Slack and
  iMessage.
- **Hide** moves a bot under **Hidden bots**; it still answers there. **Delete** archives its
  conversation and moves it under **Deleted bots**, where **Restore** brings it back with its
  history. A bot with open tasks can't be deleted until they finish or you stop them.
- Bots you add are reachable in the GOAT app only. Slack and iMessage talk to the main bot.
- Notes and skills are shared by all bots on the machine GOAT Bot lives on.
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

**Work** in the bot's header opens its tasks, routines, memory and status.

- **Status** says whether the bot can work right now and why not: the machine it answers on, its
  model, open and waiting work, and Slack. Each problem comes with the action that fixes it when
  you're allowed to take it.
- **Routines** lists routines that post into this conversation, when they run next, how the last
  run went, and a switch to pause them. **Check in on me** sets up a routine on the days and
  hours you choose: the bot looks over its tasks and writes only when something needs you.
- **Memory** shows the notes GOAT Bot keeps, newest first, with where each was asked for. **Ask
  to change** or **Ask to forget** puts a request quoting the note in the message box for you to
  send. When you correct something you told it before, the new note replaces the old one. Notes
  reach the bot from its next conversation session.

## Going back to an older GOAT

An older GOAT keeps your bots' data, but it doesn't know about added bots. Before you go back,
let added bots finish or stop their tasks, and don't edit added bots while the older version
runs. Work that one of them had already accepted runs as the main bot there, and its replies
stay in the main chat. After you update again, check the added bots' conversations; their tasks
return to them, but replies already shown in the main chat stay there.
