# Spike: HTTP/2

M0 step 3, 2026-10-31.
The question: can kube-rs carry requests and watches over one HTTP/2 connection, while exec, attach and port-forward use a separate HTTP/1.1 pool?
See the first risk in 7.3 and the budgets in 3.2.

**Answer: yes.**
Fifty Table watches share one TCP connection instead of 51, and GET latency does not change.
Exec cannot use that connection and goes over a separate HTTP/1.1 client.
The new limit to plan for is the server's 100 streams per connection.

- Clients: `crates/twigo-kube/src/client.rs`.
- Measurement: `crates/twigo-kube/examples/http2.rs`.
- Tests: `crates/twigo-kube/tests/clients_live.rs` and `streams_live.rs`, run per release by `bench/test-matrix.sh` and `.github/workflows/kubernetes.yml`.

## The clients

`twigo_kube::client::Clients` holds two clients per context.

- **`api`** handles requests, watches and followed logs.
  It uses kube's `Client::new` over a tower stack of kube's own layers from `ConfigExt`:
  - base URI;
  - auth, including exec plugins and token refresh;
  - extra headers, such as impersonation.

  Under them sits a hyper-util client whose rustls connector offers both `h2` and `http/1.1` over ALPN.
  kube's builder offers only `http/1.1` ([config_ext.rs](https://github.com/kube-rs/kube/blob/4.2.0/kube-client/src/client/config_ext.rs#L426-L447)), and its hyper is built with `http1` alone.
  kube-apiserver answers `h2` unless it runs with HTTP/2 disabled.
  - **TLS** comes from kube's own `rustls_client_config` and server-name resolver.
    Verification, CA reloading, `tls-server-name` and client certificates therefore match kube's stack.
  - **Timeouts.**
    The connector sits in hyper-timeout's `TimeoutConnector`, as in kube: 30 s to connect, TLS included, and 295 s for one stalled write.
    The `HttpConnector` underneath also gets the 30 s, which it splits between a host's addresses.
    There is deliberately no read timeout: on a multiplexed connection it would time the whole connection and cut every watch of a quiet cluster.
    3.2's request timeout is a tower layer per request instead.
  - **The pool** never expires the connection (`pool_idle_timeout(None)`).
    - hyper-util refreshes a shared HTTP/2 entry only when a request checks it out.
      After 90 s without one, it expires the entry while the watches still stream on it, and the next request opens a second connection.
    - Measured: 10 watches, no request for 100 s, then a GET.
      With the line reverted to the default, that held 2 TCP connections; with it, 1.
    - Closed connections and those that got a GOAWAY still leave the pool, at their next checkout.
    - Two costs remain, and M1 handles both:
      - A request sent while the server's own 90 s idle GOAWAY is in flight fails, and hyper does not retry it.
        M1 retries once any request whose stream ended with the server's GOAWAY.
      - Pings skip a connection without streams by default, so a dead idle connection would meet the next request.
        M1 pings while idle too.

- **`sessions`** is kube's default client, for exec, attach and port-forward.
  It is built first: only kube's builder can read the expiry of an exec plugin's certificate.
  `api` copies it (`valid_until`), so the copy is the older of the two certificates' expiries.

What `api` lacks next to kube's default stack:

- the retry and tracing layers;
- proxies.
  kube fills `proxy_url` from the kubeconfig or from `HTTPS_PROXY`/`https_proxy`, and `Clients::new` refuses any of them for now.
  kube's own stack carries proxies only with its `http-proxy` and `socks5` features, which this build does not enable either.
  The connector of 6.3 brings proxies, with `NO_PROXY` and the OS settings.

Neither client sets TCP keepalive or HTTP/2 keep-alive pings yet; 3.2 asks for both.
Building `Clients` runs an exec plugin five times, three for `sessions` and two for `api`, until the credential runner of 6.2 replaces kube's exec auth.

`Clients` holds finished `kube::Client`s, which take no further layer.
For the per-actor policy layers of 6.4, M1's `Clients` keeps the two hyper-util clients and builds each actor's kube clients over them.
A hyper-util clone shares its pool.
kube's `ClientBuilder::try_from`, by contrast, builds a new pool on every call, so M1 builds the HTTP/1.1 client by hand too.

## Measurements

`examples/http2.rs` ran three times on kind 1.37 (macOS, Docker Desktop) against 5,000 kwok pods in namespace `bench`.

- 50 Table watches on that namespace's pods.
- Sequential `GET …/pods?limit=1` for 10 s per state, 9,000 to 13,300 of them.
- TCP connections to the API server counted with `lsof -iTCP:<port> -sTCP:ESTABLISHED` on the process itself.
- Churn: the client under test rescales the Deployment by 100 pods every second, so ten steps fall in each 10 s window.
  Every churn window read 150,000 events: 50 watches, 10 steps, 100 pods, 3 events per pod.
  No watch ended.
- Each run measures HTTP/1.1, HTTP/2, HTTP/2, HTTP/1.1, with a fresh client per phase.
  Between phases it waits until the Deployment's observed generation and available pods are back at 5,000.

