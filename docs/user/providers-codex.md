# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in GOAT.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. GOAT handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in GOAT.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in GOAT and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

GOAT can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Use OpenCodex Home

Install and connect OpenCodex on the machine where Codex runs. GOAT uses that
machine's local OpenCodex service; a remote GOAT server needs its own Child.
On your Home machine, GOAT shows “This machine is your OpenCodex Home.”

In **Settings → Providers**, select the environment and add a Codex instance
that uses your Codex CLI. Name it **Codex · OpenCodex Home**, then choose
**OpenCodex Home** as its model route. The default address is
`http://127.0.0.1:10100/v1` on that environment's machine. Instances connected
through GOAT's ChatGPT sharing need a separate instance that uses your Codex CLI.
On mobile, add the instance in web or desktop Settings first.

Choose this instance in the thread's model picker. Instances using the same
**CODEX_HOME path** can continue compatible threads. GOAT reports the Home link
status and stops with an explicit error if it becomes unavailable. GOAT never
automatically switches the selected account, instance, model, or route on failure.
Check OpenCodex on the named machine, refresh provider status, and try again.
OpenCodex manages its own account selection within Home.

Use **Connect to Home** to follow the connection steps on the named host.
Use **Stop using OpenCodex Home** to return this instance to Codex's own settings.
This doesn't disconnect OpenCodex from Home. Run `ocx disconnect` on that
machine to do that. Your own Codex settings may still point at OpenCodex;
check the displayed endpoint before starting work.

When an agent asks to use or stop using Home, review the execution host,
Codex instance, current route, and requested route in the approval request.
Approving lets GOAT change that instance's model route; it does not install
OpenCodex, connect or disconnect its Home link, or give the agent permission
to manage providers. Complete any OpenCodex connection steps on that host first.
Declining leaves the route unchanged. After approving, check provider status
for the result; approval alone does not mean the change succeeded. If the request
expired or the instance changed while you reviewed it, ask the agent to request
approval again.

End this instance's active sessions and turns before changing its route.

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
