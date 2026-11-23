//! A release Secret's payload into a revision, as Helm's `decodeRelease`
//! reads it ([v4.3.2](https://github.com/helm/helm/blob/v4.3.2/pkg/storage/driver/util.go#L62-L91),
//! the same since v3.10.0): Helm's base64 as Go's `base64.StdEncoding`
//! reads it, then gzip where the bytes start with its magic `1f 8b 08`,
//! else the bytes as JSON. Unlike Helm, Twigo inflates no more than
//! [`BOUND`].

use std::collections::BTreeMap;
use std::io::{ErrorKind, Read};

use flate2::read::MultiGzDecoder;
use jiff::Timestamp;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer};
use serde_json::error::Category;
use serde_json::value::RawValue;
use twigo_ipc::{ErrorCode, IpcError};
use twigo_policy::redact::decode_base64;

use crate::Status;

/// The most JSON a release may inflate to: real charts inflate 4.9 to 12.7
/// times, so a release at Kubernetes' 1 MiB limit reaches about 10 MB, while
/// gzip inflates up to about 1,000 times.
pub const BOUND: usize = 32 << 20;

/// The `type` Helm gives its release Secrets, which it never reads back.
const RELEASE_TYPE: &str = "helm.sh/release.v1";

const GZIP: [u8; 3] = [0x1f, 0x8b, 0x08];

/// A Secret that holds a revision of a release, as the core holds it: any
/// Secret labelled `owner=helm` is read, whatever its `type`, as Helm reads
/// it.
pub struct Stored<'a> {
    /// The Secret's name.
    pub name: &'a str,
    pub namespace: &'a str,
    /// Its `type`.
    pub kind: &'a str,
    pub labels: &'a BTreeMap<String, String>,
    /// `data.release` as the API decoded it, which is Helm's base64; None
    /// for a Secret with no such key.
    pub release: Option<&'a [u8]>,
}

impl Stored<'_> {
    /// A refusal that names the Secret's type where it is not Helm's.
    fn refused(&self, code: ErrorCode, what: &str) -> IpcError {
        let message = match self.kind {
            RELEASE_TYPE => what.to_owned(),
            "" => format!("{what}; the Secret has no type"),
            kind => format!("{what}; the Secret's type is {kind}"),
        };
        IpcError::new(code, message)
    }

    /// The release and revision its `name` and `version` labels name.
    fn identity(&self) -> Result<(&str, u32), IpcError> {
        let label = |key: &str| self.labels.get(key).map(String::as_str);
        let (Some(name), Some(version)) = (label("name"), label("version")) else {
            return Err(self.refused(
                ErrorCode::HelmNotARelease,
                "the Secret has no name and version labels of Helm's",
            ));
        };
        let revision = version.parse().map_err(|_| {
            self.refused(
                ErrorCode::HelmNotARelease,
                "its version label is not a revision",
            )
        })?;
        Ok((name, revision))
    }

    /// The release's JSON: Helm's base64 decoded, and inflated where it is
    /// gzip.
    fn json(&self) -> Result<Vec<u8>, IpcError> {
        let release = self.release.ok_or_else(|| {
            self.refused(ErrorCode::HelmNotARelease, "the Secret holds no release")
        })?;
        let bytes = decode_base64(release)
            .ok_or_else(|| self.refused(ErrorCode::HelmNotARelease, "its release is not base64"))?;
        if bytes.len() > GZIP.len() && bytes.starts_with(&GZIP) {
            inflated(&bytes).map_err(|failure| match failure {
                Failure::TooLarge => {
                    self.refused(ErrorCode::HelmTooLarge, "its release inflates past 32 MiB")
                }
                Failure::Truncated => {
                    self.refused(ErrorCode::HelmTruncated, "its release's gzip ends early")
                }
                Failure::Damaged => {
                    self.refused(ErrorCode::HelmNotARelease, "its release's gzip is damaged")
                }
            })
        } else {
            Ok(bytes)
        }
    }

    /// `T` from the release's JSON, checked against the labels.
    pub(crate) fn read<T: for<'de> Deserialize<'de> + Revision>(&self) -> Result<T, IpcError> {
        let (name, revision) = self.identity()?;
        let read: T = serde_json::from_slice(&self.json()?).map_err(|error| {
            let (line, column) = (error.line(), error.column());
            match error.classify() {
                Category::Eof => self.refused(
                    ErrorCode::HelmTruncated,
                    &format!("its release's JSON ends early, at line {line}, column {column}"),
                ),
                Category::Syntax | Category::Io => self.refused(
                    ErrorCode::HelmNotARelease,
                    &format!("its release is not JSON: it breaks at line {line}, column {column}"),
                ),
                Category::Data => self.refused(
                    ErrorCode::HelmNotARelease,
                    &format!(
                        "its release is not a Helm release: what stands at line {line}, column {column} does not fit one"
                    ),
                ),
            }
        })?;
        let (said, said_revision) = read.identity();
        if said != name || said_revision != revision {
            return Err(self.refused(
                ErrorCode::HelmNotARelease,
                &format!(
                    "its labels name release {name} at revision {revision}, but its release is {said} at revision {said_revision}"
                ),
            ));
        }
        Ok(read)
    }
}

