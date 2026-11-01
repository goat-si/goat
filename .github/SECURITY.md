# Security policy

GOAT's maintainers handle security reports for this repository and for the GOAT releases built from it.

## Supported versions

GOAT publishes two release channels in [goat-si/goat-releases](https://github.com/goat-si/goat-releases/releases).
Security fixes go into the newest release of each channel. Older releases do not get fixes, so update
before you report a problem you found in one.

| Release                                  | Supported |
| ---------------------------------------- | --------- |
| Latest stable release (marked "Latest")  | Yes       |
| Latest nightly (prerelease)              | Yes       |
| Older stable releases and nightlies      | No        |
| Preview builds attached to pull requests | No        |

A fix merges to `dev` and ships in the next nightly. Stable releases are promoted from nightlies that
have been out for at least 24 hours, and an urgent fix can be promoted sooner.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the [Security tab](https://github.com/goat-si/goat/security)
of goat-si/goat and choose **Report a vulnerability**, or go straight to the
[report form](https://github.com/goat-si/goat/security/advisories/new). Only you and the
maintainers can see the report. Do not open a public issue, discussion, or pull request for a vulnerability.

Include what you can of the following:

- the GOAT version and channel, and the platform (desktop, web, mobile, or a headless server);
- how the client, server, and agent were connected, if more than one machine was involved;
- steps to reproduce, and the impact you observed or expect.

## What to expect

GOAT is maintained by a small team, so we cannot promise fixed response or fix times. We read every
report, answer in the private advisory, and keep you updated there while we investigate. When we confirm
a vulnerability, we fix it, publish the advisory with the release that contains the fix, and credit you
there unless you ask us not to. Please keep the details private until that advisory is published.

## Scope

GOAT's code in this repository and the releases in goat-si/goat-releases are in scope. Report problems in
a provider's own CLI or service, such as Codex or Claude Code, to that vendor.
