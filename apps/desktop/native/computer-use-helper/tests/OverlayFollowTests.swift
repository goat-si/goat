// Pure checks of OverlayFollow.swift, compiled and run by
// apps/desktop/src/cua/ComputerUseHelperOverlay.test.ts on macOS.

import CoreGraphics
import Foundation

private final class FakeSchedule: OverlaySchedule {
  var cancelled = false

  func cancel() { cancelled = true }
}

private final class FakeScheduler: OverlayScheduling {
  final class Job {
    let token = FakeSchedule()
    let every: TimeInterval
    let repeats: Bool
    let handler: () -> Void

    init(every: TimeInterval, repeats: Bool, handler: @escaping () -> Void) {
      self.every = every
      self.repeats = repeats
      self.handler = handler
    }
  }

  var jobs: [Job] = []
  var activeCount: Int { jobs.filter { !$0.token.cancelled }.count }

  func schedule(every: TimeInterval, repeats: Bool, handler: @escaping () -> Void)
    -> OverlaySchedule
  {
    let job = Job(every: every, repeats: repeats, handler: handler)
    jobs.append(job)
    return job.token
  }

  @discardableResult
  func fire(_ index: Int, evenIfCancelled: Bool = false) -> Bool {
    guard jobs.indices.contains(index) else { return false }
    let job = jobs[index]
    if evenIfCancelled || !job.token.cancelled { job.handler() }
    return true
  }

  func hasJob(_ index: Int, every: TimeInterval, repeats: Bool) -> Bool {
    jobs.indices.contains(index) && jobs[index].every == every && jobs[index].repeats == repeats
  }
}

@main
struct OverlayFollowTests {
  final class State {
    var bounds: [CGWindowID: CGRect] = [:]
    var frames: [String] = []
    var borders: [Bool] = []
  }

  static func main() {
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print((ok ? "ok   " : "FAIL ") + name)
      if !ok { failures += 1 }
    }
    func rect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat = 400, _ height: CGFloat = 300)
      -> CGRect
    {
      CGRect(x: x, y: y, width: width, height: height)
    }
    func harness(_ body: (OverlayFollowController, FakeScheduler, State) -> Void) {
      let state = State()
      let scheduler = FakeScheduler()
      let controller = OverlayFollowController(
        scheduler: scheduler,
        frame: { state.bounds[$0] },
        onFrame: { state.frames.append($0.map(NSStringFromRect) ?? "nil") },
        onBorder: { state.borders.append($0) })
      body(controller, scheduler, state)
    }

    harness { controller, scheduler, state in
      state.bounds[1] = rect(10, 20)
      controller.show(windowId: 1, phase: .active)
      state.bounds[1] = rect(30, 50)
      scheduler.fire(0)
      state.bounds[1] = rect(30, 50, 500, 360)
      scheduler.fire(0)
      for _ in 0..<5 { scheduler.fire(0) }
      check(
        "visible border follows movement and resize beyond the old four samples",
        state.frames == [NSStringFromRect(rect(30, 50)), NSStringFromRect(rect(30, 50, 500, 360)), NSStringFromRect(rect(30, 50, 500, 360)), NSStringFromRect(rect(30, 50, 500, 360)), NSStringFromRect(rect(30, 50, 500, 360)), NSStringFromRect(rect(30, 50, 500, 360)), NSStringFromRect(rect(30, 50, 500, 360))]
          && scheduler.activeCount == 1 && state.borders == [true]
          && scheduler.hasJob(0, every: 0.25, repeats: true))
    }

    harness { controller, scheduler, state in
      state.bounds[1] = rect(10, 20)
      controller.show(windowId: 1, phase: .resting)
      let idleFired = scheduler.fire(1)
      check(
        "resting idle retires only the border and leaves no scheduled work",
        idleFired && state.borders == [true, false] && scheduler.activeCount == 0
          && state.frames.isEmpty && scheduler.hasJob(0, every: 0.25, repeats: true)
          && scheduler.hasJob(1, every: 2, repeats: false))
    }

    harness { controller, scheduler, state in
      state.bounds[1] = rect(10, 20)
      state.bounds[2] = rect(100, 200, 640, 480)
      controller.show(windowId: 1, phase: .resting)
      controller.show(windowId: 2, phase: .active)
      scheduler.fire(0, evenIfCancelled: true)
      scheduler.fire(2)
      check(
        "target replacement emits only the new frame and owns the sole follow timer",
        state.frames == [NSStringFromRect(rect(100, 200, 640, 480))]
          && scheduler.activeCount == 1)
    }

    harness { controller, scheduler, state in
      state.bounds[1] = rect(10, 20)
      state.bounds[2] = rect(100, 200)
      controller.show(windowId: 1, phase: .resting)
      controller.show(windowId: 2, phase: .resting)
      scheduler.fire(1, evenIfCancelled: true)
      check(
        "an old idle timer cannot hide a new target's border",
        state.borders == [true, true] && scheduler.activeCount == 2)
    }

    harness { controller, scheduler, state in
      state.bounds[1] = rect(10, 20)
      controller.show(windowId: 1, phase: .active)
      controller.hide()
      scheduler.fire(0, evenIfCancelled: true)
      check(
        "hide cancels every timer and a cancelled callback cannot redraw",
        state.borders == [true, false] && scheduler.activeCount == 0 && state.frames.isEmpty)
    }

    harness { controller, scheduler, state in
      state.bounds[1] = rect(10, 20)
      controller.show(windowId: 1, phase: .active)
      state.bounds.removeValue(forKey: 1)
      scheduler.fire(0)
      state.bounds[1] = rect(40, 60)
      scheduler.fire(0)
      check(
        "off-screen bounds hide and a later bounds read restores the same target",
        state.frames == ["nil", NSStringFromRect(rect(40, 60))])
    }

    exit(failures == 0 ? 0 : 1)
  }
}
