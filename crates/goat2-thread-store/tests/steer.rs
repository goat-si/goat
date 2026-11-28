//! A steer the engine accepted and later cancelled comes back as a followup (owner decision
//! 2026-11-29; Fold.steeredInputs, lane C d95d3ec).

mod common;

use common::*;
use goat2_thread_store::StoreError;
use goat2_thread_store::contract::*;

fn ids(queue: &[QueuedInput]) -> Vec<&str> {
    queue.iter().map(|q| q.input_id.as_str()).collect()
}

/// Thread t with run r1 running (input i1 delivered as its turn) and two queued inputs:
/// s1 (a steer) and q1 (a followup).
fn running_with_queue(dir: &std::path::Path) -> goat2_thread_store::Store {
    let (store, _) = open(dir);
    let t = tid("t");
    store
        .create_thread(Some(t.clone()), created("steer", "/w"))
        .unwrap();
    store
        .append(
            &t,
            vec![
                input("i1", "first"),
                started("r1", &["i1"]),
                accepted("r1"),
                delivered("i1", "r1", DeliveredAs::Turn, DeliveryOutcome::Accepted),
                input_mode("s1", "steer this", InputMode::Steer),
                input_mode("q1", "after that", InputMode::Followup),
            ],
        )
        .unwrap();
    store
}

#[test]
fn an_accepted_steer_the_engine_cancels_goes_to_the_end_of_the_queue_as_a_followup() {
    let dir = tempfile::tempdir().unwrap();
    let store = running_with_queue(dir.path());
    let t = tid("t");
    let out = store
        .append(
            &t,
            vec![delivered(
                "s1",
                "r1",
                DeliveredAs::Steer,
                DeliveryOutcome::Accepted,
            )],
        )
        .unwrap();
    assert_eq!(ids(&out.fold.queued_inputs), vec!["q1"]);
    assert_eq!(ids(&out.fold.steered_inputs), vec!["s1"]);
    let out = store
        .append(
            &t,
            vec![delivered(
                "s1",
                "r1",
                DeliveredAs::Steer,
                DeliveryOutcome::Declined,
            )],
        )
        .unwrap();
    assert_eq!(ids(&out.fold.queued_inputs), vec!["q1", "s1"]);
    assert!(out.fold.steered_inputs.is_empty());
    let back = &out.fold.queued_inputs[1];
    assert_eq!(back.mode, InputMode::Followup);
    assert_eq!(back.text, "steer this");
    assert_eq!(back.source, InputSource::User);
    assert_eq!(out.card.status, ThreadStatus::Running);
    let out = store
        .append(&t, vec![finished("r1", RunOutcome::Completed)])
        .unwrap();
    assert_eq!(out.card.status, ThreadStatus::Queued);
    // The live fold, a full replay and a restart agree.
    let live = store.fold(&t).unwrap().unwrap();
    assert_eq!(replay(dir.path(), "t").1, live);
    drop(store);
    let (store, _) = open(dir.path());
    assert_eq!(store.fold(&t).unwrap().unwrap(), live);
}

#[test]
fn a_cancel_after_run_finished_still_requeues_until_the_next_run_starts() {
    let dir = tempfile::tempdir().unwrap();
    let store = running_with_queue(dir.path());
    let t = tid("t");
    store
        .append(
            &t,
            vec![
                delivered("s1", "r1", DeliveredAs::Steer, DeliveryOutcome::Accepted),
                finished("r1", RunOutcome::Completed),
            ],
        )
        .unwrap();
    // The checkpoint written with run.finished carries the accepted steer, and a restart keeps it.
    drop(store);
    let (store, _) = open(dir.path());
    assert_eq!(
        ids(&store.fold(&t).unwrap().unwrap().steered_inputs),
        vec!["s1"]
    );
    let out = store
        .append(
            &t,
            vec![delivered(
                "s1",
                "r1",
                DeliveredAs::Steer,
                DeliveryOutcome::Declined,
            )],
        )
        .unwrap();
    assert_eq!(ids(&out.fold.queued_inputs), vec!["q1", "s1"]);
    assert!(out.fold.steered_inputs.is_empty());
    assert_eq!(replay(dir.path(), "t").1, out.fold);
}

#[test]
fn the_next_run_start_settles_accepted_steers_and_a_late_cancel_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = running_with_queue(dir.path());
    let t = tid("t");
    let out = store
        .append(
            &t,
            vec![
                delivered("s1", "r1", DeliveredAs::Steer, DeliveryOutcome::Accepted),
                finished("r1", RunOutcome::Completed),
                started("r2", &["q1"]),
            ],
        )
        .unwrap();
    assert!(out.fold.steered_inputs.is_empty());
    let late = store.append(
        &t,
        vec![delivered(
            "s1",
            "r1",
            DeliveredAs::Steer,
            DeliveryOutcome::Declined,
        )],
    );
    assert!(matches!(late, Err(StoreError::InvalidEvent(_))), "{late:?}");
}

#[test]
fn a_declined_steer_that_is_still_queued_stays_where_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let store = running_with_queue(dir.path());
    let t = tid("t");
    let out = store
        .append(
            &t,
            vec![delivered(
                "s1",
                "r1",
                DeliveredAs::Steer,
                DeliveryOutcome::Declined,
            )],
        )
        .unwrap();
    assert_eq!(ids(&out.fold.queued_inputs), vec!["s1", "q1"]);
    assert_eq!(out.fold.queued_inputs[0].mode, InputMode::Steer);
    assert!(out.fold.steered_inputs.is_empty());
}

#[test]
fn a_stray_declined_steer_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = running_with_queue(dir.path());
    let out = store.append(
        &tid("t"),
        vec![delivered(
            "nope",
            "r1",
            DeliveredAs::Steer,
            DeliveryOutcome::Declined,
        )],
    );
    assert!(matches!(out, Err(StoreError::InvalidEvent(_))), "{out:?}");
}
