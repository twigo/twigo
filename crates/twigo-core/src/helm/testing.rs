//! Release Secrets as Helm's Secrets driver writes them, for the tests on
//! the fake: the release's JSON gzipped at its best compression and in
//! base64, which the API puts in base64 again
//! ([util.go](https://github.com/helm/helm/blob/v4.3.2/pkg/storage/driver/util.go#L38-L57),
//! [secrets.go](https://github.com/helm/helm/blob/v4.3.2/pkg/storage/driver/secrets.go#L247-L285)).

use std::io::Write;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Value, json};
use twigo_cache::fake::Fake;

/// The name Helm gives the Secret of a release's revision.
pub(super) fn secret_name(release: &str, revision: u32) -> String {
    format!("sh.helm.release.v1.{release}.v{revision}")
}

/// A revision of a release of the chart `demo`, whose chart version and
/// `last_deployed` tell its revisions apart.
pub(super) fn release(namespace: &str, name: &str, version: u32, status: &str) -> Value {
    json!({
        "name": name,
        "namespace": namespace,
        "version": version,
        "info": {
            "first_deployed": "2026-11-01T10:00:00Z",
            "last_deployed": format!("2026-11-{:02}T10:00:00Z", version.min(28)),
            "status": status,
            "description": "Install complete",
            "notes": format!("Revision {version} of {name}"),
        },
        "chart": {
            "metadata": { "name": "demo", "version": format!("1.{version}.0"), "appVersion": "2.0" },
            "values": { "replicas": 1 },
        },
        "config": { "image": format!("demo:{version}") },
        "manifest": format!(
            "---\n# Source: demo/templates/config.yaml\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {name}\ndata:\n  revision: \"{version}\"\n"
        ),
    })
}

/// Helm's base64 of the gzip of `release`'s JSON.
pub(super) fn encoded(release: &Value) -> Vec<u8> {
    let mut gzip = GzEncoder::new(Vec::new(), Compression::best());
    gzip.write_all(&serde_json::to_vec(release).unwrap())
        .unwrap();
    STANDARD.encode(gzip.finish().unwrap()).into_bytes()
}

/// `release` stored in `namespace`, its labels saying `status`.
pub(super) fn put(fake: &Fake, release: &Value, status: &str) {
    let namespace = release["namespace"].as_str().unwrap();
    let name = release["name"].as_str().unwrap();
    let version = u32::try_from(release["version"].as_u64().unwrap()).unwrap();
    put_payload(fake, namespace, name, version, status, &encoded(release));
}

/// A release Secret whose `release` key holds `payload` under the API's
/// base64.
pub(super) fn put_payload(
    fake: &Fake,
    namespace: &str,
    name: &str,
    version: u32,
    status: &str,
    payload: &[u8],
) {
    fake.put(
        "",
        "secrets",
        Some(namespace),
        json!({
            "kind": "Secret",
            "apiVersion": "v1",
            "type": "helm.sh/release.v1",
            "metadata": {
                "name": secret_name(name, version),
                "namespace": namespace,
                "uid": format!("{namespace}-{name}-{version}"),
                "labels": {
                    "owner": "helm",
                    "name": name,
                    "version": version.to_string(),
                    "status": status,
                },
            },
            "data": { "release": STANDARD.encode(payload) },
        }),
    );
}

/// How many `GET`s the fake had of a revision's Secret.
pub(super) fn gets(fake: &Fake, namespace: &str, name: &str, version: u32) -> usize {
    let path = format!(
        "/api/v1/namespaces/{namespace}/secrets/{}",
        secret_name(name, version)
    );
    fake.state()
        .requests
        .iter()
        .filter(|(_, request)| request.ends_with(&path))
        .count()
}
