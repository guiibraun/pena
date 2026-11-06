//! At most `max` jobs at once, the rest wait in arrival order. Every agent CLI is a ~300 MB process.
//! acquire() resolves to a Release (a slot freed on release() or drop); a cancelled token takes a waiting job out of
//! the line (and errors).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
pub use tokio_util::sync::CancellationToken;

struct State {
    active: usize,
    next_id: u64,
    line: VecDeque<(u64, oneshot::Sender<Release>)>,
}

struct Inner {
    max: usize,
    state: Mutex<State>,
}

#[derive(Clone)]
pub struct Limiter(Arc<Inner>);

/// A held slot. release() is idempotent; dropping it releases too.
pub struct Release {
    inner: Arc<Inner>,
    done: bool,
}

impl Release {
    pub fn release(&mut self) {
        if !self.done {
            self.done = true;
            let mut st = self.inner.state.lock().unwrap();
            st.active -= 1;
            grant(&self.inner, &mut st);
        }
    }
}

impl Drop for Release {
    fn drop(&mut self) {
        self.release();
    }
}

fn grant(inner: &Arc<Inner>, st: &mut State) {
    while st.active < inner.max {
        let Some((_, tx)) = st.line.pop_front() else { break };
        st.active += 1;
        // The waiter is gone (its future was dropped): the slot was never taken. Mark it done so its drop is a no-op
        // (we hold the lock here).
        if let Err(mut r) = tx.send(Release { inner: inner.clone(), done: false }) {
            r.done = true;
            st.active -= 1;
        }
    }
}

/// Removes a waiter from the line when its acquire future ends without a slot (cancelled or dropped).
struct Waiting<'a>(&'a Arc<Inner>, u64);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().line.retain(|(id, _)| *id != self.1);
    }
}

pub fn create_limiter(max: usize) -> Limiter {
    Limiter::new(max)
}

impl Limiter {
    pub fn new(max: usize) -> Self {
        Limiter(Arc::new(Inner { max, state: Mutex::new(State { active: 0, next_id: 0, line: VecDeque::new() }) }))
    }
    pub fn max(&self) -> usize {
        self.0.max
    }
    pub fn active(&self) -> usize {
        self.0.state.lock().unwrap().active
    }
    pub fn waiting(&self) -> usize {
        self.0.state.lock().unwrap().line.len()
    }
    /// true when a job that asks now has to wait
    pub fn full(&self) -> bool {
        let st = self.0.state.lock().unwrap();
        st.active >= self.0.max || !st.line.is_empty()
    }

    pub async fn acquire(&self, cancel: Option<&CancellationToken>) -> anyhow::Result<Release> {
        if cancel.is_some_and(|c| c.is_cancelled()) {
            anyhow::bail!("aborted");
        }
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut st = self.0.state.lock().unwrap();
            let id = st.next_id;
            st.next_id += 1;
            st.line.push_back((id, tx));
            grant(&self.0, &mut st);
            id
        };
        let _waiting = Waiting(&self.0, id);
        let never = CancellationToken::new();
        let cancel = cancel.unwrap_or(&never);
        tokio::select! {
            biased;
            r = rx => r.map_err(|_| anyhow::anyhow!("aborted")),
            _ = cancel.cancelled() => anyhow::bail!("aborted"),
        }
    }
}
