/// A revision's status, as Helm words it
/// ([status.go](https://github.com/helm/helm/blob/v4.3.2/pkg/release/common/status.go#L25-L49),
/// the same words since v3.0.0).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Unknown,
    Deployed,
    Uninstalled,
    Superseded,
    Failed,
    Uninstalling,
    PendingInstall,
    PendingUpgrade,
    PendingRollback,
    /// A word Helm does not know, kept as it is.
    Other(String),
}

/// Each status Helm knows, its word, and for a pending one the operation
/// it waits on.
static KNOWN: [(Status, &str, Option<&str>); 9] = [
    (Status::Unknown, "unknown", None),
    (Status::Deployed, "deployed", None),
    (Status::Uninstalled, "uninstalled", None),
    (Status::Superseded, "superseded", None),
    (Status::Failed, "failed", None),
    (Status::Uninstalling, "uninstalling", None),
    (Status::PendingInstall, "pending-install", Some("install")),
    (Status::PendingUpgrade, "pending-upgrade", Some("upgrade")),
    (
        Status::PendingRollback,
        "pending-rollback",
        Some("rollback"),
    ),
];

impl Status {
    pub fn of(word: &str) -> Self {
        KNOWN
            .iter()
            .find(|(_, known, _)| *known == word)
            .map_or_else(
                || Status::Other(word.to_owned()),
                |(status, ..)| status.clone(),
            )
    }

    /// Helm's word for it.
    pub fn word(&self) -> &str {
        match self {
            Status::Other(word) => word,
            _ => self.known().map_or("", |(_, word, _)| word),
        }
    }

    /// The operation a pending status waits on: `install`, `upgrade` or
    /// `rollback`.
    pub fn pending(&self) -> Option<&'static str> {
        self.known().and_then(|(_, _, operation)| *operation)
    }

    fn known(&self) -> Option<&'static (Status, &'static str, Option<&'static str>)> {
        KNOWN.iter().find(|(status, ..)| status == self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_helm_does_not_know_is_kept() {
        for word in ["deployed", "pending-upgrade", "unknown"] {
            assert_eq!(Status::of(word).word(), word);
        }
        assert_eq!(Status::of("pending-upgrade").pending(), Some("upgrade"));
        assert_eq!(Status::of("superseded").pending(), None);
        let other = Status::of("paused-by-a-tool");
        assert_eq!(other, Status::Other("paused-by-a-tool".to_owned()));
        assert_eq!(other.word(), "paused-by-a-tool");
    }
}
