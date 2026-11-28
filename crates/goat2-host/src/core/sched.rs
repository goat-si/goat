//! Global caps: concurrent runs (4) with a priority queue, concurrent process starts (2).
//!
//! Waiting order (PRD runtime.md "줄과 상한"): human input first, child results next, background
//! last; a waiter moves up one class after 15 s and two after 30 s, so nothing starves.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot};

/// Who is waiting for a run slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Human = 0,
    Child = 1,
    Background = 2,
}

struct Waiter {
    priority: Priority,
    since: Instant,
    tx: oneshot::Sender<RunPermit>,
}

struct State {
    running: usize,
    waiters: Vec<Waiter>,
}

pub struct Scheduler {
    max_runs: usize,
    state: Mutex<State>,
    starts: Arc<Semaphore>,
}

/// Holds one run slot until dropped.
pub struct RunPermit {
    sched: Option<Arc<Scheduler>>,
}

impl std::fmt::Debug for RunPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RunPermit")
    }
}

/// See [Scheduler::park].
pub struct Parked {
    sched: Arc<Scheduler>,
}

impl Drop for Parked {
    fn drop(&mut self) {
        self.sched.state.lock().expect("sched").running += 1;
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        if let Some(sched) = self.sched.take() {
            sched.release();
        }
    }
}

const AGE_ONE: Duration = Duration::from_secs(15);
const AGE_TWO: Duration = Duration::from_secs(30);

fn effective(w: &Waiter, now: Instant) -> i32 {
    let waited = now.saturating_duration_since(w.since);
    let boost = if waited >= AGE_TWO {
        2
    } else if waited >= AGE_ONE {
        1
    } else {
        0
    };
    w.priority as i32 - boost
}

impl Scheduler {
    pub fn new(max_runs: usize, max_starts: usize) -> Arc<Self> {
        Arc::new(Self {
            max_runs,
            state: Mutex::new(State {
                running: 0,
                waiters: Vec::new(),
            }),
            starts: Arc::new(Semaphore::new(max_starts)),
        })
    }

    /// Ask for a run slot. The receiver resolves when the slot is granted; dropping it gives
    /// the slot to the next waiter.
    pub fn acquire(self: &Arc<Self>, priority: Priority) -> oneshot::Receiver<RunPermit> {
        let (tx, rx) = oneshot::channel();
        let mut state = self.state.lock().expect("sched");
        if state.running < self.max_runs && state.waiters.is_empty() {
            state.running += 1;
            drop(state);
            let permit = RunPermit {
                sched: Some(self.clone()),
            };
            if let Err(mut permit) = tx.send(permit) {
                permit.sched = None;
                self.state.lock().expect("sched").running -= 1;
            }
        } else {
            state.waiters.push(Waiter {
                priority,
                since: Instant::now(),
                tx,
            });
        }
        rx
    }

    /// One process-start slot (awaits).
    pub async fn start_slot(&self) -> OwnedSemaphorePermit {
        self.starts
            .clone()
            .acquire_owned()
            .await
            .expect("start semaphore never closes")
    }

    /// A run blocked on a child (`thread.wait`, `thread.start {mode: wait}`) lends its slot
    /// while it waits and takes it back on drop, which may exceed the cap for a moment (a parked
    /// run uses no CPU). Without this, four parents waiting on children hold every slot and
    /// the children never start.
    pub fn park(self: &Arc<Self>) -> Parked {
        self.release();
        Parked {
            sched: self.clone(),
        }
    }

    pub fn running(&self) -> usize {
        self.state.lock().expect("sched").running
    }

    pub fn waiting(&self) -> usize {
        self.state.lock().expect("sched").waiters.len()
    }

    fn release(self: &Arc<Self>) {
        let mut state = self.state.lock().expect("sched");
        state.running -= 1;
        while state.running < self.max_runs && !state.waiters.is_empty() {
            let now = Instant::now();
            let best = state
                .waiters
                .iter()
                .enumerate()
                .min_by_key(|(_, w)| (effective(w, now), w.since))
                .map(|(i, _)| i)
                .expect("non-empty");
            let waiter = state.waiters.remove(best);
            state.running += 1;
            let permit = RunPermit {
                sched: Some(self.clone()),
            };
            if let Err(mut permit) = waiter.tx.send(permit) {
                // The waiter went away: undo without re-entering release.
                permit.sched = None;
                state.running -= 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn grants_up_to_max_then_queues_by_priority() {
        let sched = Scheduler::new(2, 2);
        let a = sched.acquire(Priority::Background).await.unwrap();
        let _b = sched.acquire(Priority::Background).await.unwrap();
        let mut bg = sched.acquire(Priority::Background);
        let mut child = sched.acquire(Priority::Child);
        let mut human = sched.acquire(Priority::Human);
        assert_eq!(sched.running(), 2);
        assert_eq!(sched.waiting(), 3);
        drop(a);
        let human_permit = human.try_recv().expect("human first");
        assert!(child.try_recv().is_err() && bg.try_recv().is_err());
        drop(human_permit);
        let _child_permit = child.try_recv().expect("child next");
        assert!(bg.try_recv().is_err());
    }

    #[tokio::test]
    async fn dropped_waiter_passes_the_slot_on() {
        let sched = Scheduler::new(1, 1);
        let a = sched.acquire(Priority::Human).await.unwrap();
        let gone = sched.acquire(Priority::Human);
        let mut next = sched.acquire(Priority::Background);
        drop(gone);
        drop(a);
        let _permit = next.try_recv().expect("slot passed on");
        assert_eq!(sched.running(), 1);
    }

    #[test]
    fn aging_moves_waiters_up() {
        let now = Instant::now();
        let (tx, _rx) = oneshot::channel();
        let old = Waiter {
            priority: Priority::Background,
            since: now - Duration::from_secs(31),
            tx,
        };
        assert_eq!(effective(&old, now), Priority::Human as i32);
    }
}
