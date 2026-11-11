//! A kubeconfig's entries by name, and moving what tools wrote into a
//! terminal's own into the person's: appended under kubectl's lock and by a
//! rename, the file's comments and layout kept, their relative paths made
//! absolute.

use std::collections::{BTreeMap, BTreeSet, btree_map};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;

use kube::config::{Kubeconfig, KubeconfigError};
use yaml_edit::{Mapping, Sequence, YamlFile, yaml_eq};

use super::write::{Lock, WriteError, replace};

/// What a file that does not exist, or holds nothing, starts as.
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

    pub fn is_empty(&self) -> bool {
        self.clusters.is_empty() && self.users.is_empty() && self.contexts.is_empty()
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

/// What tools wrote into a terminal's own kubeconfig, as a move takes it:
/// each offered entry from the last read of the file that held it, so one
/// that a later write dropped, as gcloud drops all when it moves the file
/// to a backup, still moves as it was.
#[derive(Debug, Clone)]
pub struct Written {
    /// The file's directory, which its relative paths are against.
    base: PathBuf,
    /// Whether the person's files follow the file in the terminal's
    /// `KUBECONFIG`, as in a kubeconfig terminal, so a name it lacks is
    /// theirs there.
    chained: bool,
    /// The file as last read, for what its contexts name that is not
    /// offered.
    last: Arc<str>,
    clusters: BTreeMap<String, Arc<str>>,
    users: BTreeMap<String, Arc<str>>,
    contexts: BTreeMap<String, Arc<str>>,
}

impl Written {
    pub fn new(base: PathBuf, chained: bool) -> Self {
        Self {
            base,
            chained,
            last: "".into(),
            clusters: BTreeMap::new(),
            users: BTreeMap::new(),
            contexts: BTreeMap::new(),
        }
    }

    /// Takes `text`, a read of the file whose names are `holds`: the
    /// `fresh` among them join, and those that joined before are taken
    /// from it from now on.
    pub fn read(&mut self, text: &str, holds: &Names, fresh: &Names) {
        let text: Arc<str> = text.into();
        for ((_, entries), ((_, held), (_, new))) in self
            .sections_mut()
            .into_iter()
            .zip(holds.sections().into_iter().zip(fresh.sections()))
        {
            for name in held {
                if new.contains(name) || entries.contains_key(name) {
                    entries.insert(name.clone(), Arc::clone(&text));
                }
            }
        }
        self.last = text;
    }

    /// Drops `names`, as a move or a dismiss answered them.
    pub fn forget(&mut self, names: &Names) {
        for ((_, entries), (_, gone)) in self.sections_mut().into_iter().zip(names.sections()) {
            entries.retain(|name, _| !gone.contains(name));
        }
    }

    pub fn names(&self) -> Names {
        let names = |entries: &BTreeMap<String, Arc<str>>| entries.keys().cloned().collect();
        Names {
            clusters: names(&self.clusters),
            users: names(&self.users),
            contexts: names(&self.contexts),
        }
    }

    /// What a move would leave out against the person's `files` as they are
    /// now, in words a person reads as they are: `context prod`.
    pub fn left_out(&self, files: &[PathBuf]) -> Result<Vec<String>, WriteError> {
        let read: Vec<(&Path, String)> = files
            .iter()
            .filter_map(|file| Some((file.as_path(), fs::read_to_string(file).ok()?)))
            .collect();
        let theirs = Entries::of_files(read.iter().map(|(file, text)| (*file, text.as_str())));
        Ok(self.plan(&theirs)?.left)
    }

    /// Names match by section, as kubectl's do. A context moves only where
    /// what it names, the cluster and the user, either moves with it or is,
    /// in the person's files, the entry the terminal saw, so it means there
    /// what it meant in the terminal; a cluster or a user moves where its
    /// name is free, unless only contexts that stay out name it.
    fn plan(&self, theirs: &Entries) -> Result<Plan, WriteError> {
        let offered = self.offered()?;
        let mut last = Entries::default();
        if let Some(config) = mapping(&parse(&self.last)?) {
            last.add(&config, &self.base);
        }
        let free = |section: &str| -> BTreeSet<&String> {
            let theirs = theirs.section(section);
            offered
                .section(section)
                .keys()
                .filter(|name| !theirs.contains_key(*name))
                .collect()
        };
        let free_clusters = free("clusters");
        let free_users = free("users");
        let seen = |section: &str, name: &str| {
            offered
                .section(section)
                .get(name)
                .or_else(|| last.section(section).get(name))
                .or_else(|| {
                    self.chained
                        .then(|| theirs.section(section).get(name))
                        .flatten()
                })
        };
        let holds = |section: &str, free: &BTreeSet<&String>, name: &Option<String>| {
            let Some(name) = name.as_deref().filter(|name| !name.is_empty()) else {
                return true;
            };
            free.iter().any(|free| *free == name)
                || matches!(
                    (theirs.section(section).get(name), seen(section, name)),
                    (Some(theirs), Some(seen)) if yaml_eq(theirs, seen)
                )
        };
        let contexts: Vec<Naming> = offered
            .contexts
            .iter()
            .map(|(name, entry)| {
                let (cluster, user) = (named(entry, "cluster"), named(entry, "user"));
                let moves = !theirs.contexts.contains_key(name)
                    && holds("clusters", &free_clusters, &cluster)
                    && holds("users", &free_users, &user);
                Naming {
                    name,
                    moves,
                    cluster,
                    user,
                }
            })
            .collect();
        let mut plan = Plan::default();
        for context in &contexts {
            if context.moves {
                let entry = offered.contexts[context.name].clone();
                plan.moving.push(("contexts", entry));
            } else {
                plan.left.push(format!("context {}", context.name));
            }
        }
        for (section, word, free) in [
            ("clusters", "cluster", &free_clusters),
            ("users", "user", &free_users),
        ] {
            for (name, entry) in offered.section(section) {
                let naming: Vec<bool> = contexts
                    .iter()
                    .filter(|context| context.names(section) == Some(name))
                    .map(|context| context.moves)
                    .collect();
                if free.contains(name) && (naming.is_empty() || naming.contains(&true)) {
                    plan.moving.push((section, entry.clone()));
                } else {
                    plan.left.push(format!("{word} {name}"));
                }
            }
        }
        Ok(plan)
    }

    /// The offered entries, as last seen, against the file's directory.
    fn offered(&self) -> Result<Entries, WriteError> {
        let mut read: Vec<(Arc<str>, Mapping)> = Vec::new();
        let mut offered = Entries::default();
        for (section, entries) in self.sections() {
            for (name, text) in entries {
                let from = match read.iter().find(|(seen, _)| Arc::ptr_eq(seen, text)) {
                    Some((_, from)) => from.clone(),
                    None => {
                        let from = mapping(&parse(text)?)
                            .ok_or_else(|| WriteError::Parse("it holds no mapping".to_owned()))?;
                        read.push((Arc::clone(text), from.clone()));
                        from
                    }
                };
                if let Some(entry) = entry(&from, section, name) {
                    absolute(&entry, section, &self.base);
                    offered.section_mut(section).insert(name.clone(), entry);
                }
            }
        }
        Ok(offered)
    }

    fn sections(&self) -> [(&'static str, &BTreeMap<String, Arc<str>>); 3] {
        [
            ("clusters", &self.clusters),
            ("users", &self.users),
            ("contexts", &self.contexts),
        ]
    }

    fn sections_mut(&mut self) -> [(&'static str, &mut BTreeMap<String, Arc<str>>); 3] {
        [
            ("clusters", &mut self.clusters),
            ("users", &mut self.users),
            ("contexts", &mut self.contexts),
        ]
    }
}

/// An offered context, and whether it moves.
struct Naming<'a> {
    name: &'a String,
    moves: bool,
    cluster: Option<String>,
    user: Option<String>,
}

impl Naming<'_> {
    /// The cluster or the user it names.
    fn names(&self, section: &str) -> Option<&String> {
        if section == "clusters" {
            self.cluster.as_ref()
        } else {
            self.user.as_ref()
        }
    }
}

/// What a move appends, and what it leaves out in words.
#[derive(Default)]
struct Plan {
    moving: Vec<(&'static str, Mapping)>,
    left: Vec<String>,
}

/// Entries by section and name, each against its file's directory.
#[derive(Default)]
struct Entries {
    clusters: BTreeMap<String, Mapping>,
    users: BTreeMap<String, Mapping>,
    contexts: BTreeMap<String, Mapping>,
}

impl Entries {
    /// Those of the files, in their order, as kubectl merges them: the first
    /// file to name an entry wins. One that does not parse is skipped.
    fn of_files<'a>(files: impl IntoIterator<Item = (&'a Path, &'a str)>) -> Self {
        let mut entries = Self::default();
        for (file, text) in files {
            if let Some(config) = parse(text).ok().as_ref().and_then(mapping) {
                entries.add(&config, file.parent().unwrap_or(Path::new("")));
            }
        }
        entries
    }

    /// The entries of `config` whose names it lacks.
    fn add(&mut self, config: &Mapping, base: &Path) {
        for section in ["clusters", "users", "contexts"] {
            let Some(list) = config.get_sequence(section) else {
                continue;
            };
            for entry in list.values().filter_map(|node| node.as_mapping().cloned()) {
                let Some(name) = name(&entry) else { continue };
                if let btree_map::Entry::Vacant(vacant) = self.section_mut(section).entry(name) {
                    absolute(&entry, section, base);
                    vacant.insert(entry);
                }
            }
        }
    }

    fn section(&self, section: &str) -> &BTreeMap<String, Mapping> {
        match section {
            "clusters" => &self.clusters,
            "users" => &self.users,
            _ => &self.contexts,
        }
    }

    fn section_mut(&mut self, section: &str) -> &mut BTreeMap<String, Mapping> {
        match section {
            "clusters" => &mut self.clusters,
            "users" => &mut self.users,
            _ => &mut self.contexts,
        }
    }
}

/// What a context names under `key`: its cluster or its user.
fn named(context: &Mapping, key: &str) -> Option<String> {
    Some(
        context
            .get_mapping("context")?
            .get(key)?
            .as_scalar()?
            .as_string(),
    )
}

/// Appends to `target` what `written` offers and a move takes against the
/// person's `files`, `target` among them, as they are under its lock, so a
/// name written into it meanwhile is not written twice, which client-go
/// refuses. A `target` that does not exist is created at 0600, as kubectl
/// creates one, in a directory created as kubectl's lock creates it.
pub fn append(target: &Path, files: &[PathBuf], written: &Written) -> Result<(), WriteError> {
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    let _lock = Lock::take(target)?;
    // Written in place of the file a symlink names, as kubectl's write
    // through the link reaches it.
    let (resolved, text) = match fs::canonicalize(target) {
        Ok(resolved) => {
            let text = fs::read_to_string(&resolved)?;
            (resolved, text)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            (target.to_owned(), EMPTY.to_owned())
        }
        Err(error) => return Err(error.into()),
    };
    let read: Vec<(&Path, String)> = files
        .iter()
        .filter_map(|file| {
            if file == target {
                return Some((file.as_path(), text.clone()));
            }
            Some((file.as_path(), fs::read_to_string(file).ok()?))
        })
        .collect();
    let theirs = Entries::of_files(read.iter().map(|(file, text)| (*file, text.as_str())));
    let plan = written.plan(&theirs)?;
    if plan.moving.is_empty() {
        return Ok(());
    }
    let mut file = parse(&text)?;
    if mapping(&file).is_none() && Names::of(&text).is_ok_and(|names| names.is_empty()) {
        // Whitespace and comments alone, which kubectl reads as an empty
        // config.
        let separator = if text.is_empty() || text.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        file = parse(&format!("{text}{separator}{EMPTY}"))?;
    }
    let into = mapping(&file).ok_or_else(|| WriteError::Parse("it holds no mapping".to_owned()))?;
    for (section, entry) in plan.moving {
        sequence(&into, section).push(entry);
    }
    replace(&resolved, &file.to_string())
}

fn parse(text: &str) -> Result<YamlFile, WriteError> {
    YamlFile::from_str(text).map_err(|error| WriteError::Parse(error.to_string()))
}

fn mapping(file: &YamlFile) -> Option<Mapping> {
    file.document()?.as_mapping()
}

/// The entry of `config`'s `section` named `name`, the first by that name.
fn entry(config: &Mapping, section: &str, name: &str) -> Option<Mapping> {
    config
        .get_sequence(section)?
        .values()
        .filter_map(|node| node.as_mapping().cloned())
        .find(|entry| self::name(entry).as_deref() == Some(name))
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

    fn written(base: &Path, names: &Names) -> Written {
        let mut written = Written::new(base.to_owned(), true);
        written.read(WRITTEN, &Names::of(WRITTEN).unwrap(), names);
        written
    }

    fn offered(text: &str, base: &Path, chained: bool) -> Written {
        let names = Names::of(text).unwrap();
        let mut written = Written::new(base.to_owned(), chained);
        written.read(text, &names, &names);
        written
    }

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
        let moving = names(&[ARN], &[ARN, "plugin"], &[ARN]);
        append(
            &target,
            std::slice::from_ref(&target),
            &written(base, &moving),
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
        let moving = names(&["other"], &[], &[]);
        append(
            &target,
            std::slice::from_ref(&target),
            &written(dir.path(), &moving),
        )
        .unwrap();
        let written = fs::read_to_string(&target).unwrap();
        assert_eq!(
            written,
            "apiVersion: v1\nkind: Config\nclusters:\n  - cluster:\n      server: https://other.example\n    name: other\nusers: []\ncontexts: []\n"
        );
        let mode = fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_target_kubectl_reads_as_empty_starts_as_the_empty_config_with_its_comments() {
        for empty in ["", "\n", "# nothing yet\n", "# nothing yet", "---\n"] {
            let dir = tempfile::tempdir().unwrap();
            let target = dir.path().join("config");
            fs::write(&target, empty).unwrap();
            let moving = names(&["other"], &[], &[]);
            append(
                &target,
                std::slice::from_ref(&target),
                &written(dir.path(), &moving),
            )
            .unwrap();
            let written = fs::read_to_string(&target).unwrap();
            assert!(written.starts_with(empty.trim_end()), "{written:?}");
            assert_eq!(
                Names::of(&written).unwrap(),
                names(&["other"], &[], &[]),
                "{written:?}"
            );
        }
    }

    #[test]
    fn names_match_by_section() {
        let dir = tempfile::tempdir().unwrap();
        let mine = dir.path().join("config");
        fs::write(
            &mine,
            "clusters:\n- name: prod\n  cluster:\n    server: https://a\n",
        )
        .unwrap();
        let written = offered(
            "clusters:\n- name: eks\n  cluster:\n    server: https://eks\nusers:\n- name: eks\n  user:\n    token: t\ncontexts:\n- name: prod\n  context:\n    cluster: eks\n    user: eks\n",
            Path::new("/terminal"),
            true,
        );
        assert!(
            written
                .left_out(std::slice::from_ref(&mine))
                .unwrap()
                .is_empty()
        );
        append(&mine, std::slice::from_ref(&mine), &written).unwrap();
        assert_eq!(
            Names::of(&fs::read_to_string(&mine).unwrap()).unwrap(),
            names(&["eks", "prod"], &["eks"], &["prod"])
        );
    }

    #[test]
    fn a_context_moves_only_where_the_person_s_entries_it_names_are_those_the_terminal_saw() {
        let dir = tempfile::tempdir().unwrap();
        let (home, terminal) = (dir.path().join("home"), dir.path().join("terminal"));
        fs::create_dir_all(&home).unwrap();
        let mine = home.join("config");
        fs::write(
            &mine,
            "clusters:
- name: same
  cluster:
    server: https://same
    insecure-skip-tls-verify: true
- name: elsewhere
  cluster:
    server: https://elsewhere
    certificate-authority: ca.pem
- name: home-ca
  cluster:
    server: https://home
    certificate-authority: ca.pem
users:
- name: me
  user:
    token: t
",
        )
        .unwrap();
        let text = &format!(
            "clusters:
- cluster:
    insecure-skip-tls-verify: true
    server: 'https://same'
  name: same
- name: elsewhere
  cluster:
    server: https://elsewhere
    certificate-authority: ca.pem
- name: home-ca
  cluster:
    server: https://home
    certificate-authority: {}
users:
- name: only-b
  user:
    token: b
contexts:
- name: a
  context:
    cluster: same
    user: me
- name: b
  context:
    cluster: elsewhere
    user: only-b
- name: c
  context:
    cluster: home-ca
    user: me
",
            home.join("ca.pem").display()
        );
        let written = offered(text, &terminal, true);
        assert_eq!(
            written.left_out(std::slice::from_ref(&mine)).unwrap(),
            [
                "context b",
                "cluster elsewhere",
                "cluster home-ca",
                "cluster same",
                "user only-b"
            ]
        );
        let proxied = offered(text, &terminal, false);
        assert_eq!(
            proxied.left_out(std::slice::from_ref(&mine)).unwrap(),
            [
                "context a",
                "context b",
                "context c",
                "cluster elsewhere",
                "cluster home-ca",
                "cluster same",
                "user only-b"
            ]
        );
        append(&mine, std::slice::from_ref(&mine), &written).unwrap();
        assert_eq!(
            Names::of(&fs::read_to_string(&mine).unwrap()).unwrap(),
            names(&["elsewhere", "home-ca", "same"], &["me"], &["a", "c"])
        );
    }

    #[test]
    fn a_name_written_into_the_target_after_the_offer_is_not_appended_twice() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config");
        let moving = names(&["other"], &[], &[]);
        let written = written(dir.path(), &moving);
        assert!(
            written
                .left_out(std::slice::from_ref(&target))
                .unwrap()
                .is_empty()
        );
        fs::write(
            &target,
            "clusters:\n- name: other\n  cluster:\n    server: https://meanwhile\n",
        )
        .unwrap();
        append(&target, std::slice::from_ref(&target), &written).unwrap();
        let text = fs::read_to_string(&target).unwrap();
        assert_eq!(text.matches("name: other").count(), 1, "{text}");
    }

    #[test]
    fn a_lock_another_writer_holds_refuses_the_write_and_stays() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config");
        fs::write(&target, "apiVersion: v1\n").unwrap();
        fs::write(dir.path().join("config.lock"), "").unwrap();
        let moving = names(&["other"], &[], &[]);
        let refused = append(
            &target,
            std::slice::from_ref(&target),
            &written(dir.path(), &moving),
        );
        assert!(matches!(refused, Err(WriteError::Locked(_))), "{refused:?}");
        assert!(dir.path().join("config.lock").exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "apiVersion: v1\n");
    }
}
