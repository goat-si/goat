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

## Approving apps

Every thread in full access mode uses every app without asking, whatever
started its turn: you, GOAT Bot, a scheduled or webhook task, Slack, or another
channel. Threads you direct in full access mode also get foreground input
without asking. In other modes, the agent asks before it uses an app. The
request names the apps and says when approval expires. Approve it in a GOAT app
and the agent continues in the same turn, using those apps until then. Until
approved, it can list apps and windows but cannot look inside or type into them.
A request for foreground control says so; approving it lets the agent bring
apps forward and use keyboard or pointer focus for the stated purpose. Agents
cannot screenshot the whole display; they look at one window at a time. On
Windows, a window's screenshot can still include other windows that cover it.

Declining or cancelling ends that request. A newer request replaces the old
one. An agent waits up to ten minutes for your answer, or until the request
expires if sooner. If it stops waiting, answering later wakes the thread so it
can continue.

Your pointer stays where you put it. By default agents never move it: they
click through an element's accessibility action, the keyboard, or a background
click that shows only their own cursor, and a call that would move your pointer
does not run. If an app ignores background clicks, the agent tells you. To let
full access agents move your pointer for such apps, turn on **Let agents move my
pointer** under **Settings > Integrations > Computer use > Advanced**.

**Stop** on a thread stops its computer use at once, even in the middle of an
action sequence. Pause, takeover and private mode also revoke foreground
control. After pause or Stop, a full-access thread gets foreground control
automatically only on its next turn.

Full access skips only the app approval. Everything else on this page still
applies to it: password managers and GOAT's own windows stay off limits, a
secret field still pauses agents, each action stays within what its call may
reach, and work that runs on its own still asks for foreground control, still
needs a computer that can tell when you type a secret, and still shares the
screen one thread at a time. **Stop**, **Stop all** and turning computer use off
end it, and leaving full access ends automatic access at once.

Once admitted, agents keep working while you use the keyboard and mouse. Use
**Stop**, **Stop all**, or **Hand back** when you want to interrupt them; a
password, one-time code, or passkey field still pauses them automatically.

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

## The Computer Use skill

Every turn that gets the computer use tools also gets GOAT's built-in
**Computer Use** skill. It tells agents to work in one window at a time, check
the result of each step, stop when you take over or press Stop, and hand
sign-ins, payments, and other private steps to you. It appears as a built-in
skill in the composer's `$` menu.

To keep the tools without the skill, turn off **Computer Use skill** under
**Computer use** in the same settings.

## Work that runs on its own

GOAT Bot, work started from Slack or iMessage, scheduled and webhook tasks, and
threads any of them start use every app without asking when they run in full
access mode, and need approval otherwise. They still need approval for
foreground control. When such a thread needs approval, GOAT asks in that
thread. The request names the thread, this computer, what the agent wants to do,
and until when. Someone allowed to change this environment's settings approves
it in a GOAT app; a reply in a chat channel does not count.

Such work only gets the screen on a computer whose GOAT can tell when you enter
a password or another secret; elsewhere the request is refused and says why.
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
GOAT keeps that result only until it, its helper or the Mac restarts, updates or
wakes; the setting then shows the capture step as not checked and offers **Run
check** whenever no agent is using computer use.

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

From another computer or the mobile app, the switch turns computer use on, but
someone at that Mac still has to grant both permissions there. A GOAT server
started from a terminal or a service cannot use computer use on a Mac, because
macOS would give the permissions to the terminal; open the GOAT desktop app on
that Mac instead.

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
screenshots. Before each screenshot the app is asked to redraw its window, and
an app that does not redraw all of it promptly gets no screenshot that time.

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
