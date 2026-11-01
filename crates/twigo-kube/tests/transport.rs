//! The api client against an HTTP/2 server written frame by frame: a
//! request the server never processed goes again, once; a retired
//! connection takes no new request; a cold client opens one connection.

mod frames;

use std::time::Duration;

use futures::future::join_all;

use frames::{ENHANCE_YOUR_CALM, NO_ERROR, Refusal, clients, get, serve, watch};

#[tokio::test]
async fn a_stream_above_a_graceful_goaway_goes_again_on_a_new_connection() {
    let server = serve(Some(Refusal::GoAway {
        code: NO_ERROR,
        after: 1,
        watch: false,
    }))
    .await;
    let clients = clients(&server);
    assert_eq!(get(&clients, "/first").await.unwrap(), "ok");
    assert_eq!(get(&clients, "/second").await.unwrap(), "ok");
    assert_eq!(*server.answered.lock().unwrap(), [(0, 1), (1, 1)]);
    assert_eq!(clients.connections().dialled(), 2);
}

#[tokio::test]
async fn retries_after_a_goaway_open_one_connection() {
    let server = serve(Some(Refusal::GoAway {
        code: NO_ERROR,
        after: 10,
        watch: true,
    }))
    .await;
    let clients = clients(&server);
    let _watch = watch(&clients).await;
    let answers = join_all((0..10).map(|_| get(&clients, "/again"))).await;
    assert!(answers.iter().all(Result::is_ok));
    assert_eq!(server.answered.lock().unwrap().len(), 11);
    assert_eq!(clients.connections().dialled(), 2);
}

#[tokio::test]
async fn a_refused_stream_goes_again_on_the_same_connection() {
    let server = serve(Some(Refusal::Reset)).await;
    let clients = clients(&server);
    assert_eq!(get(&clients, "/first").await.unwrap(), "ok");
    assert_eq!(get(&clients, "/second").await.unwrap(), "ok");
    assert_eq!(*server.answered.lock().unwrap(), [(0, 1), (0, 5)]);
    assert_eq!(clients.connections().dialled(), 1);
}

#[tokio::test]
async fn a_goaway_with_an_error_ends_the_request() {
    let server = serve(Some(Refusal::GoAway {
        code: ENHANCE_YOUR_CALM,
        after: 1,
        watch: false,
    }))
    .await;
    let clients = clients(&server);
    assert_eq!(get(&clients, "/first").await.unwrap(), "ok");
    get(&clients, "/second")
        .await
        .expect_err("the server may have processed it");
    assert_eq!(*server.answered.lock().unwrap(), [(0, 1)]);
}

#[tokio::test]
async fn concurrent_first_requests_open_one_connection() {
    let server = serve(None).await;
    let clients = clients(&server);
    let answers = join_all((0..10).map(|_| get(&clients, "/again"))).await;
    assert!(
        answers
            .iter()
            .all(|answer| answer.as_deref().is_ok_and(|text| text == "ok"))
    );
    assert_eq!(clients.connections().dialled(), 1);
}

#[tokio::test]
async fn a_retired_connection_takes_no_new_request_and_closes_when_idle() {
    let server = serve(None).await;
    let clients = clients(&server);
    let retired = clients.connections().retired();
    assert_eq!(get(&clients, "/first").await.unwrap(), "ok");

    clients.connections().retire();
    assert!(retired.has_changed().unwrap());
    let answers = join_all((0..10).map(|_| get(&clients, "/again"))).await;
    assert!(answers.iter().all(Result::is_ok));
    assert_eq!(clients.connections().dialled(), 2);
    assert!(
        server.answered.lock().unwrap()[1..]
            .iter()
            .all(|(connection, _)| *connection == 1)
    );

    tokio::time::timeout(Duration::from_secs(5), async {
        while clients.connections().open() > 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the retired connection closes once nothing uses it");
}

#[tokio::test]
#[ignore = "takes 35 s, for the 30 s ping interval"]
async fn an_idle_connection_is_pinged() {
    let server = serve(None).await;
    let clients = clients(&server);
    assert_eq!(get(&clients, "/first").await.unwrap(), "ok");
    tokio::time::sleep(Duration::from_secs(35)).await;
    assert!(server.pings.load(std::sync::atomic::Ordering::SeqCst) >= 1);
    assert_eq!(get(&clients, "/again").await.unwrap(), "ok");
    assert_eq!(clients.connections().dialled(), 1);
}
