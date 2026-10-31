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
  unless it runs with HTTP/2 disabled.

- **`sessions`** is kube's default client, for exec, attach and port-forward.

What kube's default stack has and `api` does not yet:

- the kubeconfig `proxy-url`, which `Clients::new` refuses for now: the
  connector of 6.3 brings it, with `NO_PROXY` and the OS settings;
- connect, read and write timeouts;
- the retry, gzip and tracing layers.

## Measurements

`examples/http2.rs` ran three times on kind 1.37 (macOS, Docker Desktop)
against 5,000 kwok pods in namespace `bench`.

- 50 Table watches on that namespace's pods.
- 200 sequential `GET …/pods?limit=1` per state.
- TCP connections to the API server counted with `lsof -iTCP@127.0.0.1:<port>
-sTCP:ESTABLISHED` on the process itself.
- Churn: the Deployment is scaled between 5,000 and 4,750 every 3 s, through
  the client under test. Each mode's watches read 37,500 events, 85 to 86
  MiB in all.

First run:

| Client, state                    | TCP connections | GET p50 ms | p95 | p99 | max   |
| -------------------------------- | --------------- | ---------- | --- | --- | ----- |
| HTTP/1.1, no watches             | 1               | 0.8        | 1.4 | 2.6 | 10.8  |
| HTTP/1.1, 50 quiet watches       | 51              | 0.8        | 1.5 | 2.0 | 10.2  |
| HTTP/1.1, 50 watches under churn | 51              | 0.8        | 1.7 | 4.2 | 4.6   |
| HTTP/2, no watches               | 1               | 0.8        | 1.3 | 1.9 | 9.5   |
| HTTP/2, 50 quiet watches         | 1               | 0.8        | 1.8 | 2.8 | 8.2   |
| HTTP/2, 50 watches under churn   | 1               | 1.0        | 1.7 | 5.1 | 104.2 |

Over the three runs:

- p50 stayed at 0.7 to 1.0 ms and p95 at 1.0 to 1.9 ms for both clients.
- p99 ranged from 1.7 to 5.4 ms for both.
- The maximum is a single sample. It spiked to about 100 ms once for each
  client under churn (HTTP/2 104 ms, HTTP/1.1 97 ms) and stayed under 16 ms
  otherwise.

On a local cluster HTTP/2 costs nothing in latency. What it saves is one TCP
and TLS connection per watch, on the client, on the API server, and on
every proxy or load balancer between them.

## The stream limit

- kube-apiserver allows 100 concurrent streams per HTTP/2 connection unless
  `--http2-max-streams-per-connection` is set
  ([secure_serving.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/server/secure_serving.go#L191-L199)).
  Its flag defaults to 0
  ([serving.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubeapiserver/options/serving.go#L27-L38)).
- Aggregated servers built with `RecommendedOptions` allow 1,000
  ([recommended.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/server/options/recommended.go#L56-L62)).
- Measured: with 99 open watches a GET still went through; with 100 it waited
  more than 10 s. The client stayed on one TCP connection: hyper queues the
  request for a free stream and opens no second connection.
- So the hub keeps long-lived streams, watches and followed logs, well below 100.

## Exec, attach and port-forward

- Exec through `sessions` returns the command's output (`echo ok`).
- Through `api`, the same call fails with
  `UpgradeConnection(ProtocolSwitch(400))`. The API server answers the
  WebSocket upgrade request on an HTTP/2 stream with 400 Bad Request, since
  Upgrade does not exist in HTTP/2.
- Attach and port-forward use the same upgrade, so they need `sessions` too.
- Followed logs are a plain streaming GET and work over `api`
  (`logs_follow_over_http2`).

## Risks of one connection

- **A dead connection stalls everything.** One TCP connection now carries
  every watch of a cluster. M1 turns on HTTP/2 keep-alive pings
  (`hyper-util`'s `http2_keep_alive_interval`) next to the idle timers of
  3.2.
- **Flow control.** The connection's receive window is released only as
  streams are read. A stream nobody reads could stall the others. The hub
  reads every stream as it arrives and coalesces in memory, so
  backpressure never reaches the socket.
- **Proxies that terminate TLS** may negotiate HTTP/1.1. ALPN then falls
  back, and every stream becomes a connection again. The budgets of 3.2 stay
  the same either way.
- **Head-of-line blocking** on packet loss affects all streams at once. On
  the networks measured here it did not show; a lossy-network benchmark
  belongs to the bench of step 7.

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

- M1 builds the production connector on `Clients`: proxy support (6.3),
  timeouts, keep-alive pings and the openssl fallback.

## Changes to the architecture

- 3.2: one HTTP/2 connection per cluster; the budgets above, with the stream
  limit; keep-alive pings among the dead-connection rules.
- 6.3: which client carries what.
- 7.3: the HTTP/1.1 risk is replaced by the risks of one connection.

## Tests

The live tests run on every supported release:

- `the_api_client_speaks_http2`: `api` answers HTTP/2, `sessions` HTTP/1.1.
- `requests_go_through_while_watches_hold_streams`: a GET passes while 20
  Table watches are open.
- `logs_follow_over_http2`: a followed log over `api`.
- `exec_needs_the_sessions_client`: exec works through `sessions` and fails
  with a 400 upgrade through `api`.

## Reproducing

```bash
export TWIGO_BENCH_DIR=$(mktemp -d)
kubeconfig=$(bench/cluster.sh up h2 1.37 | tail -1)
bench/pods.sh "$kubeconfig" 5000
TWIGO_TEST_KUBECONFIG=$kubeconfig \
  cargo run --release -p twigo-kube --example http2
bench/cluster.sh down h2
```
