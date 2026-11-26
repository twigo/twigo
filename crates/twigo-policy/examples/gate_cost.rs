//! What the gate costs one request (ARCHITECTURE 6.4), for the bench harness's row of the gate's
//! share of the core's CPU: the UI's gate on a guarded context, both its layers (the check at the
//! top of a client's stack with the attributes it reads, and the recheck above the socket) over a
//! service that answers at once, against that service alone, for the requests the app sends
//! most. Each request is timed twice: in a hot loop, with the code and the policy's data in the
//! cache, and one call at a time with a buffer bigger than the core's caches written before each
//! call, as a request that comes seconds apart in the app meets them.
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
const COLD_CALLS: usize = 1_000;
const EVICT_BYTES: usize = 64 << 20;
const CACHE_LINE: usize = 64;
const TABLE: &str = "application/json;as=Table;v=v1;g=meta.k8s.io,application/json";

type Shape<'a> = (&'a str, &'a str, Option<&'a str>);

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
async fn nanos<S>(service: &mut S, (method, uri, accept): Shape<'_>) -> f64
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

fn evict(buffer: &mut [u8]) {
    for byte in buffer.iter_mut().step_by(CACHE_LINE) {
        *byte = byte.wrapping_add(1);
    }
    black_box(&*buffer);
}

/// Nanoseconds of one call of `service` on a request built before the eviction.
async fn once<S>(service: &mut S, (method, uri, accept): Shape<'_>, buffer: &mut [u8]) -> f64
where
    S: Service<Request<()>, Response = Response<()>>,
    S::Error: std::fmt::Debug,
{
    let request = request(method, uri, accept);
    evict(buffer);
    let started = Instant::now();
    let sent = service.ready().await.expect("ready").call(request);
    black_box(sent.await.expect("answered"));
    started.elapsed().as_nanos() as f64
}

/// What `gated` costs beyond `bare` in nanoseconds per call, the mean of calls that alternate, so
/// that a drift of the machine cancels, each after the caches were evicted.
async fn cold<A, B>(bare: &mut A, gated: &mut B, shape: Shape<'_>, buffer: &mut [u8]) -> f64
where
    A: Service<Request<()>, Response = Response<()>>,
    A::Error: std::fmt::Debug,
    B: Service<Request<()>, Response = Response<()>>,
    B::Error: std::fmt::Debug,
{
    let (mut with, mut without) = (0.0, 0.0);
    for _ in 0..COLD_CALLS {
        with += once(gated, shape, buffer).await;
        without += once(bare, shape, buffer).await;
    }
    (with - without) / COLD_CALLS as f64
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
    let mut buffer = vec![0u8; EVICT_BYTES];
    let mut classes = Vec::new();
    for (name, method, uri, accept) in REQUESTS {
        let shape = (method, uri, accept);
        let without = nanos(&mut bare, shape).await;
        let with = nanos(&mut gated, shape).await;
        let cold = cold(&mut bare, &mut gated, shape, &mut buffer).await;
        classes.push(json!({
            "name": name,
            "method": method,
            "uri": uri,
            "gateNs": with - without,
            "coldGateNs": cold,
            "bareNs": without,
        }));
    }
    let report = json!({
        "iterations": ITERATIONS,
        "coldCalls": COLD_CALLS,
        "evictBytes": EVICT_BYTES,
        "mode": "guarded",
        "actor": "ui",
        "classes": classes,
    });
    println!("{}", serde_json::to_string_pretty(&report).expect("json"));
}
