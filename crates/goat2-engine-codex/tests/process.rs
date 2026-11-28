#![cfg(unix)]

use std::time::{Duration, Instant};

use goat2_engine_codex::process::{ChildProcess, Launch};
use tokio::io::{AsyncBufReadExt, BufReader};

fn sh(script: &str) -> Launch {
    let mut launch = Launch::new("/bin/sh").arg("-c").arg(script);
    launch.kill_grace = Duration::from_millis(300);
    launch
}

async fn first_line(child: &mut ChildProcess) -> String {
    let stdout = child.take_stdout().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn priority_of(pid: i32) -> i32 {
    // SAFETY: plain syscall.
    unsafe { libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t) }
}

async fn wait_gone(pid: i32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

#[tokio::test]
async fn child_leads_its_own_group_at_lower_priority() {
    let mut child = ChildProcess::spawn(&sh("sleep 60 & echo $!; wait")).unwrap();
    let pid = child.pid() as i32;
    let grandchild: i32 = first_line(&mut child).await.trim().parse().unwrap();
    // SAFETY: plain syscalls.
    let (pgid, grand_pgid) = unsafe { (libc::getpgid(pid), libc::getpgid(grandchild)) };
    assert_eq!(pgid, pid, "child is its own group leader");
    assert_eq!(grand_pgid, pid, "descendants stay in the group");
    let host = priority_of(0);
    assert_eq!(priority_of(pid), (host + 10).min(19));
    assert_eq!(
        priority_of(grandchild),
        (host + 10).min(19),
        "descendants inherit nice"
    );

    let rss = child.group_rss_bytes().unwrap();
    assert!(rss > 0, "group memory is measured");

    child.shutdown().await;
    assert!(
        wait_gone(grandchild).await,
        "shutdown kills the whole group"
    );
    assert_eq!(child.group_rss_bytes().unwrap(), 0);
}

#[tokio::test]
async fn shutdown_kills_descendants_after_the_leader_exits() {
    let mut child = ChildProcess::spawn(&sh("sleep 60 & echo $!; exit 0")).unwrap();
    let grandchild: i32 = first_line(&mut child).await.trim().parse().unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(alive(grandchild), "descendant outlives the leader");
    child.shutdown().await;
    assert!(
        wait_gone(grandchild).await,
        "group kill reaches the orphaned descendant"
    );
}

#[tokio::test]
async fn terminate_group_ends_within_one_kill_grace() {
    // The leader ignores TERM, so the group needs KILL after kill_grace.
    let mut child = ChildProcess::spawn(&sh(
        "trap '' TERM; echo ready; while true; do sleep 1; done",
    ))
    .unwrap();
    first_line(&mut child).await;
    let started = Instant::now();
    let summary = child.terminate_group().await;
    assert!(summary.signalled);
    // kill_grace (300 ms) plus reaping slack.
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "took {:?}",
        started.elapsed()
    );
    assert!(!child.group_alive());
}

#[tokio::test]
async fn drop_kills_the_group() {
    let mut child = ChildProcess::spawn(&sh("sleep 60 & echo $!; wait")).unwrap();
    let grandchild: i32 = first_line(&mut child).await.trim().parse().unwrap();
    drop(child);
    assert!(
        wait_gone(grandchild).await,
        "dropping the handle kills the group"
    );
}

#[tokio::test]
async fn host_identity_is_not_inherited() {
    // SAFETY: test-only environment mutation before spawning.
    unsafe { std::env::set_var("GOAT_TEST_IDENTITY_MARKER", "leak") };
    let launch =
        sh("echo \"[$GOAT_TEST_IDENTITY_MARKER][$CODEX_THREAD_ID]\"").without_host_identity();
    let mut child = ChildProcess::spawn(&launch).unwrap();
    assert_eq!(first_line(&mut child).await, "[][]");
    child.shutdown().await;
}
