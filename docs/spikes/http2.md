# Spike: HTTP/2

M0 step 3, 2026-10-31. The question: can kube-rs carry requests and watches
over one HTTP/2 connection, while exec, attach and port-forward use a separate
HTTP/1.1 pool? See the first risk in 7.3 and the budgets in 3.2.

**Answer: yes.** Fifty Table watches share one TCP connection instead of 51,
and GET latency does not change. Exec cannot use that connection and keeps
kube's HTTP/1.1 client. The new limit to plan for is the server's 100
streams per connection.

- Clients: `crates/twigo-kube/src/client.rs`.
- Measurement: `crates/twigo-kube/examples/http2.rs`.
- Tests: `crates/twigo-kube/tests/clients_live.rs`, run per release by
  `bench/test-matrix.sh` and `.github/workflows/kubernetes.yml`.

## The clients

`twigo_kube::client::Clients` holds two clients per context.

- **`api`** handles requests, watches and followed logs. It uses kube's
  `Client::new` over a tower stack of kube's own layers from `ConfigExt`:
  - base URI;
  - auth, including exec plugins and token refresh;
  - extra headers, such as impersonation.

  Under them sits a hyper-util client whose rustls connector offers both
  `h2` and `http/1.1` over ALPN. kube's builder offers only `http/1.1`
  ([config_ext.rs](https://github.com/kube-rs/kube/blob/4.2.0/kube-client/src/client/config_ext.rs#L426-L447)),
  and its hyper is built with `http1` alone. kube-apiserver answers `h2`
  unless it runs with HTTP/2 disabled. TLS comes from kube's own
  `rustls_client_config` and server-name resolver, so verification, CA
  reloading, `tls-server-name` and client certificates match kube's stack.

- **`sessions`** is kube's default client, for exec, attach and port-forward.
  It is built first: only kube's builder can read the expiry of an exec
  plugin's certificate, and `api` copies it (`valid_until`).

What kube's default stack has and `api` does not yet:

- a proxy: kube fills `proxy_url` from the kubeconfig or from `HTTPS_PROXY`,
  and `Clients::new` refuses either for now. The connector of 6.3 brings
  proxies, with `NO_PROXY` and the OS settings;
- the write timeout (295 s); the connect timeout (30 s) is carried over, and
  kube sets no read timeout;
- the retry and tracing layers.

Neither client sets TCP keepalive or HTTP/2 keep-alive pings yet; 3.2 asks
for both. Building `Clients` runs an exec plugin five times, two for `api`
and three for `sessions`, until the credential runner of 6.2 replaces
kube's exec auth.

## Measurements

`examples/http2.rs` ran twice on kind 1.37 (macOS, Docker Desktop) against
5,000 kwok pods in namespace `bench`.

- 50 Table watches on that namespace's pods.
- Sequential `GET …/pods?limit=1` for 10 s per state, 7,500 to 12,700 of
  them.
- TCP connections to the API server counted with `lsof -iTCP:<port>
-sTCP:ESTABLISHED` on the process itself.
- Churn: the Deployment is scaled between 5,000 and 4,750 every 3 s,
  through the client under test, for the whole 10 s window. The watches read
  112,500 events in most windows (60,750 in one).
- Each run measures HTTP/1.1, HTTP/2, HTTP/2, HTTP/1.1, with a fresh client
  per phase, and waits for the Deployment to be back at 5,000 between
  phases.

Second run:

| Client, state                    | TCP connections | GETs   | p50 ms | p95 | p99 | max   |
| -------------------------------- | --------------- | ------ | ------ | --- | --- | ----- |
| HTTP/1.1, no watches             | 1               | 11,473 | 0.7    | 1.2 | 2.3 | 100.6 |
| HTTP/1.1, 50 quiet watches       | 52              | 11,754 | 0.7    | 1.1 | 1.9 | 80.4  |
| HTTP/1.1, 50 watches under churn | 52              | 9,228  | 0.8    | 1.3 | 6.1 | 101.6 |
| HTTP/2, no watches               | 1               | 11,732 | 0.7    | 1.1 | 2.3 | 101.0 |
| HTTP/2, 50 quiet watches         | 1               | 11,134 | 0.7    | 1.3 | 3.9 | 94.7  |
| HTTP/2, 50 watches under churn   | 1               | 9,997  | 0.8    | 1.5 | 4.5 | 102.7 |

Over both runs and all eight phases:

- p50 stayed at 0.7 to 0.8 ms for both clients, quiet or under churn.
- Under churn, p99 was 5.0 to 9.4 ms over HTTP/1.1 and 4.5 to 8.3 ms over
  HTTP/2; p95 was 1.1 to 3.0 ms and 1.2 to 1.8 ms.
- The maximum was 80 to 105 ms in nearly every state, without watches too,
  so it reflects the API server, not the client.
- HTTP/1.1 held 51 to 53 connections: one per watch, plus GETs and churn
  patches that ran at the same time.

On a local cluster HTTP/2 costs nothing in latency. What it saves is one TCP
and TLS connection per watch, on the client, on the API server, and on
every proxy or load balancer between them. Head-of-line blocking under
packet loss was not measured: loopback loses nothing. That belongs to the
bench of step 7.

**Cold start.** Fifty watches opened at once on a cold `api` client:

- `lsof`, sampled every few milliseconds, never saw more than one
  connection.
- An `lsof` run takes tens of milliseconds, so short-lived extra handshakes
  could slip past it.
- hyper-util takes its HTTP/2 lock only after ALPN
  ([client.rs](https://github.com/hyperium/hyper-util/blob/v0.1.21/src/client/legacy/client.rs#L496-L535)),
  so concurrent first requests may each start a handshake.
- M1 therefore sends one request before it opens a cluster's watches.

## The stream limit

- kube-apiserver allows 100 concurrent streams per HTTP/2 connection unless
  `--http2-max-streams-per-connection` is set
  ([secure_serving.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/server/secure_serving.go#L191-L199)).
  Its flag defaults to 0
  ([serving.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubeapiserver/options/serving.go#L27-L38)).
  The 1,000 of `RecommendedOptions` applies only to kube-apiserver's own
  connections to aggregated servers.
- Measured, in the example and in `requests_wait_for_a_free_stream`: with 99
  open watches a GET goes through. With 100, it waits more than 10 s, then
  goes through once one watch closes, all on one TCP connection.
- hyper-util hands out the shared HTTP/2 connection whenever it is open,
  without counting streams, so it queues the request instead of opening a
  second connection.
- So the hub keeps long-lived streams, watches and followed logs, well below 100. Requests also carry a timeout and show `queued` when they wait, since
  hyper exposes neither the server's limit nor the wait.

## Exec, attach and port-forward

- Exec through `sessions` returns the command's output (`echo ok`).
- Through `api`, the same call fails with
  `UpgradeConnection(ProtocolSwitch(400))`. hyper drops the `Connection`
  and `Upgrade` headers from HTTP/2 requests, which HTTP/2 forbids, so the
  API server sees a plain GET on the exec endpoint and rejects it.
- Attach and port-forward go through the same `Client::connect`, so they
  need `sessions` too.
- Followed logs are a plain streaming GET. They answer over HTTP/2
  (`logs_follow_over_http2`).

## Risks of one connection

- **A dead connection stalls everything.** One TCP connection now carries
  every watch of a cluster.
  - After sleep or a network change, hyper-util still reports the pooled
    connection open
    ([client.rs](https://github.com/hyperium/hyper-util/blob/v0.1.21/src/client/legacy/client.rs#L854)),
    so re-watching on it would wait forever.
  - The idle timer and the wake handler of 3.2 therefore rebuild the
    cluster's `api` client, which drops its pool.
  - HTTP/2 keep-alive pings time out before the idle timer fires. In
    hyper-util they need `.timer(TokioTimer::new())` on the builder as well
    as `http2_keep_alive_interval`.
- **Flow control.** hyper releases window as a stream's body is read. Its
  defaults are 2 MiB per stream and 5 MiB per connection, so one unread
  stream cannot stall the others, but three could. The hub reads every
  stream as it arrives and coalesces in memory, so backpressure never
  reaches the socket.
- **Proxies that terminate TLS** may negotiate HTTP/1.1. ALPN then falls
  back, and every stream becomes a connection again. The budgets of 3.2 stay
  the same either way.

## Recommendation

- Requests, watches and followed logs go through `api`, one HTTP/2
  connection per cluster.
- Exec, attach and port-forward go through `sessions`, one HTTP/1.1
  connection each.
- Budgets per cluster:
  - watches, default 24;
  - followed logs, default 32;
  - sessions, default 64.

  Together, watches and logs stay below the server's 100 streams, which
  leaves room for requests.

- M1 builds the production connector on `Clients`: proxies (6.3), the write
  timeout, TCP keepalive, keep-alive pings, a request timeout, rebuilding
  `api` on idle and wake, and the openssl fallback.

## Changes to the architecture

- 3.2: one HTTP/2 connection per cluster. The budgets above, with the stream
  limit and the request timeout. Among the dead-connection rules,
  keep-alive pings and rebuilding the client.
- 6.2 and 6.4: two clients per context, both with the policy layer;
  upgrades go through `sessions`.
- 6.3: which client carries what.
- 7.3: the HTTP/1.1 risk is replaced by the risks of one connection.

## Tests

The live tests run on every supported release:

- `the_api_client_speaks_http2`: `api` answers HTTP/2, `sessions` HTTP/1.1.
- `requests_wait_for_a_free_stream`, in its own test binary so that `lsof`
  counts only its connections: 100 watches hold one connection, and a GET
  waits until one of them closes.
- `logs_follow_over_http2`: a followed log answers HTTP/2 over `api`.
- `exec_needs_the_sessions_client`: exec works through `sessions` and fails
  with a 400 upgrade through `api`.

The last two need a kubelet, so they refuse kwok clusters.

## Reproducing

```bash
export TWIGO_BENCH_DIR=$(mktemp -d)
kubeconfig=$(bench/cluster.sh up h2 1.37 | tail -1)
bench/pods.sh "$kubeconfig" 5000
TWIGO_TEST_KUBECONFIG=$kubeconfig \
  cargo run --release -p twigo-kube --example http2
bench/cluster.sh down h2
```
