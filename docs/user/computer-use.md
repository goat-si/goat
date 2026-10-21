# Computer use

Computer use lets agents see and use apps on the computer that runs your GOAT
environment. Agents work with windows in the background, so they do not take
over your cursor or keyboard while you work. It is powered by
[Cua Driver](https://cua.ai/docs/cua-driver).

Computer use is off until you turn it on, and it works on macOS, Windows, and
Linux.

## Turn it on

The first time you open the desktop app, GOAT asks whether agents may use this
computer. Choose **Later** to leave it off; GOAT does not ask again.

You can turn it on or off at any time in **Settings → Integrations → Computer
use**. Pick the environment whose computer agents should use, then turn on
**Computer use**. On mobile, use **Settings → Agent behavior → Computer use**.

Agent sessions you start afterwards get the computer use tools. Sessions that
were already running keep the tools they started with, so start a new session
after changing the setting. Agents running in the cloud do not get computer use,
because it controls the computer that runs GOAT.

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
someone at that Mac still has to grant both permissions there. For a server run
from a terminal or a service, grant them to the app or process that runs the
server.

## Windows and Linux

Windows and Linux need someone signed in to the desktop. On Windows, someone at
that computer may need to respond to a security prompt the first time.

On Linux, computer use works best in an X11 session. In a Wayland session it
works with fewer apps, and your desktop may ask you to approve screen capture.

## Privacy

Computer use sends no usage data and does not check for its own updates. It
updates with GOAT.

## Turn it off

Turn off **Computer use** in Settings. GOAT stops it right away, and new agent
sessions no longer get the tools.
