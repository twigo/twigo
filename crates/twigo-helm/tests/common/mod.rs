//! The recorded release Secrets and what helm printed for them.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use twigo_helm::Stored;

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

pub fn text(path: &str) -> String {
    std::fs::read_to_string(fixtures().join(path)).unwrap()
}

pub struct Recorded {
    pub name: String,
    pub namespace: String,
    pub kind: String,
    pub labels: BTreeMap<String, String>,
    pub release: Option<Vec<u8>>,
}

impl Recorded {
    pub fn stored(&self) -> Stored<'_> {
        Stored {
            name: &self.name,
            namespace: &self.namespace,
            kind: &self.kind,
            labels: &self.labels,
            release: self.release.as_deref(),
        }
    }
}

/// `secrets/<file>.json`, its `data.release` with the API's base64 taken
/// off, as the core holds a Secret's bytes.
pub fn secret(file: &str) -> Recorded {
    recorded(&format!("secrets/{file}.json"), |text| {
        STANDARD.decode(text).unwrap()
    })
}

pub fn recorded(path: &str, release: impl Fn(&str) -> Vec<u8>) -> Recorded {
    let object: Value = serde_json::from_str(&text(path)).unwrap();
    let metadata = &object["metadata"];
    Recorded {
        name: metadata["name"].as_str().unwrap().to_owned(),
        namespace: metadata["namespace"].as_str().unwrap().to_owned(),
        kind: object["type"].as_str().unwrap_or_default().to_owned(),
        labels: serde_json::from_value(metadata["labels"].clone()).unwrap(),
        release: object["data"]["release"].as_str().map(release),
    }
}
