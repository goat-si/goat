# Codex

Use your ChatGPT plan, an existing Codex CLI login, or OpenCodex Home to code in GOAT.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. GOAT handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in GOAT.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

Fast and Ultrafast speeds are unavailable with this connection. To use the speed
options your account supports, [use an existing Codex login](#use-an-existing-codex-login).

When reconnecting, choose the same account in GOAT and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

GOAT can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

Running `codex login` does not change a managed ChatGPT connection. In
**Settings → Providers**, add a Codex instance, choose **Configure manually**,
and complete the wizard. Then select that instance from the thread’s model picker.

## Change an instance's settings

Changing a Codex instance's binary path, launch arguments, environment,
CODEX_HOME or shadow home path, route or Home authentication, or turning the
instance off, restarts its Codex process. GOAT restarts it at once when nothing
is running on it. Otherwise running turns, goals and subagents finish on the
current process first, and until they do a new turn on that instance stops with
a message; stop that work to restart sooner. Editing custom models does not
restart Codex.

## Use OpenCodex Home

OpenCodex Home keeps your provider accounts on one machine and relays model
requests from your other machines, its Children. Every Child shares Home's
quota. On your Home machine, GOAT shows “This machine is your OpenCodex Home.”
GOAT uses OpenCodex on the machine where Codex runs, so a remote GOAT server
needs its own Child.

To make a new Linux or macOS machine a Child, install GOAT and OpenCodex there
with the [server installer's `--opencodex` option](./install.md#a-server-only-machine),
then join it from [Hub devices](./hub.md#add-repair-or-remove-a-device) on
Home. For an SSH host with **Join as OpenCodex Child after each SSH setup**
turned on, or a cloud machine Home created, GOAT also installs Codex there and
adds a Codex instance that uses Home without a sign-in on that machine. The
Child is **Ready** after one small model request from that instance succeeds
through Home; the request counts against Home's quota. If setup stops, the
device's row in Hub devices says what to do next, such as updating OpenCodex
on the Child.

To route another Codex instance, open **Settings → Providers**, select the
environment and the instance, and choose **Use OpenCodex Home** under **Model
route**. The default address is `http://127.0.0.1:10100/v1` on that
environment's machine. **Home authentication** sets what the instance sends to
Home: **None** needs no sign-in on that machine, and **OpenAI** keeps the
instance's own sign-in. A Codex instance that GOAT manages always uses
**None**. On mobile, the same choices are in **Settings → Provider accounts**;
a server that is too old for them asks you to update it first.

Choose the instance in the thread's model picker. Instances using the same
**CODEX_HOME path** can continue compatible threads; after you change Home
authentication, whether a thread continues depends on Codex, so keep the
original instance if it cannot. GOAT reports the Home link status and stops
with an explicit error if Home becomes unavailable. GOAT never automatically
switches the selected account, instance, model, or route on failure. Check
OpenCodex on the named machine, select **Check status**, and try again.
OpenCodex manages its own account selection within Home.

If the machine is not linked to Home yet, **Open Hub devices** takes you to the
hub's device list, where you add or repair it.
Use **Stop using OpenCodex Home** to return this instance to Codex's own settings.
This doesn't disconnect OpenCodex from Home: use **Leave** in Hub devices, or
run `ocx disconnect` on that machine. Your own Codex settings may still point
at OpenCodex; check the displayed endpoint before starting work.

When an agent asks to use or stop using Home, review the execution host,
Codex instance, current route, and requested route in the approval request.
Approving lets GOAT change that instance's model route; it does not install
OpenCodex, connect or disconnect its Home link, or give the agent permission
to manage providers. Complete any OpenCodex connection steps on that host first.
Declining leaves the route unchanged. After approving, check provider status
for the result; approval alone does not mean the route works or the Child is
Ready. If the request expired or the instance changed while you reviewed it,
ask the agent to request approval again.

Changing the route or Home authentication restarts the instance's Codex process;
see [Change an instance's settings](#change-an-instances-settings).

[Claude Code](./providers-claude.md#use-opencodex-home),
[OpenCode](./providers-opencode.md#use-opencodex-home), and
[Pi](./providers-pi.md#use-opencodex-home) can use Home too, once you route
them there.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through GOAT leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. GOAT prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. GOAT offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

## Keep a turn running across a restart

On macOS and Linux, **Settings → General → Keep Codex turns running** controls
whether an active Codex turn stays running when the GOAT server stops. The default,
**Restarts and updates**, keeps it running across server restarts and updates;
**Also after quitting the app** includes quitting the desktop app. Choose **Off**
to disable this behavior. Windows does not support it. This setting is independent
of **Continue threads after restarts**, which controls ordinary continuation of
interrupted threads.

After GOAT reconnects, progress from a surviving turn appears when the turn
finishes. GOAT tools are unavailable for the rest of that turn. You can stop the
turn, but Steer is refused while GOAT is waiting for it. Goal threads do not
survive a restart; once blocked work has stopped, you can continue the thread.
The next turn GOAT starts in that thread reloads the conversation so GOAT tools
work again, which also stops background terminals from before the restart, such
as a dev server.

If a Codex process kept from before the restart exits later, the next message starts
a new one. When GOAT cannot confirm that the old process is gone, the thread names
its process group so you can stop it, and GOAT checks again on the next message.
A few cases, such as a process group id that another program now uses, still need
a GOAT restart; the thread says so when that applies.

A message you send while such a turn still runs waits for it, and so does one sent
while Codex runs a turn no message started, such as a goal continuation. The thread
says which Codex turn the message waits for. For a turn no message started,
**Stop that turn** ends it so the message starts. It also pauses the thread's
Codex goal, so Codex starts no more goal turns until you resume the goal.

## Give each thread its own Codex app-server

On macOS and Linux, **Settings → General → Codex app-servers** controls how many
Codex processes an environment runs. **Shared**, the default, runs one app-server
for every thread of a Codex provider. **One per thread** gives each new thread its
own app-server, so a crash or restart of that process stops only its thread. Each
app-server uses its own memory, so many open threads use more memory than one
shared process. Subagents always run in their parent thread's app-server.

The setting applies to new threads. Existing threads keep the process they started
with, so switching back to **Shared** takes effect for threads you start afterwards.

An app-server reads Codex's model catalog (`model_catalog_json`, which OpenCodex
writes) only when it starts. When the catalog changes a model, for example its
context window, a new thread on that model gets its own app-server that reads the
change. A thread already open on the shared app-server gets it on its next turn once
that app-server has no running work, when GOAT restarts it; until then the thread's
turns keep the details the app-server started with.
After GOAT itself restarts, an app-server kept running across the restart serves the
first turn sent to it, because it may still hold that earlier work. The next turn
restarts it once it is idle.
