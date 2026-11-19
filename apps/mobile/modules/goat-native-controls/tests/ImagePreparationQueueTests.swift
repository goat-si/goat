@main
struct ImagePreparationQueueTests {
  static func main() {
    var queue = GoatImagePreparationQueue()
    for page in 0..<8 { queue.enqueue(page) }

    precondition(queue.take(near: 3) == 3, "The selected page starts first")
    precondition(queue.take(near: 3) == 2, "A neighbor gets the second slot")
    precondition(queue.take(near: 3) == nil, "Only two preparations run at once")

    queue.enqueue(3)
    queue.complete(2)
    precondition(queue.take(near: 6) == 6, "Paging reprioritizes queued originals")
    queue.complete(3)
    precondition(queue.take(near: 6) == 5, "Duplicate in-flight requests do not consume capacity")

    queue.complete(6)
    queue.enqueue(6)
    precondition(queue.take(near: 6) == 6, "A completed page can retry")
    queue.complete(5)
    precondition(queue.take(near: 6) == 7, "A newly selected neighbor outranks distant pages")
    print("Image preparation queue: 7 assertions passed")
  }
}
