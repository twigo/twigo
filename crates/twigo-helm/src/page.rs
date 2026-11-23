//! A revision as its release's editor shows it. Its secret-grade parts, the
//! values, the chart's defaults, the manifest, the notes and the
//! description, stay [`Held`] and leave only masked or scrubbed, or
//! through [`Page::revealed`].

use std::collections::BTreeMap;

use serde_json::value::RawValue;
use twigo_ipc::{
    ComparedPart, ComparedRevisions, ErrorCode, HelmPart, IpcError, ReleaseManifest, ReleaseValues,
    Scrubbed,
};
use twigo_policy::redact::manifest::{self, Head};
use twigo_policy::redact::{Held, revealed_text, scrubbed_text, values};

use crate::Stored;
use crate::decode::{PageJson, Summary};

/// The labels Helm sets on every release Secret, which the release's own
/// labels are not
/// ([util.go](https://github.com/helm/helm/blob/v4.3.2/pkg/storage/driver/util.go#L34)).
const SYSTEM_LABELS: [&str; 6] = [
    "name",
    "owner",
    "status",
    "version",
    "createdAt",
    "modifiedAt",
];

/// A revision decoded for its release's editor, kept while it is open.
pub struct Page {
    summary: Summary,
    pub(crate) stored_in: StoredIn,
    pub(crate) chart: Chart,
    /// `ssa`, `csa`, or None for a release of Helm 3, which applies
    /// client-side.
    pub(crate) apply_method: Option<String>,
    pub(crate) hooks: Vec<Hook>,
    /// What its manifest makes, in order.
    pub(crate) objects: Vec<Head>,
    user: Held<Box<RawValue>>,
    defaults: Held<Box<RawValue>>,
    manifest: Held<String>,
    masked: ReleaseManifest,
    notes: Held<String>,
    description: Held<String>,
    /// The values of the Secrets of its manifest and its hooks.
    secret_values: Held<Vec<String>>,
}

/// The Secret that holds the revision.
pub(crate) struct StoredIn {
    pub name: String,
    pub namespace: String,
    /// The release's own labels, Helm's left out.
    pub labels: BTreeMap<String, String>,
}

/// What the chart says of itself beyond its name and versions.
#[derive(Default)]
pub(crate) struct Chart {
    pub name: String,
    pub description: String,
    pub home: String,
    pub sources: Vec<String>,
    pub kube_version: String,
    pub deprecated: bool,
}

pub(crate) struct Hook {
    pub name: String,
    pub kind: String,
    pub events: Vec<String>,
    pub weight: i64,
    /// Its last run's phase, empty for a hook never run.
    pub phase: String,
}

