//! Compare target evidence with the selected expectation.
use crate::{
    scenario::{LoadedScenario, SupportStatus},
    trace::{ObservedTrace, Outcome, TraceEvent},
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug)]
pub struct Report {
    pub outcome: Outcome,
    pub mismatches: Vec<String>,
}
impl Report {
    pub fn passed(&self) -> bool {
        matches!(self.outcome, Outcome::Ok) && self.mismatches.is_empty()
    }
}

pub fn compare(loaded: &LoadedScenario, observed: &ObservedTrace) -> Report {
    let scenario = &loaded.scenario;
    let mut report = Report {
        outcome: observed.outcome.clone(),
        mismatches: Vec::new(),
    };
    if observed.v != 1 || observed.scenario != scenario.name {
        report.outcome = Outcome::Error {
            reason: "observed version or scenario mismatch".into(),
        };
        return report;
    }
    let Some(target) = scenario.targets.get(&observed.target) else {
        report.outcome = Outcome::Error {
            reason: "unknown target".into(),
        };
        return report;
    };
    if !matches!(report.outcome, Outcome::Ok) {
        return report;
    }
    if observed.incomplete {
        report.outcome = Outcome::Incomplete {
            reason: "unknown log event".into(),
        };
        return report;
    }
    let expected = target.expect.as_ref().unwrap_or(&scenario.expect);
    if target.status != SupportStatus::Supported || !expected.complete {
        report.outcome = Outcome::PendingExpectation {
            reason: target
                .reason
                .clone()
                .unwrap_or_else(|| "expectation incomplete".into()),
        };
        return report;
    }
    for (name, count) in &loaded.outbound_counts {
        match observed.streams.get(name) {
            Some(s)
                if s.consumed_all
                    && s.outbound_mismatches.is_empty()
                    && s.outbound_checked as usize == *count => {}
            _ => report.mismatches.push(format!(
                "stream {name}: missing, incomplete, or outbound mismatch"
            )),
        }
    }
    if observed
        .streams
        .keys()
        .any(|n| !loaded.outbound_counts.contains_key(n))
    {
        report.mismatches.push("unexpected stream".into());
    }
    let mut seqs = BTreeSet::new();
    if observed.events.iter().any(|e| !seqs.insert(e.seq)) {
        report.mismatches.push("duplicate global sequence".into());
    }
    let mut matched = BTreeMap::new();
    let threads: BTreeSet<_> = expected
        .threads
        .keys()
        .cloned()
        .chain(observed.events.iter().map(|e| thread(&e.event).to_owned()))
        .collect();
    for name in threads {
        // The global sequence is the observation order; array order carries no meaning.
        let mut actual: Vec<_> = observed
            .events
            .iter()
            .filter(|e| thread(&e.event) == name && expected.exhaustive.contains(&kind(&e.event)))
            .collect();
        actual.sort_by_key(|e| e.seq);
        let wanted = expected
            .threads
            .get(&name)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if actual.len() != wanted.len() {
            report.mismatches.push(format!(
                "{name}: expected {} events, got {}",
                wanted.len(),
                actual.len()
            ));
        }
        for (i, (a, e)) in actual.iter().zip(wanted).enumerate() {
            if !matches_event(&e.event, &a.event) {
                report.mismatches.push(format!(
                    "{name}[{i}]: expected {:?}, observed {:?}",
                    e.event, a.event
                ));
            } else {
                matched.insert(e.id.clone(), a.seq);
            }
        }
    }
    for (a, b) in &expected.happens_before {
        if !matches!((matched.get(a),matched.get(b)), (Some(x),Some(y)) if x < y) {
            report
                .mismatches
                .push(format!("happensBefore {a} -> {b} violated"));
        }
    }
    report
}
fn matches_event(expected: &TraceEvent, actual: &TraceEvent) -> bool {
    let a = serde_json::to_value(expected).expect("serializable event");
    let b = serde_json::to_value(actual).expect("serializable event");
    a.as_object()
        .unwrap()
        .iter()
        .all(|(k, v)| b.get(k) == Some(v))
}
pub(crate) fn kind(e: &TraceEvent) -> crate::trace::TraceKind {
    use crate::trace::{TraceEvent as E, TraceKind as K};
    match e {
        E::InputAccepted { .. } => K::InputAccepted,
        E::InputRefused { .. } => K::InputRefused,
        E::QueueChanged { .. } => K::QueueChanged,
        E::RunStarted { .. } => K::RunStarted,
        E::SteerApplied { .. } => K::SteerApplied,
        E::RunFinished { .. } => K::RunFinished,
        E::ChildStarted { .. } => K::ChildStarted,
        E::ChildReported { .. } => K::ChildReported,
        E::ParentWoken { .. } => K::ParentWoken,
        E::ToolResult { .. } => K::ToolResult,
        E::HostRestarted { .. } => K::HostRestarted,
    }
}
pub(crate) fn thread(e: &TraceEvent) -> &str {
    use TraceEvent::*;
    match e {
        InputAccepted { thread, .. }
        | InputRefused { thread, .. }
        | QueueChanged { thread, .. }
        | RunStarted { thread, .. }
        | SteerApplied { thread, .. }
        | RunFinished { thread, .. }
        | ChildStarted { thread, .. }
        | ChildReported { thread, .. }
        | ParentWoken { thread, .. }
        | ToolResult { thread, .. }
        | HostRestarted { thread } => thread,
    }
}
