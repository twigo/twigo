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
async fn a_stream_above_a_goaway_with_an_error_goes_again_too() {
    let server = serve(Some(Refusal::GoAway {
        code: ENHANCE_YOUR_CALM,
        after: 1,
        watch: false,
    }))
    .await;
    let clients = clients(&server);
    assert_eq!(get(&clients, "/first").await.unwrap(), "ok");
    assert_eq!(get(&clients, "/second").await.unwrap(), "ok");
    assert_eq!(*server.answered.lock().unwrap(), [(0, 1), (1, 1)]);
}

#[tokio::test]
async fn a_request_the_server_may_have_processed_fails() {
    let server = serve(Some(Refusal::Drop {
        code: ENHANCE_YOUR_CALM,
    }))
    .await;
    let clients = clients(&server);
    get(&clients, "/first")
        .await
        .expect_err("its stream is the last the GOAWAY names");
    assert_eq!(clients.connections().dialled(), 1);
}

#[tokio::test]
async fn a_connection_retired_during_its_first_request_takes_no_other() {
    let server = serve(Some(Refusal::Delay(Duration::from_secs(1)))).await;
    let clients = clients(&server);
    let second = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        clients.connections().retire();
        get(&clients, "/second").await
    };
    let (first, second) = tokio::join!(get(&clients, "/first"), second);
    assert_eq!(
        (first.unwrap(), second.unwrap()),
        ("ok".into(), "ok".into())
    );
    let answered = server.answered.lock().unwrap().clone();
    assert!(answered.contains(&(1, 1)), "{answered:?}");
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

#[tokio::test]
async fn requests_that_waited_for_a_failed_first_connection_go_at_once() {
    // Accepts and never answers, so every TLS handshake runs into the
    // connect timeout.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        loop {
            held.push(listener.accept().await.unwrap());
        }
    });
    let mut config = kube::Config::new(format!("https://localhost:{port}").parse().unwrap());
    config.connect_timeout = Some(Duration::from_secs(1));
    let clients = twigo_kube::client::Clients::new(
        &config,
        twigo_kube::client::Gate::unrestricted(),
        Default::default(),
    )
    .unwrap();

    let started = std::time::Instant::now();
    let answers = join_all((0..5).map(|_| get(&clients, "/version"))).await;
    assert!(answers.iter().all(Result::is_err));
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}: one dial after another",
        started.elapsed()
    );
}

/// A request that comes while the first connection is past TLS but not yet
/// in hyper-util's pool would dial a connection of its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_request_during_the_first_handshake_keeps_to_one_connection() {
    for _ in 0..50 {
        let server = serve(None).await;
        let clients = std::sync::Arc::new(clients(&server));
        let early = {
            let clients = std::sync::Arc::clone(&clients);
            tokio::spawn(async move {
                while clients.connections().open() == 0 {
                    tokio::task::yield_now().await;
                }
                get(&clients, "/early").await
            })
        };
        assert!(get(&clients, "/first").await.is_ok());
        assert!(early.await.unwrap().is_ok());
        assert_eq!(clients.connections().dialled(), 1);
    }
}
