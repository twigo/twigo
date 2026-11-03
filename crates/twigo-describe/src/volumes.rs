//! A pod's volumes as a table of name, type and source, the types named
//! as kubectl names them (kubectl v1.37.1, `describeVolumes`); a ConfigMap,
//! Secret or claim a volume reads is a link.

use serde_json::Value;
use twigo_ipc::{Block, Value as Shown};

use crate::show::{CONFIG_MAP, PVC, SECRET, link, list, plain, scalar};
use crate::text;

pub(crate) fn block(spec: &Value, namespace: Option<&str>) -> Option<Block> {
    let rows: Vec<Vec<Shown>> = spec["volumes"]
        .as_array()?
        .iter()
        .map(|volume| {
            let (kind, source) = source(volume, namespace);
            vec![
                plain(volume["name"].as_str().unwrap_or_default()),
                plain(kind),
                source,
            ]
        })
        .collect();
    (!rows.is_empty()).then(|| Block::Table {
        columns: vec!["Name".to_owned(), "Type".to_owned(), "Source".to_owned()],
        rows,
    })
}

/// The volume's type and what it reads.
fn source(volume: &Value, namespace: Option<&str>) -> (String, Shown) {
    let optional = |reference: &Value| reference["optional"].as_bool() == Some(true);
    let named = |kind, name: &str, optional: bool| {
        let shown = if optional {
            format!("{name}, optional")
        } else {
            name.to_owned()
        };
        link(kind, namespace, name, shown)
    };
    let Some((key, source)) = volume
        .as_object()
        .and_then(|volume| volume.iter().find(|(key, _)| *key != "name"))
    else {
        return ("Unknown".to_owned(), plain(""));
    };
    let shown = match key.as_str() {
        "configMap" => named(
            CONFIG_MAP,
            source["name"].as_str().unwrap_or_default(),
            optional(source),
        ),
        "secret" => named(
            SECRET,
            source["secretName"].as_str().unwrap_or_default(),
            optional(source),
        ),
        "persistentVolumeClaim" => {
            let name = source["claimName"].as_str().unwrap_or_default();
            let shown = if source["readOnly"].as_bool() == Some(true) {
                format!("{name}, read-only")
            } else {
                name.to_owned()
            };
            link(PVC, namespace, name, shown)
        }
        "projected" => list(
            source["sources"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|projection| projected(projection, namespace))
                .collect(),
        )
        .unwrap_or_else(|| plain("")),
        "emptyDir" => {
            let medium = text(&source["medium"]).unwrap_or_else(|| "node disk".to_owned());
            plain(match text(&source["sizeLimit"]) {
                Some(limit) => format!("{medium}, up to {limit}"),
                None => medium,
            })
        }
        "hostPath" => plain(match text(&source["type"]) {
            Some(kind) => format!("{} ({kind})", source["path"].as_str().unwrap_or_default()),
            None => source["path"].as_str().unwrap_or_default().to_owned(),
        }),
        "downwardAPI" => plain(downward(&source["items"])),
        "ephemeral" => {
            let spec = &source["volumeClaimTemplate"]["spec"];
            let mut parts = Vec::new();
            parts.extend(text(&spec["storageClassName"]));
            parts.extend(text(&spec["resources"]["requests"]["storage"]));
            parts.extend(modes(&spec["accessModes"]));
            plain(parts.join(", "))
        }
        "csi" => {
            let mut parts = vec![source["driver"].as_str().unwrap_or_default().to_owned()];
            if source["readOnly"].as_bool() == Some(true) {
                parts.push("read-only".to_owned());
            }
            plain(parts.join(", "))
        }
        "nfs" => plain(format!(
            "{}:{}",
            source["server"].as_str().unwrap_or_default(),
            source["path"].as_str().unwrap_or_default()
        )),
        "image" => plain(source["reference"].as_str().unwrap_or_default()),
        _ => plain(generic(source)),
    };
    (kind(key), shown)
}

/// A projected volume's source: a link for a ConfigMap or Secret.
fn projected(projection: &Value, namespace: Option<&str>) -> Option<Shown> {
    let (key, source) = projection.as_object()?.iter().next()?;
    Some(match key.as_str() {
        "configMap" => {
            let name = source["name"].as_str().unwrap_or_default();
            link(CONFIG_MAP, namespace, name, format!("ConfigMap {name}"))
        }
        "secret" => {
            let name = source["name"].as_str().unwrap_or_default();
            link(SECRET, namespace, name, format!("Secret {name}"))
        }
        "serviceAccountToken" => plain(match source["expirationSeconds"].as_i64() {
            Some(seconds) => format!("Service account token, {seconds} s"),
            None => "Service account token".to_owned(),
        }),
        "downwardAPI" => plain(format!("Downward API: {}", downward(&source["items"]))),
        "clusterTrustBundle" => plain(format!(
            "Cluster trust bundle {}",
            text(&source["name"])
                .or_else(|| text(&source["signerName"]))
                .unwrap_or_default()
        )),
        other => plain(kind(other)),
    })
}

/// `metadata.namespace -> namespace`, as kubectl prints a downward API's
/// items.
fn downward(items: &Value) -> String {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let from = text(&item["fieldRef"]["fieldPath"])
                .or_else(|| text(&item["resourceFieldRef"]["resource"]))?;
            Some(format!(
                "{from} -> {}",
                item["path"].as_str().unwrap_or_default()
            ))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn modes(modes: &Value) -> Option<String> {
    let modes: Vec<&str> = modes.as_array()?.iter().filter_map(Value::as_str).collect();
    (!modes.is_empty()).then(|| modes.join(","))
}

/// A source's scalar fields, `key: value`, for the types kubectl prints
/// field by field and few clusters still use.
fn generic(source: &Value) -> String {
    source
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some(format!("{key}: {}", scalar(value)?)))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The type as kubectl names it: `PersistentVolumeClaim`, `CSI`.
fn kind(key: &str) -> String {
    match key {
        "persistentVolumeClaim" => "PersistentVolumeClaim".to_owned(),
        "downwardAPI" => "DownwardAPI".to_owned(),
        "csi" => "CSI".to_owned(),
        "nfs" => "NFS".to_owned(),
        "iscsi" => "ISCSI".to_owned(),
        "rbd" => "RBD".to_owned(),
        "fc" => "FC".to_owned(),
        "cephfs" => "CephFS".to_owned(),
        "gcePersistentDisk" => "GCEPersistentDisk".to_owned(),
        "awsElasticBlockStore" => "AWSElasticBlockStore".to_owned(),
        "serviceAccountToken" => "Service account token".to_owned(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        }
    }
}