/// The revision `stored` holds, for its release's editor.
pub fn page(stored: &Stored<'_>) -> Result<Page, IpcError> {
    let json: PageJson = stored.read()?;
    let manifest = Held::new(json.manifest);
    let masked = manifest::masked(&manifest);
    let mut secret_values = masked.values;
    let mut hooks = Vec::with_capacity(json.hooks.len());
    for hook in json.hooks {
        let held = manifest::masked(&Held::new(hook.manifest));
        secret_values = secret_values.joined(held.values);
        hooks.push(Hook {
            name: hook.name,
            kind: hook.kind,
            events: hook.events,
            weight: hook.weight,
            phase: hook.last_run.phase,
        });
    }
    let (metadata, defaults) = match json.chart {
        Some(chart) => (chart.metadata, chart.values),
        None => (None, None),
    };
    let head = metadata.as_ref().map(|metadata| {
        (
            metadata.name.clone(),
            metadata.version.clone(),
            metadata.app_version.clone(),
        )
    });
    let chart = metadata.map_or_else(Chart::default, |metadata| Chart {
        name: metadata.name,
        description: metadata.description,
        home: metadata.home,
        sources: metadata.sources,
        kube_version: metadata.kube_version,
        deprecated: metadata.deprecated,
    });
    Ok(Page {
        summary: Summary::of(
            json.name,
            json.version,
            json.namespace,
            json.info.times,
            head,
        ),
        stored_in: StoredIn {
            name: stored.name.to_owned(),
            namespace: stored.namespace.to_owned(),
            labels: stored
                .labels
                .iter()
                .filter(|(key, _)| !SYSTEM_LABELS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        },
        chart,
        apply_method: json.apply_method,
        hooks,
        objects: masked.objects,
        user: Held::new(json.config.unwrap_or_default()),
        defaults: Held::new(defaults.unwrap_or_default()),
        manifest,
        masked: masked.manifest,
        notes: Held::new(json.info.notes),
        description: Held::new(json.info.description),
        secret_values,
    })
}

impl Page {
    pub fn summary(&self) -> &Summary {
        &self.summary
    }

    /// The person's values and the chart's defaults, masked.
    pub fn values(&self) -> ReleaseValues {
        ReleaseValues {
            user: values::masked(&self.user),
            defaults: values::masked(&self.defaults),
        }
    }

    /// The manifest as `helm get manifest` prints it, its Secrets masked.
    pub fn manifest(&self) -> &ReleaseManifest {
        &self.masked
    }

    /// The rendered NOTES.txt, scrubbed of the values of the revision's
    /// Secrets; empty for a chart without one.
    pub fn notes(&self) -> Scrubbed {
        scrubbed_text(&self.notes, &self.secret_values)
    }

    /// What Helm wrote of the revision, scrubbed as the notes are.
    pub fn description(&self) -> Scrubbed {
        scrubbed_text(&self.description, &self.secret_values)
    }

    /// What a Reveal of `part` shows: its text, or its base64 where it is
    /// not UTF-8, and whether it is; `helm.no-value` for a part this
    /// revision does not hold.
    pub fn revealed(&self, part: &HelmPart) -> Result<(String, bool), IpcError> {
        let text = |text: Result<String, IpcError>| text.map(|text| (text, false));
        match part {
            HelmPart::Values { defaults, path } => {
                let held = if *defaults {
                    &self.defaults
                } else {
                    &self.user
                };
                text(values::revealed(held, path))
            }
            HelmPart::Secret {
                document,
                items,
                key,
            } => manifest::secret(&self.manifest, *document, items, key),
            HelmPart::Document { document } => text(manifest::document(&self.manifest, *document)),
            HelmPart::Manifest => text(Ok(manifest::whole(&self.manifest))),
            HelmPart::Notes => {
                text(revealed_text(&self.notes).ok_or_else(|| {
                    IpcError::new(ErrorCode::HelmNoValue, "the revision has no notes")
                }))
            }
            HelmPart::Description => text(revealed_text(&self.description).ok_or_else(|| {
                IpcError::new(ErrorCode::HelmNoValue, "the revision has no description")
            })),
        }
    }
}

/// Two revisions of a release masked for a comparison, a masked value that
/// differs from its counterpart reading `<N bytes, before>` on the lower
/// revision's side and `<N bytes, after>` on the higher's, whichever of them
/// `from` is.
pub fn compared(from: &Page, to: &Page, part: ComparedPart) -> ComparedRevisions {
    let reversed = from.summary.revision() > to.summary.revision();
    let (before, after) = if reversed { (to, from) } else { (from, to) };
    let (before, after) = match part {
        ComparedPart::Values => values::compared(&before.user, &after.user),
        ComparedPart::Defaults => values::compared(&before.defaults, &after.defaults),
        ComparedPart::Manifest => manifest::compared(
            (&before.manifest, before.summary.namespace()),
            (&after.manifest, after.summary.namespace()),
        ),
    };
    if reversed {
        ComparedRevisions {
            from: after,
            to: before,
        }
    } else {
        ComparedRevisions {
            from: before,
            to: after,
        }
    }
}
