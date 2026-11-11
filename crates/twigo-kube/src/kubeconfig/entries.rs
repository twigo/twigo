//! A kubeconfig's entries by name, and moving some into another file as a
//! person's own: appended under kubectl's lock and by a rename, the file's
//! comments and layout kept, their relative paths made absolute.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use kube::config::{Kubeconfig, KubeconfigError};
use yaml_edit::{Mapping, Sequence, YamlFile};

use super::write::{Lock, WriteError, replace};

/// What a file that does not exist starts as.
const EMPTY: &str = "apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts: []\n";

/// The names of a kubeconfig's clusters, users and contexts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Names {
    pub clusters: BTreeSet<String>,
    pub users: BTreeSet<String>,
    pub contexts: BTreeSet<String>,
}

impl Names {
    /// Those of a kubeconfig's text, refused where it does not parse.
    pub fn of(text: &str) -> Result<Self, KubeconfigError> {
        let config = Kubeconfig::from_yaml(text)?;
        Ok(Self {
            clusters: config
                .clusters
                .into_iter()
                .map(|named| named.name)
                .collect(),
            users: config
                .auth_infos
                .into_iter()
                .map(|named| named.name)
                .collect(),
            contexts: config
                .contexts
                .into_iter()
                .map(|named| named.name)
                .collect(),
        })
    }

    /// Those of each of `files` that exists and parses.
    pub fn of_files(files: &[PathBuf]) -> Self {
        let mut names = Self::default();
        for file in files {
            let Ok(text) = fs::read_to_string(file) else {
                continue;
            };
            if let Ok(read) = Self::of(&text) {
                names.clusters.extend(read.clusters);
                names.users.extend(read.users);
                names.contexts.extend(read.contexts);
            }
        }
        names
    }

    pub fn is_empty(&self) -> bool {
        self.clusters.is_empty() && self.users.is_empty() && self.contexts.is_empty()
    }

    /// Every name, whatever its section.
    pub fn all(&self) -> BTreeSet<&str> {
        self.sections()
            .into_iter()
            .flat_map(|(_, names)| names.iter().map(String::as_str))
            .collect()
    }

    /// Those that `other` does not hold, section by section.
    pub fn without(&self, other: &Self) -> Self {
        let less = |mine: &BTreeSet<String>, theirs: &BTreeSet<String>| {
            mine.difference(theirs).cloned().collect()
        };
        Self {
            clusters: less(&self.clusters, &other.clusters),
            users: less(&self.users, &other.users),
            contexts: less(&self.contexts, &other.contexts),
        }
    }

    /// Those not among `names`, whatever their section.
    pub fn without_any(&self, names: &BTreeSet<&str>) -> Self {
        let keep = |mine: &BTreeSet<String>| {
            mine.iter()
                .filter(|name| !names.contains(name.as_str()))
                .cloned()
                .collect()
        };
        Self {
            clusters: keep(&self.clusters),
            users: keep(&self.users),
            contexts: keep(&self.contexts),
        }
    }

    pub fn extend(&mut self, other: Self) {
        self.clusters.extend(other.clusters);
        self.users.extend(other.users);
        self.contexts.extend(other.contexts);
    }

