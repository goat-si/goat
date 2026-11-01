# Computer use

Computer use lets agents see and use apps on the computer that runs your GOAT
environment. Agents normally work with windows in the background. Foreground
input can briefly take your screen; threads you direct in full access mode can
use it without asking. It is powered by
[Cua Driver](https://cua.ai/docs/cua-driver).

Computer use is off until you turn it on, and it works on macOS, Windows, and
Linux.

## Turn it on

The first time you open the desktop app, GOAT asks whether agents may use this
computer, or on a later launch when it has another first-run question to ask
first. Choose **Later** to leave it off; GOAT does not ask again.

You can turn it on or off at any time in **Settings → Integrations → Computer
use**. Pick the environment whose computer agents should use, then turn on
**Computer use**. On mobile, use **Settings → Agent behavior → Computer use**.

An outside MCP client with `settings:write` can turn it on or off with
`computer_use.update`; check the result with `host.status`. Create a scoped
client token with `goat auth client create --scope orchestration:operate
--scope settings:write` or approve
full access in OAuth. Someone at the machine still needs to grant any required
operating system permissions. Agents running inside GOAT cannot change this setting.

Agents get the computer use tools from their next turn, including sessions that
are already open; Pi picks them up the next time it starts. Once an agent has
the tools, approving an app request lets it continue in the same turn. Plan
mode and read-only sessions never get them. Agents running in the cloud and
Muse Code do not get computer use, because it controls the computer that runs GOAT.

## What agents can use

Agents can see the screen and use the apps that were installed when computer use
started. They cannot use GOAT's own windows, password managers such as
Passwords, Keychain Access or 1Password, or the clipboard, and they cannot
install anything, change computer use's settings, or close apps. To let agents
use an app you installed later, turn computer use off and on again.

These limits keep agents away from places they never need. They do not stop an
agent from typing into an app it may use, so give agents work you would let
them do at that keyboard.

Computer use also blocks System Settings, login and security prompts, and Screen
Time. Full access started by a bot, channel, schedule, webhook, or another
environment cannot control Terminal or iTerm. With **Strict input
guards** on, an organization can block more apps by adding their bundle IDs to
`cuaDeniedApps` in the environment's `userdata/settings.json`, and input
without an identifiable target is refused; only a person can change these
settings.

## Ask an agent to work across the browser and apps

Agents read and use web pages in GOAT's built-in browser by default, including
pages that build their content with scripts. To have an agent use another
browser tool instead, name that tool in your request.

To keep agents away from a site, select an environment and add its host under
**Settings → Integrations → Browser → Blocked browser hosts**. On mobile, use
**Settings → Agent behavior → Preview browser**. Enter a host such as `example.com`, without a
scheme or path; its subdomains are blocked too. The list starts empty and you can remove hosts at
any time. GOAT stops agents from opening or acting on blocked sites, and if a page sends the browser
there anyway, the agent loses access to that tab for the rest of the turn. A later turn can use it
once the tab is on an allowed host.

Ask an agent to use a page in GOAT's built-in browser and an app on the computer
running that GOAT environment in the same task. Point it to a specific tab or
app when you start the turn. In the web or desktop composer, type `@` and pick
the tab from the list; the agent then works in that exact tab, even if its title
changes. Tabs that open inside the desktop app rather than on the GOAT
environment are not listed, and the mobile app cannot pick a tab yet. A tab you
opened stays yours; GOAT releases the agent's control when the turn ends. Tabs
the agent opened close when the turn ends or you press **Stop**; if one cannot
close, the thread says so and you can close it yourself. The agent may ask you
to approve an app or finish a private step.

Watch the browser and app tiles while it works. Use **Take control** or **Stop**
on the affected tile, or **Stop all** to end every agent's screen work on that
computer. The agent checks the screen again after you hand control back. A
password or passkey step in a browser tab pauses its view and input. In desktop
apps this is switched off for now; see
[Work that runs on its own](#work-that-runs-on-its-own).
When an agent asks for a password for a sign-in page, the card shows the site.
GOAT types the password into that site's password field, and the agent gets only a reference.

The cursor mark shows where the agent is working; it does not prove an action
succeeded. If an outcome is uncertain, ask the agent to inspect the target
before it tries another action.

## Site notes

GOAT can remember short notes about a site's procedures and quirks for future browser work.
Open **Settings → Memory → Sites** on the environment to view, edit, delete, or restore its
default notes. Notes belong to an HTTP or HTTPS origin and are limited to 1024 UTF-8 bytes.
Agents can save notes for sites they have visited; GOAT presents a site's note once per thread.
Do not put passwords or other secrets in notes. GOAT rejects some recognizable credentials and
password or token assignments, but that check cannot identify every secret.

## Sites you are signed in to

A tab an agent opens starts with no saved sign-ins, so it cannot reach your accounts unless
you choose a profile for it. To let an agent work in a site as you, add a profile under
**Settings → Integrations → Browser profiles**, open a tab with that profile and sign in
there, then ask the agent to use the profile by name. GOAT never moves an agent to another
profile on its own; when more than one profile could be meant, the agent has to ask you which.
A profile you filled by [importing another browser's sessions](browser-import.md) counts as one
you chose for agents too, so import only the sessions you want an agent to be able to use.

A profile keeps its sign-ins where an agent first used it: in the desktop app, or in the
browser of the GOAT environment. Agents can use it only there, and GOAT tells the agent why when
that place is not available.

When an agent fills a password, it hears that the sign-in finished only after you hand the
tab back. Screenshots and recordings of that site stay off for the rest of the thread, and for
other threads that use the same profile. GOAT hides the password in what agents read when the
page shows it as typed or in the usual web encodings; a site that changes it some other way can
still show it, so give passwords only for sites you trust.

## Approving apps

Every thread in full access mode uses every app without asking, whatever
started its turn: you, GOAT Bot, a scheduled or webhook task, Slack, or another
channel. They also get foreground input without asking. In other modes, the agent asks before it uses an app. The
request names the apps and says when approval expires. Approve it in a GOAT app
and the agent continues in the same turn, using those apps until then. Until
approved, it can list apps and windows but cannot look inside or type into them.
Choose **Allow for this conversation** to let the thread request those apps again without another
card until you stop its computer use. That choice survives a server restart, and ends when you
use **Stop**, **End computer use**, **Stop all**, or turn computer use off. Choose **Always allow**
to let threads request the apps on this environment without another card; remove an app under
**Settings → Integrations → Computer use → Allowed apps**. Removing it also ends admissions
that depend on that standing choice. Each request still receives a
time-limited admission shown in the thread, which you can end early.
After you have approved computer use on this environment once, naming an app in your own message can also allow it for the conversation without another card.
A request for foreground control says so; approving it lets the agent bring
apps forward and use keyboard or pointer focus for the stated purpose. Agents
cannot screenshot the whole display; they look at one window at a time. On
Windows, a window's screenshot can still include other windows that cover it.

Declining or cancelling ends that request. A newer request replaces the old
one. An agent waits up to ten minutes for your answer, or until the request
expires if sooner. If it stops waiting, answering later wakes the thread so it
can continue.

On a Mac, a few actions, such as saving a document while its app stays in the
background or renaming a file through Finder, also need macOS Automation
permission for that app. macOS asks once per app. Until someone at the Mac
answers, or while it is off in **System Settings > Privacy & Security >
Automation**, the agent stops that action and tells you, naming the app when it
can.

By default GOAT adds no input checks of its own: agents click by element, key
or point, bring a window forward when a background click does not land, and keep
going after a step whose effect they could not confirm. What macOS, Windows,
Linux or the driver refuses still comes back to the agent, and the limits below
still apply.

To have GOAT check input before it is sent, turn on **Strict input guards** under
**Settings > Integrations > Computer use > Advanced**. With it on, a call that
would move your pointer does not run unless **Let agents move my pointer** is
also on, sending in a chat app needs the agent to say it is sending, paste,
renaming a list item by typing and clicks outside the window are refused,
foreground is used only after element and keyboard tries, approved-app lists
and `cuaDeniedApps` apply, and a failed step stops the steps after it.

**Stop** on a thread stops its computer use at once, even in the middle of an
action sequence. Pause, takeover and private mode also revoke foreground
control. After pause or Stop, a full-access thread gets foreground control
automatically only on its next turn.

Full access skips app and foreground approvals. Everything else on this page still
applies to it: password managers and GOAT's own windows stay off limits, a
secret field in a browser tab still pauses agents, each action stays within
what its call may reach, and work that runs on its own still shares the screen
one thread at a time. **Stop**, **Stop all** and turning computer use off
end it, and leaving full access ends automatic access at once.

Once admitted, agents keep working while you use the keyboard and mouse. Use
**Stop**, **Stop all**, or **Hand back** when you want to interrupt them; a
password, one-time code, or passkey field in a browser tab still pauses them
automatically.

## Watching agents

While agents use the built-in browser or this computer, GOAT shows them in a
stack at the right of the window, one tile each, with what the agent works on,
its thread and whether the agent or you are in control. Browser tiles show a
small live picture; it pauses while the stack is hidden or GOAT is in the
background. Click a browser tile to open its full preview, where **Take
control** hands it to you.

**Stop** on a tile stops that agent until you choose **Hand back**. On a tile
for this computer, Stop also ends that thread's approval, so its apps are free
for other threads at once. On its next turn, the thread asks again unless it is
in full access. **Stop all**
at the top of the stack stops every agent on this computer, including approved
work that runs on its own. While a page asks for a password, a one-time code or
a passkey, its tile reads **Private (paused)** and agents can neither see nor
use the page until you leave that field.

The GOAT menu bar or taskbar menu offers the same stops, per app or all at
once; its **Stop All Computer Use** also stops agents in browser tabs, like
Stop all here.

When an agent needs you for a step it cannot do, such as a sign-in, a second
factor or a CAPTCHA, it asks: its tile reads **Waiting for you** with what it
needs, and the request also appears in its thread on every device. The agent
stays off that tab, or off this computer, until you finish the step and choose
**Hand back**, or answer the request in the thread. Then the agent picks up
where it stopped. If nobody answers within 30 minutes, the request expires and
the agent hears that too.

## The Computer Use skill

Every turn that gets the computer use tools also gets GOAT's built-in
**Computer Use** skill. It tells agents to work in one window at a time, run
steps they have already decided as one batch and check the result, make sends,
purchases and deletions one checked step at a time, stop when you take over or
press Stop, and hand sign-ins, payments, and other private steps to you. It
appears as a built-in skill in the composer's `$` menu.

To keep the tools without the skill, turn off **Computer Use skill** under
**Computer use** in the same settings.

## Work that runs on its own

GOAT Bot, work started from Slack or iMessage, scheduled and webhook tasks, and
threads any of them start use every app and foreground input without asking
when they run in full access mode, and need approval otherwise. When such a
thread needs approval, GOAT asks in that
thread. The request names the thread, this computer, what the agent wants to do,
and until when. Someone allowed to change this environment's settings approves
it in a GOAT app; a reply in a chat channel does not count.

In full access mode, a thread started from another computer's GOAT uses every
app here beside the threads you run, rather than waiting for the screen.
Detecting secret fields in desktop apps is switched off while it is being
fixed, so a secret field in a desktop app does not pause agents.
Admitted work keeps running while you use the keyboard and mouse. Approval lasts
until the time shown and does not approve each action. If the agent already has
the tools, it continues in the same turn; otherwise, GOAT wakes it in a new turn
with computer use available. Threads approved for different apps work at the
same time, each in its own apps. An app belongs to one thread at a time, and
approving the whole screen waits until no other thread holds an app. While another thread holds apps, an
agent works on its windows in the background and does not bring them to the
front or move the pointer. Threads you run yourself can still use the screen
meanwhile, so they may get in each other's way.
Choose **End computer use** on the request in the thread to stop it early;
turning computer use off also stops it. When the time runs out or you end it,
GOAT stops the agent's computer use right away, even in the middle of an action
sequence: the step already under way finishes, and nothing after it runs.

If such work sends a message to a thread you are running, it does not join your
turn; it waits and runs as that thread's next turn, without computer use unless
that thread is approved or runs in full access mode.

## macOS permissions

On a Mac, GOAT needs **Accessibility** and **Screen Recording**. When you turn
computer use on from the desktop app on that Mac, GOAT walks you through both
and then checks that they work: it restarts computer use, has it read and
capture one of GOAT's own windows, and shows which check failed if one did. Keep
a GOAT window visible and the Mac unlocked while it checks.
After GOAT, its helper or the Mac restarts, updates or wakes, the check may need
to run again. In the GOAT desktop app on that Mac, choose **Run check** when it is
available.

If a permission stays off after you allow it, quit and reopen GOAT. After GOAT
updates, **Accessibility** can show as on in System Settings while macOS still
refuses it; switch **GOAT Computer Use** off and on again in **Privacy & Security
→ Accessibility**. If you later
turn a permission off in **System Settings → Privacy & Security**, the setting
shows it as off; choose **Set up** to allow it again.

If agent connections to computer use keep failing on a computer even though its
checks pass, the setting shows why, and agents are told computer use is
unavailable there instead of retrying. It clears as soon as an agent connection
works again.

From another computer or the mobile app connected directly to that Mac, with
permission to change its settings, the switch turns computer use on and you can
approve its requests there, but someone at that Mac still has to grant both
permissions once.

A GOAT server started from a terminal, a service, or another GOAT over SSH
(listed as **Headless server**) cannot use computer use on a Mac, because macOS
would give the permissions to whatever started it. Agents there are told which
GOAT desktop apps the Mac has and whether they are older than that server. At
the Mac or over Screen Sharing, update the desktop app if needed and open it,
then connect to the app's environment and start new threads there. Other GOATs
that reach this Mac over SSH move to the app's server only once the background
server has no running work, and a GOAT app connected straight to the
background server stays on it. Threads already on the background server keep
running there without computer use.

## Windows and Linux

Windows and Linux need someone signed in to the desktop. On Windows, someone at
that computer may need to respond to a security prompt the first time. GOAT
started over SSH or as a service runs where Windows has no desktop, so computer
use cannot turn on there; start GOAT from the signed-in desktop instead.

On Linux, computer use works best in an X11 session. In a Wayland session it
works with fewer apps, and your desktop may ask you to approve screen capture.
A headless server with Xvfb also works. Without AT-SPI (the `at-spi2-core`
package) and a D-Bus session, agents can take screenshots and use the mouse and
keyboard but cannot read app controls.
Window screenshots on Linux need a desktop that composites its windows (a bare
Xvfb needs a compositor such as xcompmgr). In a Wayland session without
XWayland, other than Hyprland, agents read app controls but get no window
screenshots. A screenshot shows the window as the desktop draws it; a part an
app never painted can still show what was behind the window when it opened.

## Other computers

Each connected computer has its own switch. Before you turn it on, Settings
checks that computer's screen: the switch and **Settings → Connections →
Advanced settings → Hosts** show whether computer use is available, limited, or
unavailable there, and why. A computer
with no usable screen, such as a Linux server without a display or Windows
reached over SSH, keeps the switch off. A limited one can turn on and shows
what agents cannot do.

Turning it on downloads Cua Driver to that computer's GOAT folder, under
`tools/cua-driver/<version>`, and checks the download; if that fails, the
switch stays off and says why. GOAT checks the screen again each time computer
use starts. A Mac shows as limited until computer use has run there once and
confirmed both permissions.

## Privacy

Computer use sends no usage data and does not check for its own updates. It
updates with GOAT.

## Turn it off

Turn off **Computer use** in Settings. GOAT stops it right away, and new agent
sessions no longer get the tools. The downloaded driver stays on that computer.
To remove it, delete `tools/cua-driver` in that computer's GOAT folder (for
example `rm -rf ~/.goat/tools/cua-driver`); GOAT downloads it again if you turn
computer use back on.