enum Failure {
    TooLarge,
    Truncated,
    Damaged,
}

/// Inflates `gzip`, its members one after another as Go's reader takes
/// them, into a buffer sized from its trailer, which holds the size of the
/// last member's input, and never grown past [`BOUND`] and one byte.
fn inflated(gzip: &[u8]) -> Result<Vec<u8>, Failure> {
    let limit = BOUND + 1;
    let trailer = gzip
        .last_chunk::<4>()
        .map_or(0, |size| u32::from_le_bytes(*size) as usize);
    let mut out = vec![0; trailer.min(limit)];
    let mut filled = 0;
    let mut reader = MultiGzDecoder::new(gzip).take(limit as u64);
    let mut probe = [0; 64];
    let read = |reader: &mut dyn Read, into: &mut [u8]| loop {
        match reader.read(into) {
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => {
                break Err(Failure::Truncated);
            }
            Err(_) => break Err(Failure::Damaged),
            Ok(read) => break Ok(read),
        }
    };
    loop {
        if filled < out.len() {
            match read(&mut reader, &mut out[filled..])? {
                0 => break,
                read => filled += read,
            }
            continue;
        }
        let read = read(&mut reader, &mut probe)?;
        if read == 0 {
            break;
        }
        let more = out.len().max(read).min(limit - filled);
        out.reserve_exact(more);
        out.resize(filled + more, 0);
        out[filled..filled + read].copy_from_slice(&probe[..read]);
        filled += read;
    }
    if filled > BOUND {
        return Err(Failure::TooLarge);
    }
    out.truncate(filled);
    Ok(out)
}

/// What a release says it is, which its labels must say too.
pub(crate) trait Revision {
    fn identity(&self) -> (&str, u32);
}

/// The fields of a release that its row reads; serde skips the rest, the
/// chart's templates and files among them, without keeping them.
#[derive(Deserialize)]
struct SummaryJson {
    #[serde(default)]
    name: String,
    #[serde(default)]
    namespace: String,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    info: Times,
    #[serde(default)]
    chart: Option<HeadChart>,
}

impl Revision for SummaryJson {
    fn identity(&self) -> (&str, u32) {
        (&self.name, self.version)
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct Times {
    #[serde(default, deserialize_with = "time")]
    pub first_deployed: Option<Timestamp>,
    #[serde(default, deserialize_with = "time")]
    pub last_deployed: Option<Timestamp>,
    #[serde(default)]
    pub status: String,
    /// Helm 4.3 and later.
    #[serde(default)]
    pub rollback_revision: u32,
}

#[derive(Deserialize)]
struct HeadChart {
    #[serde(default)]
    metadata: Option<Head>,
}

#[derive(Deserialize)]
struct Head {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default, rename = "appVersion")]
    app_version: String,
}

/// An absent, `null` or empty time is none: Helm 3 writes `""` for a time
/// not set, Helm 4 leaves it out.
fn time<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Timestamp>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        Some(text) if !text.is_empty() => text
            .parse()
            .map(Some)
            .map_err(|_| D::Error::custom("a time that is not RFC 3339")),
        _ => Ok(None),
    }
}

/// A revision as a list row or a history line shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    name: String,
    revision: u32,
    namespace: String,
    status: Status,
    first_deployed: Option<Timestamp>,
    last_deployed: Option<Timestamp>,
    rollback_revision: Option<u32>,
    chart: Option<ChartHead>,
}

/// The chart a revision was made from, as `helm list` names it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ChartHead {
    name: String,
    version: String,
    app_version: String,
}

