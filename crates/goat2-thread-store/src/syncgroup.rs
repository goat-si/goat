//! Group commit for log syncs on Apple platforms.
//!
//! On macOS `sync_data` is `F_FULLFSYNC`: it writes the file and then flushes the whole drive
//! cache. With many threads appending at once those cache flushes queue behind one another. Here
//! each caller first writes its own file to the drive with plain `fsync`, then shares one
//! `F_FULLFSYNC` with every caller that got that far: a flush counts for a caller only if it
//! started after that caller's `fsync` returned. The drive cache flush is device-wide, so the data
//! root must sit on one volume. Measured on an M5 Max with 20 threads appending at once: 9 ms median
//! per append instead of 31 ms.
//!
//! Other platforms keep `sync_data` per append (`fdatasync` already makes the file durable on its
//! own).

use std::fs::File;
use std::io;
use std::sync::{Condvar, Mutex, MutexGuard};

#[derive(Default)]
struct State {
    /// Generations: a flush started as generation `started`; all flushes up to `done` finished.
    started: u64,
    done: u64,
    busy: bool,
    /// Highest generation whose flush failed. Callers it covered flush again on their own file.
    failed: u64,
}

#[derive(Default)]
pub(crate) struct SyncGroup {
    state: Mutex<State>,
    cv: Condvar,
}

impl SyncGroup {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Make `file` durable: `write_out` puts this file's data on the drive, `barrier` flushes the
    /// drive cache. Returns once a barrier that started after `write_out` returned has succeeded.
    pub(crate) fn sync_with(
        &self,
        file: &File,
        write_out: impl FnOnce(&File) -> io::Result<()>,
        barrier: impl Fn(&File) -> io::Result<()>,
    ) -> io::Result<()> {
        write_out(file)?;
        let mut st = self.lock();
        // Any flush already running may have started before our write-out finished.
        let mine = st.started + 1;
        loop {
            if st.done >= mine {
                let covered_by_failure = st.failed >= mine;
                drop(st);
                return if covered_by_failure {
                    barrier(file)
                } else {
                    Ok(())
                };
            }
            if !st.busy {
                st.busy = true;
                st.started += 1;
                let target = st.started;
                drop(st);
                let mut leader = Leader {
                    group: self,
                    target,
                    failed: true,
                };
                let result = barrier(file);
                leader.failed = result.is_err();
                drop(leader);
                return result;
            }
            st = self.cv.wait(st).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Platform sync used by the store for log files.
    #[cfg(target_vendor = "apple")]
    pub(crate) fn sync(&self, file: &File) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        self.sync_with(
            file,
            // SAFETY: plain fsync on an open descriptor borrowed for the duration of the call.
            |f| retry_interrupted(|| unsafe { libc::fsync(f.as_raw_fd()) }),
            // SAFETY: F_FULLFSYNC takes no argument and only reads the descriptor.
            |f| retry_interrupted(|| unsafe { libc::fcntl(f.as_raw_fd(), libc::F_FULLFSYNC) }),
        )
    }

    #[cfg(not(target_vendor = "apple"))]
    pub(crate) fn sync(&self, file: &File) -> io::Result<()> {
        file.sync_data()
    }
}

/// Finishes a leader's flush generation, also when the barrier panics: the generation counts as
/// failed then, so covered callers flush on their own instead of waiting forever.
struct Leader<'a> {
    group: &'a SyncGroup,
    target: u64,
    failed: bool,
}

impl Drop for Leader<'_> {
    fn drop(&mut self) {
        let mut st = self.group.lock();
        st.busy = false;
        st.done = st.done.max(self.target);
        if self.failed {
            st.failed = st.failed.max(self.target);
        }
        self.group.cv.notify_all();
    }
}

/// Run a system call that returns -1 on error, retrying when a signal interrupted it (std's
/// `sync_data` does the same), so a stray SIGCHLD does not poison a thread.
#[cfg(target_vendor = "apple")]
fn retry_interrupted(call: impl Fn() -> libc::c_int) -> io::Result<()> {
    loop {
        if call() != -1 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn file() -> File {
        tempfile::tempfile().unwrap()
    }

    #[test]
    fn concurrent_callers_share_flushes_and_each_waits_for_one_started_after_its_write() {
        let group = Arc::new(SyncGroup::default());
        let writes = Arc::new(AtomicU64::new(0));
        let barriers = Arc::new(AtomicU64::new(0));
        // Barrier i records how many write-outs had finished when it started.
        let starts = Arc::new(Mutex::new(Vec::<u64>::new()));
        let workers: Vec<_> = (0..16)
            .map(|_| {
                let (group, writes, barriers, starts) = (
                    group.clone(),
                    writes.clone(),
                    barriers.clone(),
                    starts.clone(),
                );
                std::thread::spawn(move || {
                    let f = file();
                    for _ in 0..40 {
                        let mut seen = 0;
                        group
                            .sync_with(
                                &f,
                                |_| {
                                    seen = writes.fetch_add(1, Ordering::SeqCst) + 1;
                                    Ok(())
                                },
                                |_| {
                                    starts.lock().unwrap().push(writes.load(Ordering::SeqCst));
                                    barriers.fetch_add(1, Ordering::SeqCst);
                                    std::thread::sleep(std::time::Duration::from_millis(2));
                                    Ok(())
                                },
                            )
                            .unwrap();
                        // Some barrier that started after our write-out has finished.
                        let starts = starts.lock().unwrap();
                        assert!(starts.iter().any(|&w| w >= seen), "no covering flush");
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        let flushes = barriers.load(Ordering::SeqCst);
        assert!(flushes < 16 * 40, "flushes were not shared: {flushes}");
    }

    #[test]
    fn a_failed_shared_flush_makes_every_caller_it_covered_flush_again() {
        let group = Arc::new(SyncGroup::default());
        let calls = Arc::new(AtomicU64::new(0));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let (group, calls) = (group.clone(), calls.clone());
                std::thread::spawn(move || {
                    let f = file();
                    group.sync_with(
                        &f,
                        |_| Ok(()),
                        |_| {
                            calls.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(2));
                            Err(io::Error::other("flush failed"))
                        },
                    )
                })
            })
            .collect();
        for w in workers {
            assert!(
                w.join().unwrap().is_err(),
                "a failed flush was reported as success"
            );
        }
        // Each caller ran exactly one barrier: its own as leader, or its own retry after the shared
        // flush that covered it failed.
        assert_eq!(calls.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn a_panicking_flush_does_not_stall_later_callers() {
        let group = Arc::new(SyncGroup::default());
        let g = group.clone();
        let panicked = std::thread::spawn(move || {
            let _ = g.sync_with(&file(), |_| Ok(()), |_| panic!("barrier panicked"));
        })
        .join();
        assert!(panicked.is_err());
        group.sync_with(&file(), |_| Ok(()), |_| Ok(())).unwrap();
    }

    #[test]
    fn a_failed_write_out_skips_the_flush() {
        let group = SyncGroup::default();
        let out = group.sync_with(
            &file(),
            |_| Err(io::Error::other("eio")),
            |_| panic!("flushed"),
        );
        assert!(out.is_err());
    }

    #[test]
    fn the_platform_sync_works_on_a_real_file() {
        use std::io::Write;
        let mut f = file();
        f.write_all(b"line\n").unwrap();
        SyncGroup::default().sync(&f).unwrap();
    }
}
