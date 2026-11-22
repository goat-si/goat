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

On mobile, **Something else** on a task's question lets you answer it in your own words: Send
answers that question. The "Answering" chip above the message box stays until you send, close it,
or the task records an answer.
On web and desktop, while the chat stays open, what you type into **Something else** stays until
you send or clear it. If the task records an answer first, your words show as **Not sent** until
you discard them. Opening a task, leaving the chat or reloading the page loses them.

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
  introduces itself in Slack and iMessage. Use **Instructions** for rules the bot should follow
  on every request. Changes reach the next turn after the current work ends.
- An added bot's model can change in its edit dialog or from the model button in its message
  box; its next turn uses it. **Use GOAT Bot's model** makes it follow the main
  bot's model again.
- On web and desktop, with a server that supports it, an added bot can have a color, picked in
  its edit dialog. Its chat shows your messages and the send button in that color.
- **Hide** moves a bot under **Hidden bots**; it still answers there. **Delete** archives its
  conversation and moves it under **Deleted bots**, where **Restore** brings it back with its
  history. A bot with open tasks can't be deleted until they finish or you stop them.
- [Slack](./slack.md) can reach bots you add through channel bindings or by name.
  iMessage reaches the main bot.
- In **Edit bot → Tools** on web and desktop, you can choose which MCP servers and skills a bot
  may use. Leaving an allowlist empty permits none. Narrowing a list stops active work.
  For now, a bot with tool limits can't start work. To run it again, allow all MCP servers
  and all skills. Mobile shows the bot's current tool settings.
- A bot can read files on the machine it lives on. It looks at private data such as browser
  history, mail, messages or saved credentials only when you ask about it.
- Agents can list your bots with `goat_channel_bot_list`; they can't create bots or send work to
  them.

On web and desktop, **Needs you** above the Bots list collects open questions, approvals and
other requests that need your attention, including requests from hidden bots. Expand it and select
an item to open its task. Use the **Open next bot ask** command to move through them. When more
wait than the list shows, **Show more** lists the next ones.

On a phone, while the computer GOAT Bot runs on is offline, the Bots list and **Needs you** show
what the phone last read from it, which may be out of date. You can open a bot's conversation, but
bots can't be added or changed until the computer is back. Closing the app forgets that list.
**Settings → GOAT Bot** also shows the bot's settings as the phone last read them; they can't be
changed until the computer is back.

Choose **From a template** when creating a bot to start with instructions for CI monitoring,
pull request reviews, release notes, standups, or issue triage. The picker previews the
instructions, the paused automation, and the first message. You can edit the message in
the composer before sending it. To start an automation, open the bot's Home and resume
the routine. For a webhook trigger, configure its signing secret and connect the source
before enabling it. If setup reports that it could not add the routine, choose **Retry**
in the picker or in the bot’s conversation to finish setting up the same bot.

### Share a bot’s setup

Open a bot’s row menu (long press on mobile), choose **Share setup**, and review the
`.goatbot.json` package before saving it. The file includes the bot’s profile, instructions,
automation definitions, and named tools. Conversations, notes, task history, Slack bindings,
webhook URLs, and signing secrets stay on the source computer. Export stops if text looks
like a secret. Edit the flagged fields and try again. The check catches known token shapes
and high-entropy strings. Review the file for any other private information before sharing it.

On web or desktop, choose **Import bot package** in the Bots list on the destination computer.
The review shows the fields GOAT will use and any it will ignore. Confirm to add the bot.
If setup fails after creating it, use **Retry import** in the review to finish the same bot.
Automations start paused. In the bot’s Home, provide each signed trigger’s secret and connect
its source before enabling it. Use **Edit bot → Tools** to grant access by entering the
matching local MCP server or skill identifiers. A name in the package grants no access by
itself.

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

Tasks a member bot starts in Slack appear in its **Home → Work** on
web, desktop and mobile. The member's Home shows its configured Slack
channel IDs. You can change the bindings in [Slack settings](slack.md).

On web and desktop, the bot's name at the top of its chat opens the bot's home, where **Edit
bot** changes its name, face, purpose and model. **Home** is one page: a status note when
something needs fixing, the bot's tasks, its routines and the machines its work runs on. Selecting
a task shows its conversation right there, beside the chat, and marks it read; **Go to thread**
opens it in full. A task's menu pins it, marks it done or marks it read.
A pull request on a task's row shown without Open, Merged or Closed has no state GOAT is checking;
open its thread to see where it stands.

Open the task in full to see **Done means**, the bot's completion criterion, and **Activity**.
Activity lists the latest status changes, worker launches, linked PRs, and questions. Each worker
opens in its own thread.