impl Summary {
    pub(crate) fn of(
        name: String,
        revision: u32,
        namespace: String,
        times: Times,
        chart: Option<(String, String, String)>,
    ) -> Self {
        Summary {
            name,
            revision,
            namespace,
            status: Status::of(&times.status),
            first_deployed: times.first_deployed,
            last_deployed: times.last_deployed,
            rollback_revision: (times.rollback_revision > 0).then_some(times.rollback_revision),
            chart: chart.map(|(name, version, app_version)| ChartHead {
                name,
                version,
                app_version,
            }),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    /// Where its objects went, which can differ from its Secret's namespace,
    /// as Flux's `targetNamespace` makes it.
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    /// As the release stores it, which Helm prints where its label differs.
    pub fn status(&self) -> &Status {
        &self.status
    }

    /// `name-version`, as `helm list` prints it; None where the release
    /// stores no chart, which Helm prints as `MISSING`.
    pub fn chart(&self) -> Option<String> {
        self.chart
            .as_ref()
            .map(|chart| format!("{}-{}", chart.name, chart.version))
    }

    pub(crate) fn chart_version(&self) -> Option<&str> {
        self.chart.as_ref().map(|chart| chart.version.as_str())
    }

    pub fn app_version(&self) -> Option<&str> {
        self.chart.as_ref().map(|chart| chart.app_version.as_str())
    }

    pub fn first_deployed(&self) -> Option<Timestamp> {
        self.first_deployed
    }

    /// When the revision's operation started, which `helm list` prints as
    /// Updated.
    pub fn last_deployed(&self) -> Option<Timestamp> {
        self.last_deployed
    }

    /// The revision a rollback restored, as Helm 4.3 and later record it.
    pub fn rollback_revision(&self) -> Option<u32> {
        self.rollback_revision
    }
}

/// The revision `stored` holds, as its release's row shows it.
pub fn summary(stored: &Stored<'_>) -> Result<Summary, IpcError> {
    let json: SummaryJson = stored.read()?;
    let chart = json
        .chart
        .and_then(|chart| chart.metadata)
        .map(|head| (head.name, head.version, head.app_version));
    Ok(Summary::of(
        json.name,
        json.version,
        json.namespace,
        json.info,
        chart,
    ))
}

/// The fields of a release that its page reads.
#[derive(Deserialize)]
pub(crate) struct PageJson {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub namespace: String,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub info: PageInfo,
    #[serde(default)]
    pub chart: Option<PageChart>,
    /// Absent when the person set no values.
    #[serde(default)]
    pub config: Option<Box<RawValue>>,
    #[serde(default)]
    pub manifest: String,
    #[serde(default)]
    pub hooks: Vec<HookJson>,
    /// `ssa` or `csa`, Helm 4 and later; absent is client-side apply.
    #[serde(default)]
    pub apply_method: Option<String>,
}

impl Revision for PageJson {
    fn identity(&self) -> (&str, u32) {
        (&self.name, self.version)
    }
}

#[derive(Default, Deserialize)]
pub(crate) struct PageInfo {
    #[serde(flatten)]
    pub times: Times,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Deserialize)]
pub(crate) struct PageChart {
    #[serde(default)]
    pub metadata: Option<Metadata>,
    /// The chart's defaults, its subcharts' merged in at install.
    #[serde(default)]
    pub values: Option<Box<RawValue>>,
}

#[derive(Deserialize)]
pub(crate) struct Metadata {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default, rename = "appVersion")]
    pub app_version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub home: String,
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default, rename = "kubeVersion")]
    pub kube_version: String,
    #[serde(default)]
    pub deprecated: bool,
}

#[derive(Deserialize)]
pub(crate) struct HookJson {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub manifest: String,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub weight: i64,
    #[serde(default)]
    pub last_run: LastRun,
}

#[derive(Default, Deserialize)]
pub(crate) struct LastRun {
    /// Empty for a hook never run.
    #[serde(default)]
    pub phase: String,
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::GzEncoder;

    use super::*;

    fn member(write: impl FnOnce(&mut GzEncoder<Vec<u8>>)) -> Vec<u8> {
        let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
        write(&mut gzip);
        gzip.finish().unwrap()
    }

    #[test]
    fn a_trailer_that_says_too_little_never_grows_the_buffer_past_the_bound() {
        let spaces = vec![b' '; 1 << 20];
        let mut gzip = member(|gzip| {
            for _ in 0..31 {
                gzip.write_all(&spaces).unwrap();
            }
        });
        gzip.extend(member(|gzip| gzip.write_all(b"{}").unwrap()));
        let Ok(json) = inflated(&gzip) else {
            panic!("31 MiB is within the bound");
        };
        assert_eq!(json.len(), (31 << 20) + 2);
        assert!(json.capacity() <= BOUND + 1, "{}", json.capacity());
    }
}