The first HTTP/1.1 and first HTTP/2 phases of the second run:

| Client, state                    | TCP connections | GETs   | p50 ms | p95 | p99 | max   |
| -------------------------------- | --------------- | ------ | ------ | --- | --- | ----- |
| HTTP/1.1, no watches             | 1               | 12,929 | 0.7    | 0.9 | 1.6 | 88.1  |
| HTTP/1.1, 50 quiet watches       | 51              | 12,762 | 0.7    | 0.9 | 1.5 | 102.0 |
| HTTP/1.1, 50 watches under churn | 52              | 10,095 | 0.7    | 1.2 | 7.3 | 101.0 |
| HTTP/2, no watches               | 1               | 12,908 | 0.7    | 0.9 | 1.5 | 100.5 |
| HTTP/2, 50 quiet watches         | 1               | 13,275 | 0.7    | 0.9 | 1.7 | 88.3  |
| HTTP/2, 50 watches under churn   | 1               | 10,137 | 0.7    | 1.2 | 7.5 | 102.1 |

Over the three runs and all twelve phases:

- p50 was 0.7 ms everywhere.
- Under churn:
  - p95 was 1.2 to 1.9 ms over HTTP/1.1 and 1.1 to 1.3 ms over HTTP/2;
  - p99 was 7.3 to 10.4 ms over HTTP/1.1 and 7.5 to 9.2 ms over HTTP/2.
- Between the bursts most GETs run on an idle server, so p50 cannot differ.
  The signal is in p95 and p99, and they match.
- The maximum was 78 to 110 ms in every state, without watches too, and for both protocols, so it comes from the environment.
- HTTP/1.1 held 51 connections, 50 for the watches and 1 for the GETs, and 52 or 53 while the churn's patches ran next to the GETs.
- The API server closed no watcher for being slow: on the third run's cluster, which also served the idle checks and saw 1.67 million pod watch events, `apiserver_terminated_watchers_total` had no series.
  The counter's vector appears only after its first increment.
- An earlier method churned 250 pods every 3 s and had no counter for ended watches.
  One of its windows read 60,750 events instead of 112,500.
  That is the full count of 27 watches, or 1.62 steps for all 50; that method cannot tell which.

On a local cluster HTTP/2 costs nothing in latency.
What it saves is one TCP and TLS connection per watch, on the client, on the API server, and on every proxy or load balancer between them.
Head-of-line blocking under packet loss was not measured: loopback loses nothing.
That belongs to the bench of step 7.

**Cold start.**
A cold `api` client opens one TCP and TLS connection per concurrent first request.

