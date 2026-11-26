//! What the gate costs one request (ARCHITECTURE 6.4), for the bench harness's row of the gate's
//! share of the core's CPU: the UI's gate on a guarded context, both its layers (the check at the
//! top of a client's stack with the attributes it reads, and the recheck above the socket) over a
//! service that answers at once, against that service alone, for the requests the app sends
//! most. The loop is hot, so each figure is the cost with the code and the policy's data in the
//! cache; a request in the app that comes seconds apart meets them cold and costs more.
//!
//! cargo run --release -p twigo-policy --example gate_cost
#![expect(clippy::print_stdout, reason = "an example's output is its result")]

use std::convert::Infallible;
use std::hint::black_box;
use std::time::Instant;

use http::header::ACCEPT;
use http::{Request, Response};
use serde_json::json;
use tower::{Layer, Service, ServiceExt, service_fn};
use twigo_ipc::Mode;
use twigo_policy::{Actor, Audit, Choices, Metadata, Policy, PolicyFile};

const ITERATIONS: u32 = 1_000_000;
const TABLE: &str = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json";

/// A name, the request's method and path, and its `Accept` header.
const REQUESTS: [(&str, &str, &str, Option<&str>); 6] = [
    ("pods list", "GET", "/api/v1/pods?limit=500", Some(TABLE)),
    (
        "pods watch",
        "GET",
        "/api/v1/pods?allowWatchBookmarks=true&resourceVersion=1234&timeoutSeconds=1800&watch=true",
        Some(TABLE),
    ),
    (
        "metrics list",
        "GET",
        "/apis/metrics.k8s.io/v1beta1/pods",
        None,
    ),
    ("discovery", "GET", "/apis", None),
    (
        "access review",
        "POST",
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
        None,
    ),
    (
        "pod patch",
        "PATCH",
        "/api/v1/namespaces/payments/pods/api-1",
        None,
    ),
];

fn request(method: &str, uri: &str, accept: Option<&str>) -> Request<()> {
    let builder = Request::builder().method(method).uri(uri);
    let builder = match accept {
        Some(accept) => builder.header(ACCEPT, accept),
        None => builder,
    };
    builder.body(()).expect("a request")
}

/// Nanoseconds per request through `service`, the request built each time.
async fn nanos<S>(service: &mut S, (method, uri, accept): (&str, &str, Option<&str>)) -> f64
where
    S: Service<Request<()>, Response = Response<()>>,
    S::Error: std::fmt::Debug,
{
    for _ in 0..ITERATIONS / 10 {
        let sent = service
            .ready()
            .await
            .expect("ready")
            .call(request(method, uri, accept));
        black_box(sent.await.expect("answered"));
    }
    let started = Instant::now();
    for _ in 0..ITERATIONS {
        let sent = service
            .ready()
            .await
            .expect("ready")
            .call(request(method, uri, accept));
        black_box(sent.await.expect("answered"));
    }
    started.elapsed().as_nanos() as f64 / f64::from(ITERATIONS)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let policy = Policy::new(
        PolicyFile::default(),
        |_| Some(Metadata::default()),
        Choices::default(),
        Audit::off(),
    );
    policy.set_mode("c", Some(Mode::Guarded)).expect("a mode");
    let gate = policy.gate("c", Actor::Ui);
    let answer = || service_fn(|_: Request<()>| async { Ok::<_, Infallible>(Response::new(())) });
    let mut bare = answer();
    let mut gated = gate.layer().layer(gate.recheck().layer(answer()));
    let mut classes = Vec::new();
    for (name, method, uri, accept) in REQUESTS {
        let shape = (method, uri, accept);
        let without = nanos(&mut bare, shape).await;
        let with = nanos(&mut gated, shape).await;
        classes.push(json!({
            "name": name,
            "method": method,
            "uri": uri,
            "gateNs": with - without,
            "bareNs": without,
        }));
    }
    let report =
        json!({ "iterations": ITERATIONS, "mode": "guarded", "actor": "ui", "classes": classes });
    println!("{}", serde_json::to_string_pretty(&report).expect("json"));
}
