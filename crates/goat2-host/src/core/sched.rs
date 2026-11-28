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

/// Holds one run slot until dropped. [RunPermit::slot] gives the handle used to park it.
pub struct RunPermit {
    slot: Arc<RunSlot>,
}

/// A run's slot. Parking is owned by the slot: several waits of one run park it once, the run
/// finishing while parked does not release twice, and resuming waits for capacity again.
pub struct RunSlot {
    sched: Arc<Scheduler>,
    st: Mutex<SlotState>,
}

impl std::fmt::Debug for RunSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunSlot").finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
struct SlotState {
    /// This slot is counted in `running`.
    holding: bool,
    /// Waits currently parking this slot.
    parks: usize,
    finished: bool,
}

impl RunPermit {
    fn new(sched: &Arc<Scheduler>) -> Self {
        Self {
            slot: Arc::new(RunSlot {
                sched: sched.clone(),
                st: Mutex::new(SlotState {
                    holding: true,
                    parks: 0,
                    finished: false,
                }),
            }),
        }
    }

    pub fn slot(&self) -> Arc<RunSlot> {
        self.slot.clone()
    }

    /// Hand this permit's count over (the caller now accounts for it) without releasing.
    fn disown(self) {
        let mut st = self.slot.st.lock().expect("slot");
        st.holding = false;
        st.finished = true;
    }
}

impl RunSlot {
    fn finish(&self) {
        let release = {
            let mut st = self.st.lock().expect("slot");
            st.finished = true;
            std::mem::take(&mut st.holding)
        };
        if release {
            self.sched.release();
        }
    }

    /// A run blocked on a child (`thread.wait`, `thread.start {mode: wait}`) lends its slot while
    /// it waits. Without this, four parents waiting on children hold every slot and the children
    /// never start.
    pub fn park(self: &Arc<Self>) -> Parked {
        let release = {
            let mut st = self.st.lock().expect("slot");
            if st.finished {
                false
            } else {
                st.parks += 1;
                st.parks == 1 && std::mem::take(&mut st.holding)
            }
        };
        if release {
            self.sched.release();
        }
        Parked {
            slot: Some(self.clone()),
        }
    }

    /// Take the slot back before this wait returns control to the run. Every finished wait does
    /// this, also while other waits of the same run are still parked: a run that runs again
    /// always holds a slot. (A later park only lends the slot again when it is the run's first.)
    async fn unpark(self: Arc<Self>) {
        let need = {
            let mut st = self.st.lock().expect("slot");
            st.parks = st.parks.saturating_sub(1);
            !st.finished && !st.holding
        };
        if !need {
            return;
        }
        let Ok(permit) = self.sched.acquire(Priority::Child).await else {
            return;
        };
        let take = {
            let mut st = self.st.lock().expect("slot");
            if !st.finished && !st.holding {
                st.holding = true;
                true
            } else {
                false
            }
        };
        if take {
            permit.disown();
        }
    }
}

impl std::fmt::Debug for RunPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RunPermit")
    }
}

/// See [RunSlot::park].
pub struct Parked {
    slot: Option<Arc<RunSlot>>,
}

impl Parked {
    /// Take the slot back before the run continues; waits for capacity under the cap.
    pub async fn resume(mut self) {
        if let Some(slot) = self.slot.take() {
            slot.unpark().await;
        }
    }
}

impl Drop for Parked {
    fn drop(&mut self) {
        // Dropped without resume (cancelled call): take the slot back in the background.
        if let Some(slot) = self.slot.take()
            && let Ok(handle) = tokio::runtime::Handle::try_current()
        {
            handle.spawn(slot.unpark());
        }
    }
}

impl Drop for RunPermit {
    fn drop(&mut self) {
        self.slot.finish();
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
            // A receiver dropped before the send gets the permit back here; its drop releases.
            let _ = tx.send(RunPermit::new(self));
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

    pub fn running(&self) -> usize {
        self.state.lock().expect("sched").running
    }

    pub fn waiting(&self) -> usize {
        self.state.lock().expect("sched").waiters.len()
    }

    fn release(self: &Arc<Self>) {
        let mut state = self.state.lock().expect("sched");
        state.running = state.running.saturating_sub(1);
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
            if let Err(permit) = waiter.tx.send(RunPermit::new(self)) {
                // The waiter went away: undo without re-entering release.
                permit.disown();
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

    #[tokio::test]
    async fn parking_is_owned_by_the_run_and_counts_once() {
        let sched = Scheduler::new(1, 1);
        let permit = sched.acquire(Priority::Human).await.unwrap();
        let slot = permit.slot();
        // Two waits of the same run park it once.
        let a = slot.park();
        let b = slot.park();
        assert_eq!(sched.running(), 0);
        let child = sched.acquire(Priority::Child).await.unwrap();
        assert_eq!(sched.running(), 1);
        // The first wait to finish takes the slot back before it returns, even though the
        // other wait is still parked: it waits for capacity, the child holds the only slot.
        let resume_a = tokio::spawn(a.resume());
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!resume_a.is_finished());
        drop(child);
        resume_a.await.unwrap();
        assert_eq!(sched.running(), 1);
        // The second wait finishing finds the slot held and changes nothing.
        b.resume().await;
        assert_eq!(sched.running(), 1);
        // A new wait while the run holds the slot and no other wait is parked lends it again.
        let c = slot.park();
        assert_eq!(sched.running(), 0);
        c.resume().await;
        assert_eq!(sched.running(), 1);
        // Finishing the run releases exactly once.
        drop(permit);
        assert_eq!(sched.running(), 0);
    }

    #[tokio::test]
    async fn a_run_finishing_while_parked_does_not_release_twice() {
        let sched = Scheduler::new(2, 1);
        let permit = sched.acquire(Priority::Human).await.unwrap();
        let parked = permit.slot().park();
        assert_eq!(sched.running(), 0);
        drop(permit);
        parked.resume().await;
        assert_eq!(sched.running(), 0);
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