- hyper-util's default `Ver::Auto` takes no connecting lock ([pool.rs](https://github.com/hyperium/hyper-util/blob/v0.1.21/src/client/legacy/pool.rs#L174-L198)).
- It decides for HTTP/2 only after ALPN ([client.rs](https://github.com/hyperium/hyper-util/blob/v0.1.21/src/client/legacy/client.rs#L496-L535)).
- So 50 watches opened at once start 50 handshakes, and 49 are dropped once the first one negotiates `h2`.
- `lsof`, which takes tens of milliseconds per run, cannot see such short connections, so the example does not try.
- M1 sends one request before it opens watches: after every client rebuild and every new connection (GOAWAY, a failed ping, poisoning).

## The stream limit

- kube-apiserver allows 100 concurrent streams per HTTP/2 connection unless `--http2-max-streams-per-connection` is set ([secure_serving.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/server/secure_serving.go#L191-L199)).
  Its flag defaults to 0 ([serving.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubeapiserver/options/serving.go#L27-L38)).
  The 1,000 of `RecommendedOptions` applies only to kube-apiserver's own connections to aggregated servers.
- Measured in `requests_wait_for_a_free_stream`, on every release in CI: with 100 open watches a GET still waits after 5 s.
  Once one watch closes, it goes through over HTTP/2, all on one TCP connection.
- hyper-util hands out the shared HTTP/2 connection whenever it is open, without counting streams.
  It queues the request instead of opening a second connection, and it exposes neither the server's limit nor the wait.
- So Twigo counts streams itself:
  - **One counter per context.**
    It is a single state that every actor shares, below every actor's policy layer.
    The watch hub, commands, discovery, MCP tools, extensions and the policy proxy all pass it.
  - **Permits.**
    A stream takes a permit for its class inside the call, and the permit moves into the response body.
    It lives until the stream ends, not until the headers arrive, as with tower's `ConcurrencyLimit`.
  - **Budgets:**
    - watches, default 24;
    - followed logs, default 32;
    - the policy proxy's streams, default 16;
    - requests, the 28 left, at most 20 of them for actors other than the UI.
- A watch, log or request over its budget waits in the counter, which is what shows `queued`.
  The proxy's class answers `429` instead, as 6.4 specifies.
- Timeouts start when the counter admits a stream.
  A per-request timeout backs the counter up against a server with a lower limit.

## Exec, attach and port-forward

- Exec through `sessions` returns the command's output (`echo ok`).
- Through `api`, the same call fails with `UpgradeConnection(ProtocolSwitch(400))`.
  hyper drops the `Connection` and `Upgrade` headers from HTTP/2 requests, which HTTP/2 forbids.
  The API server sees a plain GET on the exec endpoint and rejects it.
- Attach and port-forward go through the same `Client::connect`, so they need `sessions` too.
- Followed logs are a plain streaming GET.
  They answer over HTTP/2 (`logs_follow_over_http2`).

## Risks of one connection

- **A dead connection stalls everything.**
  One TCP connection now carries every watch of a cluster.
  - **Pings** close a dead connection, while idle too.
    In hyper-util they need `.timer(TokioTimer::new())` on the builder as well as `http2_keep_alive_interval` and `http2_keep_alive_while_idle`.
  - **Wake and network change.**
    After sleep or a network change, hyper-util can still report the pooled connection open ([client.rs](https://github.com/hyperium/hyper-util/blob/v0.1.21/src/client/legacy/client.rs#L854)).
    A re-watch on it would wait until TCP gives up, minutes later.
    So 3.2 retires the connection then, and every upstream re-watches.
    - Retiring means poisoning, through `capture_connection`; hyper-util's `is_open` checks for it.
    - Rebuilding the client would not do: every actor's kube client holds a clone of the pool and would stay on the dead connection.
  - **Idle timer.**
    It fires when one upstream is quiet, often on a healthy connection.
    - A probe request goes over the connection first.
      If it answers, only that upstream re-watches.
    - If it fails, the connection is retired and every upstream re-watches, as on wake.
    - Retiring a live connection would cost a new handshake, and the old connection would linger until its streams end.
- **Flow control.**
  hyper releases window as a stream's body is read.
  Its defaults are 2 MiB per stream and 5 MiB per connection, so one unread stream cannot stall the others, but three could.
  The hub reads every stream as it arrives and coalesces in memory, so backpressure never reaches the socket.
- **Proxies that terminate TLS** may negotiate HTTP/1.1.
  ALPN then falls back, and every stream becomes a connection again.
  The budgets of 3.2 stay the same either way.

## Recommendation

- Requests, watches and followed logs go through `api`, one HTTP/2 connection per cluster.
- Exec, attach and port-forward go through `sessions`, one HTTP/1.1 connection each.
- One stream counter per context, below every actor, with the budgets above.
  Sessions keep their own budget of 64 connections, counted in the same place.
  A session's permit lives with its upgraded stream, since `hyper::upgrade::on` drops the `101` response that would otherwise hold it.
- M1 builds the production connector on `Clients`:
  - shared hyper-util clients for the actors;
  - proxies (6.3);
  - TCP keepalive, and keep-alive pings while idle too;
  - one retry after a server GOAWAY;
  - poisoning on wake, on a network change, and after a failed probe;
  - the stream counter and the request timeout;
  - one warming request per new connection;
  - the openssl fallback.

## Changes to the architecture

- 3.2: one HTTP/2 connection per cluster.
  One stream counter per context, shared by every actor, with the budgets above, and the request timeout.
  Among the dead-connection rules: pings while idle, a retry after GOAWAY, poisoning on wake and network change, and a probe before the idle timer retires anything.
- 6.2 and 6.4: two shared hyper-util clients per context.
  Every actor's kube clients carry its policy layer over them and over the stream counter.
  Upgrades go through the HTTP/1.1 client.
  The proxy's stream cap is 16.
- 6.3: which client carries what, and the fingerprint rebuild covers every actor.
- 7.3: the HTTP/1.1 risk is replaced by the risks of one connection.

## Tests

The live tests run on every supported release:

- `the_api_client_speaks_http2`: `api` answers HTTP/2, `sessions` HTTP/1.1.
- `requests_wait_for_a_free_stream`: 100 watches hold one connection, and a GET waits until one of them closes.
  `lsof` counts the whole process, so this test has a binary of its own.
- `logs_follow_over_http2`: a followed log answers HTTP/2 over `api`.
- `exec_needs_the_sessions_client`: exec works through `sessions` and fails with a 400 upgrade through `api`.

The last two need a kubelet, so they refuse kwok clusters.
The idle-pool check takes 100 s, so it lives in the example, not in CI; the comment at `pool_idle_timeout(None)` says why the line must stay.

## Reproducing

```bash
export TWIGO_BENCH_DIR=$(mktemp -d)
kubeconfig=$(bench/cluster.sh up h2 1.37 | tail -1)
bench/pods.sh "$kubeconfig" 5000
TWIGO_TEST_KUBECONFIG=$kubeconfig \
  cargo run --release -p twigo-kube --example http2
kubectl --kubeconfig "$kubeconfig" get --raw /metrics \
  | grep apiserver_terminated_watchers_total   # no output: none closed
bench/cluster.sh down h2
```
