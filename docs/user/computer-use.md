# Computer use

Computer use lets agents see and use apps on the computer that runs your GOAT
environment. Agents work with windows in the background, so they do not take
over your cursor or keyboard while you work. It is powered by
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
are already open; Pi picks them up the next time it starts. Plan mode and
read-only sessions never get them. Agents running in the cloud and Muse Code do
not get computer use, because it controls the computer that runs GOAT.

## What agents can use

Agents can see the screen and use the apps that were installed when computer use
started. They cannot use GOAT's own windows, password managers such as
Passwords, Keychain Access or 1Password, or the clipboard, and they cannot
install anything, change computer use's settings, or close apps. To let agents
use an app you installed later, turn computer use off and on again.

These limits keep agents away from places they never need. They do not stop an
agent from typing into an app it may use, so give agents work you would let
them do at that keyboard.

## The Computer Use skill

Every turn that gets the computer use tools also gets GOAT's built-in
**Computer Use** skill. It tells agents to work in one window at a time, check
the result of each step, stop when you take over or press Stop, and hand
sign-ins, payments, and other private steps to you. It appears as a built-in
skill in the composer's `$` menu.

To keep the tools without the skill, turn off **Computer Use skill** under
**Computer use** in the same settings.

## Work that runs on its own

Work nobody is watching does not get computer use by itself: GOAT Bot, work
started from Slack or iMessage, scheduled and webhook tasks, and threads any of
them start. When such a thread needs the screen, GOAT asks in that thread. The
request names the thread, this computer, what the agent wants to do, and until
when. Someone allowed to change this environment's settings approves it in a
GOAT app; a reply in a chat channel does not count.

Approving admits that thread until the time shown. It does not approve each
action. Only one such thread uses the screen at a time, and threads you run
yourself can still use it meanwhile, so the two may get in each other's way.
Choose **End computer use** on the request in the thread to stop it early;
turning computer use off also stops it. When the time runs out or you end it,
GOAT stops the agent's computer use right away, even in the middle of an action
sequence: the step already under way finishes, and nothing after it runs.

If such work sends a message to a thread you are running, it does not join your
turn; it waits and runs as that thread's next turn, without computer use unless
that thread is approved.

## macOS permissions

On a Mac, GOAT needs **Accessibility** and **Screen Recording**. When you turn
computer use on from the desktop app on that Mac, GOAT walks you through both
and then checks that they work: it restarts computer use, has it read and
capture one of GOAT's own windows, and shows which check failed if one did. Keep
a GOAT window visible and the Mac unlocked while it checks.

If a permission stays off after you allow it, quit and reopen GOAT. If you later
turn a permission off in **System Settings → Privacy & Security**, the setting
shows it as off; choose **Set up** to allow it again.

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
