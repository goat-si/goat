struct GoatImagePreparationQueue {
  private var pending: Set<Int> = []
  private var active: Set<Int> = []

  mutating func enqueue(_ index: Int) {
    if !active.contains(index) { pending.insert(index) }
  }

  mutating func take(near current: Int) -> Int? {
    guard active.count < 2, let index = pending.min(by: {
      (abs($0 - current), $0) < (abs($1 - current), $1)
    }) else { return nil }
    pending.remove(index)
    active.insert(index)
    return index
  }

  mutating func complete(_ index: Int) {
    active.remove(index)
  }
}
