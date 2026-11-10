//! Which headers cross the proxy. Hop-by-hop ones stop at it either way, as
//! Go's `httputil.ReverseProxy` drops them
//! ([`hopHeaders`](https://github.com/golang/go/blob/go1.27.1/src/net/http/httputil/reverseproxy.go#L364-L374)),
//! except `Upgrade` and `Connection: Upgrade` on an upgrade. `Authorization`
//! and `Host` never reach the server: kube's credential layers replace
//! `Authorization` only when the context has a token or a password, and
//! hyper-util sets `Host` only where none is set. Everything else passes as
//! it came, `User-Agent`, `Kubectl-Command` and the WebSocket and SPDY
//! headers included, and nothing is added.

use http::header::{
    AUTHORIZATION, CONNECTION, CONTENT_LENGTH, HOST, PROXY_AUTHENTICATE, PROXY_AUTHORIZATION, TE,
    TRAILER, TRANSFER_ENCODING, UPGRADE,
};
use http::{HeaderMap, HeaderName, HeaderValue};

const HOP_BY_HOP: [HeaderName; 9] = [
    CONNECTION,
    HeaderName::from_static("keep-alive"),
    HeaderName::from_static("proxy-connection"),
    PROXY_AUTHENTICATE,
    PROXY_AUTHORIZATION,
    TE,
    TRAILER,
    TRANSFER_ENCODING,
    UPGRADE,
];

fn end_to_end(headers: &HeaderMap) -> HeaderMap {
    let named: Vec<HeaderName> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect();
    let mut kept = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if !HOP_BY_HOP.contains(name) && !named.contains(name) {
            kept.append(name, value.clone());
        }
    }
    kept
}

/// `Upgrade` as `from` says it, with `Connection: Upgrade`.
fn upgrading(mut kept: HeaderMap, from: &HeaderMap) -> HeaderMap {
    if let Some(protocol) = from.get(UPGRADE) {
        kept.insert(UPGRADE, protocol.clone());
    }
    kept.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
    kept
}

/// What goes on to the server. Its body is sent whole, so hyper sets its
/// length.
pub(super) fn request(headers: &HeaderMap, upgrade: bool) -> HeaderMap {
    let mut kept = end_to_end(headers);
    for name in [AUTHORIZATION, HOST, CONTENT_LENGTH] {
        kept.remove(name);
    }
    if upgrade {
        upgrading(kept, headers)
    } else {
        kept
    }
}

/// What comes back to the client of an answer other than a `101`.
pub(super) fn response(headers: &HeaderMap) -> HeaderMap {
    end_to_end(headers)
}

/// What comes back of a `101`: the server's upgrade headers, among them
/// `Sec-WebSocket-Accept`, which the client checks against its key.
pub(super) fn switched(headers: &HeaderMap) -> HeaderMap {
    upgrading(end_to_end(headers), headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(*name, HeaderValue::from_static(value));
        }
        headers
    }

    #[test]
    fn a_request_keeps_what_the_client_said_and_loses_what_was_for_the_proxy() {
        let came = map(&[
            ("authorization", "Bearer secret"),
            ("host", "127.0.0.1:41234"),
            ("connection", "keep-alive, x-hop"),
            ("x-hop", "1"),
            ("keep-alive", "timeout=5"),
            ("proxy-authorization", "Basic a"),
            ("te", "trailers"),
            ("transfer-encoding", "chunked"),
            ("content-length", "12"),
            ("user-agent", "kubectl/v1.34.1"),
            ("accept", "application/json"),
            ("content-type", "application/apply-patch+yaml"),
            ("kubectl-command", "kubectl apply"),
            ("kubectl-session", "7c1d"),
            ("impersonate-group", "a"),
            ("impersonate-group", "b"),
        ]);
        let sent = request(&came, false);
        assert_eq!(
            sent,
            map(&[
                ("user-agent", "kubectl/v1.34.1"),
                ("accept", "application/json"),
                ("content-type", "application/apply-patch+yaml"),
                ("kubectl-command", "kubectl apply"),
                ("kubectl-session", "7c1d"),
                ("impersonate-group", "a"),
                ("impersonate-group", "b"),
            ])
        );
    }

    #[test]
    fn an_upgrade_keeps_its_upgrade_and_the_websocket_and_spdy_headers() {
        let came = map(&[
            ("connection", "Upgrade"),
            ("upgrade", "websocket"),
            ("sec-websocket-key", "dGhlIHNhbXBsZQ=="),
            ("sec-websocket-version", "13"),
            ("sec-websocket-protocol", "v5.channel.k8s.io"),
            ("x-stream-protocol-version", "v4.channel.k8s.io"),
            ("authorization", "Bearer secret"),
        ]);
        let sent = request(&came, true);
        for name in [
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-protocol",
            "x-stream-protocol-version",
        ] {
            assert_eq!(sent.get(name), came.get(name), "{name}");
        }
        assert_eq!(sent.get("upgrade").unwrap(), "websocket");
        assert_eq!(sent.get("connection").unwrap(), "Upgrade");
        assert!(sent.get("authorization").is_none());
        assert!(
            request(&came, false).get("upgrade").is_none(),
            "only on an upgrade"
        );

        let answered = map(&[
            ("upgrade", "websocket"),
            ("connection", "Upgrade"),
            ("sec-websocket-accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            ("sec-websocket-protocol", "v5.channel.k8s.io"),
        ]);
        assert_eq!(switched(&answered), answered);
    }

    #[test]
    fn a_response_loses_its_hop_by_hop_headers() {
        let came = map(&[
            ("transfer-encoding", "chunked"),
            ("connection", "close"),
            ("content-type", "application/json"),
            ("audit-id", "a"),
            ("warning", "299 - \"deprecated\""),
        ]);
        assert_eq!(
            response(&came),
            map(&[
                ("content-type", "application/json"),
                ("audit-id", "a"),
                ("warning", "299 - \"deprecated\""),
            ])
        );
    }
}