    fn sections(&self) -> [(&'static str, &BTreeSet<String>); 3] {
        [
            ("clusters", &self.clusters),
            ("users", &self.users),
            ("contexts", &self.contexts),
        ]
    }
}

/// Appends to `target` the entries of `source`, a kubeconfig's text whose
/// relative paths are against `base`, that `names` names, as they stand
/// there. A `target` that does not exist is created at 0600, as kubectl
/// creates one, in a directory created as kubectl's lock creates it.
pub fn append(target: &Path, source: &str, base: &Path, names: &Names) -> Result<(), WriteError> {
    let parse =
        |text: &str| YamlFile::from_str(text).map_err(|error| WriteError::Parse(error.to_string()));
    let source = parse(source)?;
    let from = source
        .document()
        .and_then(|document| document.as_mapping())
        .ok_or_else(|| WriteError::Parse("it holds no mapping".to_owned()))?;
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let _lock = Lock::take(target)?;
    // Written in place of the file a symlink names, as kubectl's write
    // through the link reaches it.
    let (target, text) = match fs::canonicalize(target) {
        Ok(resolved) => {
            let text = fs::read_to_string(&resolved)?;
            (resolved, text)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            (target.to_owned(), EMPTY.to_owned())
        }
        Err(error) => return Err(error.into()),
    };
    let file = parse(&text)?;
    let into = file
        .document()
        .and_then(|document| document.as_mapping())
        .ok_or_else(|| WriteError::Parse("it holds no mapping".to_owned()))?;
    for (section, wanted) in names.sections() {
        let entries: Vec<Mapping> = from
            .get_sequence(section)
            .into_iter()
            .flat_map(|entries| entries.values().collect::<Vec<_>>())
            .filter_map(|node| node.as_mapping().cloned())
            .filter(|entry| name(entry).is_some_and(|name| wanted.contains(&name)))
            .collect();
        if entries.is_empty() {
            continue;
        }
        let list = sequence(&into, section);
        for entry in entries {
            absolute(&entry, section, base);
            list.push(entry);
        }
    }
    replace(&target, &file.to_string())
}

/// The section's list: a block one in place of an empty `[]`, as a new file
/// holds, or of a `null`, as kubectl writes an empty one.
fn sequence(config: &Mapping, section: &str) -> Sequence {
    match config.get_sequence(section) {
        Some(list) if !(list.is_flow_style() && list.is_empty()) => list,
        _ => {
            config.set(section, Sequence::new());
            config.get_sequence(section).expect("just set")
        }
    }
}

fn name(entry: &Mapping) -> Option<String> {
    Some(entry.get("name")?.as_scalar()?.as_string())
}

/// The paths client-go reads relative to the entry's file
/// ([`GetClusterFileReferences`], [`GetAuthInfoFileReferences`]), against
/// `base`, as client-go makes them absolute: an exec command only where it
/// names a directory, else it is looked up on `PATH`.
///
/// [`GetClusterFileReferences`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/loader.go#L606-L608
/// [`GetAuthInfoFileReferences`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/tools/clientcmd/loader.go#L610-L617
fn absolute(entry: &Mapping, section: &str, base: &Path) {
    let resolve = |mapping: &Mapping, key: &str, only_with_dir: bool| {
        let Some(path) = mapping
            .get(key)
            .and_then(|node| Some(node.as_scalar()?.as_string()))
        else {
            return;
        };
        if path.is_empty()
            || Path::new(&path).is_absolute()
            || (only_with_dir && !path.contains(std::path::MAIN_SEPARATOR))
        {
            return;
        }
        mapping.set(key, base.join(&path).display().to_string().as_str());
    };
    match section {
        "clusters" => {
            if let Some(cluster) = entry.get_mapping("cluster") {
                resolve(&cluster, "certificate-authority", false);
            }
        }
        "users" => {
            if let Some(user) = entry.get_mapping("user") {
                for key in ["client-certificate", "client-key", "tokenFile"] {
                    resolve(&user, key, false);
                }
                if let Some(exec) = user.get_mapping("exec") {
                    resolve(&exec, "command", true);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WRITTEN: &str = "apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://eks.example
    certificate-authority: certs/ca.pem
  name: arn:aws:eks:eu-west-1:1:cluster/a
- cluster:
    server: https://other.example
  name: other
users:
- name: arn:aws:eks:eu-west-1:1:cluster/a
  user:
    client-certificate: /etc/client.pem
    client-key: keys/key.pem
    tokenFile: token
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args:
      - eks
      - get-token
- name: plugin
  user:
    exec:
      command: bin/plugin
contexts:
- context:
    cluster: arn:aws:eks:eu-west-1:1:cluster/a
    user: arn:aws:eks:eu-west-1:1:cluster/a
  name: arn:aws:eks:eu-west-1:1:cluster/a
current-context: arn:aws:eks:eu-west-1:1:cluster/a
";

    const ARN: &str = "arn:aws:eks:eu-west-1:1:cluster/a";

    fn names(clusters: &[&str], users: &[&str], contexts: &[&str]) -> Names {
        let set = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect();
        Names {
            clusters: set(clusters),
            users: set(users),
            contexts: set(contexts),
        }
    }

    #[test]
    fn names_come_by_section_and_a_text_that_does_not_parse_has_none() {
        assert_eq!(
            Names::of(WRITTEN).unwrap(),
            names(&[ARN, "other"], &[ARN, "plugin"], &[ARN])
        );
        assert_eq!(Names::of("").unwrap(), Names::default());
        assert!(Names::of("clusters:\n- name: a\n  cluster: [").is_err());
    }

    #[test]
    fn entries_go_to_the_end_of_their_lists_with_comments_and_layout_kept() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config");
        let mine = "# mine\napiVersion: v1\nclusters:\n# kind\n- cluster:\n    server: https://127.0.0.1:6443\n  name: kind-a\ncontexts:\n- context:\n    cluster: kind-a\n    user: kind-a\n  name: kind-a\ncurrent-context: kind-a\nkind: Config\nusers: null\n";
        fs::write(&target, mine).unwrap();
        let base = Path::new("/twigo/terminals/1");
        append(
            &target,
            WRITTEN,
            base,
            &names(&[ARN], &[ARN, "plugin"], &[ARN]),
        )
        .unwrap();
        let written = fs::read_to_string(&target).unwrap();
        assert!(written.starts_with("# mine\napiVersion: v1\nclusters:\n# kind\n- cluster:\n    server: https://127.0.0.1:6443\n  name: kind-a\n- cluster:\n"), "{written}");
        assert!(written.contains("current-context: kind-a\n"), "{written}");
        let read = Kubeconfig::from_yaml(&written).unwrap();
        assert_eq!(
            Names::of(&written).unwrap(),
            names(&["kind-a", ARN], &[ARN, "plugin"], &["kind-a", ARN])
        );
        let cluster = read.clusters.iter().find(|c| c.name == ARN).unwrap();
        let cluster = cluster.cluster.as_ref().unwrap();
        assert_eq!(
            cluster.certificate_authority.as_deref(),
            Some("/twigo/terminals/1/certs/ca.pem")
        );
        let user = read.auth_infos.iter().find(|u| u.name == ARN).unwrap();
        let user = user.auth_info.as_ref().unwrap();
        assert_eq!(user.client_certificate.as_deref(), Some("/etc/client.pem"));
        assert_eq!(
            user.client_key.as_deref(),
            Some("/twigo/terminals/1/keys/key.pem")
        );
        assert_eq!(user.token_file.as_deref(), Some("/twigo/terminals/1/token"));
        assert_eq!(user.exec.as_ref().unwrap().command.as_deref(), Some("aws"));
        let plugin = read.auth_infos.iter().find(|u| u.name == "plugin").unwrap();
        let plugin = plugin.auth_info.as_ref().unwrap().exec.as_ref().unwrap();
        assert_eq!(
            plugin.command.as_deref(),
            Some("/twigo/terminals/1/bin/plugin")
        );
        assert!(!dir.path().join("config.lock").exists());
    }

    #[test]
    fn a_target_that_does_not_exist_is_created_at_0600_in_block_lists() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".kube").join("config");
        append(&target, WRITTEN, dir.path(), &names(&["other"], &[], &[])).unwrap();
        let written = fs::read_to_string(&target).unwrap();
        assert_eq!(
            written,
            "apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://other.example\n    name: other\nusers: []\ncontexts: []\n"
        );
        let mode = fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_lock_another_writer_holds_refuses_the_write_and_stays() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config");
        fs::write(&target, "apiVersion: v1\n").unwrap();
        fs::write(dir.path().join("config.lock"), "").unwrap();
        let refused = append(&target, WRITTEN, dir.path(), &names(&["other"], &[], &[]));
        assert!(matches!(refused, Err(WriteError::Locked(_))), "{refused:?}");
        assert!(dir.path().join("config.lock").exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "apiVersion: v1\n");
    }
}
