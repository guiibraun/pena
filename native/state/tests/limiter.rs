// Port of limiter.test.mjs.
use pena_state::limiter::{CancellationToken, Release, create_limiter};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

async fn tick() {
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn limiter() {
    // fake turns: each one records start order and finishes when told to
    let lim = create_limiter(3);
    let started = Arc::new(Mutex::new(Vec::<String>::new()));
    let ctl: Vec<CancellationToken> = (0..8).map(|_| CancellationToken::new()).collect();
    let mut finish: Vec<Option<oneshot::Sender<()>>> = Vec::new();
    let mut jobs = Vec::new();
    for (i, c) in ctl.iter().enumerate() {
        let (tx, rx) = oneshot::channel::<()>();
        finish.push(Some(tx));
        let (lim, started, c) = (lim.clone(), started.clone(), c.clone());
        jobs.push(tokio::spawn(async move {
            match lim.acquire(Some(&c)).await {
                Ok(mut release) => {
                    started.lock().unwrap().push(i.to_string());
                    let _ = rx.await;
                    release.release();
                }
                Err(_) => started.lock().unwrap().push(format!("x{i}")),
            }
        }));
        tokio::task::yield_now().await; // arrival order
        tick().await;
    }
    let s = || started.lock().unwrap().clone();
    assert_eq!(s(), ["0", "1", "2"]);
    assert_eq!(lim.active(), 3);
    assert_eq!(lim.waiting(), 5);
    assert!(lim.full());

    // a waiting job that is stopped leaves the line without taking a slot, the others keep their order
    ctl[4].cancel();
    tick().await;
    assert_eq!(s(), ["0", "1", "2", "x4"]);
    assert_eq!(lim.waiting(), 4);

    let mut fin = |i: usize| {
        let _ = finish[i].take().unwrap().send(());
    };
    fin(1); // job 1 ends: job 3 starts (FIFO)
    tick().await;
    assert_eq!(s()[4..], ["3"]);
    fin(0);
    fin(2);
    tick().await;
    assert_eq!(s()[5..], ["5", "6"]);
    assert_eq!(lim.active(), 3);
    assert_eq!(lim.waiting(), 1);

    // cancelling a running job's token does nothing to the slot: release() frees it
    ctl[3].cancel();
    tick().await;
    assert_eq!(lim.active(), 3);
    for i in 3..7 {
        if i != 4 {
            fin(i);
        }
    }
    tick().await;
    assert_eq!(s()[7..], ["7"]);
    fin(7);
    for j in jobs {
        j.await.unwrap();
    }
    assert_eq!(lim.active(), 0);
    assert!(!lim.full());

    // release twice frees one slot; an already cancelled token errors at once and takes nothing
    let lim = create_limiter(1);
    let mut r1 = lim.acquire(None).await.unwrap();
    r1.release();
    r1.release();
    assert_eq!(lim.active(), 0);
    drop(r1);
    assert_eq!(lim.active(), 0);
    let c = CancellationToken::new();
    c.cancel();
    assert!(lim.acquire(Some(&c)).await.is_err());
    assert_eq!(lim.active() + lim.waiting(), 0);

    // a dropped acquire (the task went away while waiting) leaves the line too
    let held = lim.acquire(None).await.unwrap();
    let waiter = tokio::spawn({
        let lim = lim.clone();
        async move { lim.acquire(None).await.map(|_| ()) }
    });
    tick().await;
    assert_eq!(lim.waiting(), 1);
    waiter.abort();
    tick().await;
    assert_eq!(lim.waiting(), 0);
    drop(held);
    assert_eq!(lim.active(), 0);

    // max 1 is strictly sequential
    let one = create_limiter(1);
    let order = Arc::new(Mutex::new(Vec::<&str>::new()));
    let a: Release = one.acquire(None).await.unwrap();
    let spawn = |name: &'static str| {
        let (one, order) = (one.clone(), order.clone());
        tokio::spawn(async move {
            let _rel = one.acquire(None).await.unwrap();
            order.lock().unwrap().push(name);
        })
    };
    let second = spawn("b");
    tick().await;
    let third = spawn("c");
    tick().await;
    order.lock().unwrap().push("a");
    drop(a);
    second.await.unwrap();
    third.await.unwrap();
    assert_eq!(*order.lock().unwrap(), ["a", "b", "c"]);
}
