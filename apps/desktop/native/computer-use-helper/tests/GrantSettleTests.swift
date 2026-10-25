// Pure checks of PermissionSettle.swift's GrantSettle, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperGrants.test.ts on macOS.

import Foundation

/// A grant that reads as on from `onAt` seconds (nil: never), counting reads and prompts.
final class FakeGrant {
  let onAt: Double?
  var reads = 0
  var prompts = 0
  init(onAt: Double?) { self.onAt = onAt }
  func read(at now: Double, prompt: Bool) -> Bool {
    reads += 1
    if prompt { prompts += 1 }
    guard let onAt else { return false }
    return now + 1e-9 >= onAt
  }
}

/// Runs GrantSettle.read on a fake clock that only moves when it waits.
func run(prompt: Bool, accessibilityOnAt: Double?, screenOnAt: Double?)
  -> (result: (accessibility: Bool, screenRecording: Bool), accessibility: FakeGrant,
    screen: FakeGrant, waited: Double)
{
  let accessibility = FakeGrant(onAt: accessibilityOnAt)
  let screen = FakeGrant(onAt: screenOnAt)
  var now = 0.0
  let result = GrantSettle.read(
    prompt: prompt,
    accessibility: { accessibility.read(at: now, prompt: $0) },
    screenRecording: { screen.read(at: now, prompt: $0) },
    wait: { now += $0 })
  return (result, accessibility, screen, now)
}

@main
struct GrantSettleTests {
  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
      print((ok ? "ok   " : "FAIL ") + name + (ok ? "" : ": " + detail()))
      if !ok { failures += 1 }
    }

    let granted = run(prompt: false, accessibilityOnAt: 0, screenOnAt: 0)
    check(
      "grants already on are reported at once, without waiting",
      granted.result == (true, true) && granted.waited == 0, "\(granted.result) \(granted.waited)")

    let fresh = run(prompt: false, accessibilityOnAt: 0.3, screenOnAt: 0.7)
    check(
      "a grant that settles a moment after the process starts is reported on",
      fresh.result == (true, true), "\(fresh.result)")
    check(
      "reading stops as soon as every grant is on",
      abs(fresh.waited - 0.7) < 1e-9, "\(fresh.waited)")

    let denied = run(prompt: false, accessibilityOnAt: nil, screenOnAt: nil)
    check("a real denial is still reported missing", denied.result == (false, false), "\(denied.result)")
    check(
      "a denial is read again for at most the longest window, then given up",
      abs(denied.waited - GrantSettle.screenRecordingWindow) < 1e-9, "\(denied.waited)")
    check(
      "Accessibility is read only within its own shorter window",
      denied.accessibility.reads == 1 + Int((GrantSettle.accessibilityWindow / GrantSettle.step).rounded()),
      "\(denied.accessibility.reads)")

    let late = run(prompt: false, accessibilityOnAt: 3, screenOnAt: 3)
    check(
      "a grant that turns on after the window is reported missing",
      late.result == (false, false), "\(late.result)")

    let prompted = run(prompt: true, accessibilityOnAt: nil, screenOnAt: nil)
    check(
      "a prompting probe prompts once per grant, however often it reads again",
      prompted.accessibility.prompts == 1 && prompted.screen.prompts == 1,
      "\(prompted.accessibility.prompts) \(prompted.screen.prompts)")
    let silent = run(prompt: false, accessibilityOnAt: nil, screenOnAt: nil)
    check(
      "a reading probe never prompts",
      silent.accessibility.prompts == 0 && silent.screen.prompts == 0)

    exit(failures == 0 ? 0 : 1)
  }
}