Use **Snooze** to set a task aside for an hour, until tomorrow, or until next week. Find it under
**Snoozed** on Home and choose **Unsnooze** to bring it back early. It also returns when the snooze
ends or the task changes status. Questions and approvals still appear in **Needs you**.
Use **Show more** in **Snoozed** to see up to 500 snoozed tasks.

With a newer server, on a computer and on mobile, the bot's work lives in its Home: a thread the
bot started leaves Threads while its task's **Show work** in Home links it (a finished task past
the first five appears after **Show more**). Some threads stay in Threads, such as launches from an older chat,
some of a long task's threads, and work on a machine this device can't open; on an older server
everything stays as it was. This holds for the computer the bot runs on in this app, while this
device can open that bot's Home; threads a bot started on your other computers are listed in
Threads as before. The unread badge on a bot's row counts recent work only; older work may be
missing. An unavailable mark means its unread or waiting count could not be read; the mark names
which.

**Show more** under the tasks reads older work page by page while the home stays open. An older
task can be shown, opened and pinned from its menu; pinned, it joins the recent tasks, where it can
be marked done or read, and opening it marks it read. On a newer server, its full view shows the task's
status and actions, on a computer and on mobile; on an older server, it points back to Home for
them, and on mobile **Open Home** opens the home over the task's view. You can also search task
titles, from the command palette on a computer and from the search field at the top of **Work** in
the home on mobile.
While no Slack channel is
connected, GOAT Bot's home also suggests connecting one; **Hide** removes the suggestion on this
device, and **Settings → GOAT Bot → Suggestions on the bot's home** brings it back.
**Library** holds the files the bot saved and its memory. On mobile, **Work** opens a sheet of the
bot's tasks, and a task opens in its own view.

- The status note says why the bot can't work right now: the machine it answers on, its model,
  open and waiting work, or Slack. Each problem comes with the action that fixes it when you're
  allowed to take it. The full status stays in **Settings → GOAT Bot**.
- **Routines** lists routines that post into this conversation, when they run next, how the last
  run went, and a switch to pause them. Dots under a routine show its recent runs; select one to
  see what started it and what it said. On web and desktop, you can also open the task if it
  started one. On mobile, an incomplete history is marked above the runs. **Check in on me** sets up a routine on the days and hours you choose: the bot
  looks over its tasks and writes only when something needs you. A timer routine whose last run failed
  shows **Run now**. **New routine** starts a routine request in the message box for you to finish
  and send. On the phone, the **+** beside the chat's message box offers it too, with your photos
  and files.
- **New routine**, **Ask to change** and **Ask to forget** fill only a message box with no words or
  files in it; blank space counts as empty. If it holds your words or files, they stay as they
  are: send or clear them first.
- A task that failed or that you stopped shows **Retry** in its task view; each
  retry runs it again as its next attempt (**Attempt 2**, then 3). While the stopped work is still
  ending, Retry is refused; try again once it has ended. Work that ran on another computer is not
  retried from here: check it on that computer, then ask the bot again.
- **Library → Memory** shows **This bot** for a member's own notes and **All bots** for shared
  notes, including notes kept before this feature. When you ask a member to remember something,
  it goes in **This bot**. To share new information, send `Remember for all bots: <note>` and
  choose **For all bots** in the reply. The main bot uses this confirmation for new shared notes.
  To edit or forget an existing shared note, choose it under **All bots**.
  Reading or using these notes requires GOAT memory access.
  Changing them requires memory write access. A full-access worker on the machine can still read
  the files directly.
- **Ask to change** or **Ask to forget** puts a request quoting the note in the message box for you to
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

From a named bot's **Home → Routines**, choose **New trigger** on web or desktop. Pick **Pull
request opened**, **Check failed**, or **Any webhook**, choose the project, and add a signing
secret. Copy the webhook URL from the saved trigger and configure the sender to sign each
delivery. A trigger saved without a secret stays paused until you add one in Scheduled tasks.
A trigger starts new work only in its selected project, with approvals required. Pausing it or
revoking the device session that authorized it blocks queued work. Open and save the trigger
again from a trusted session to authorize future work.

On web and desktop, open **Deliveries** on the trigger under **Home → Routines** or in Scheduled tasks to see why
unsigned, duplicate, and own-work events were skipped. Failed GitHub checks without a pull request are skipped unless you allow
them in the trigger. You can pause or resume a configured trigger on mobile.

## Going back to an older GOAT

Once you save a work trigger, older GOAT versions that cannot check its dispatch grant refuse to
open that database. To go back to one of those versions, restore a backup from before you saved
the first work trigger.

An older GOAT keeps your bots' data, but it doesn't know about added bots. Before you go back,
let added bots finish or stop their tasks, and don't edit added bots while the older version
runs. Work that one of them had already accepted runs as the main bot there, and its replies
stay in the main chat. After you update again, check the added bots' conversations; their tasks
return to them, but replies already shown in the main chat stay there.
