//! What a problem report hides of the log (ARCHITECTURE 4.10), in three
//! layers: a value that travels as a field of a fixed name, a name the
//! catalog and the state know where it stands in free text, and fixed
//! patterns for what no list knows.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::LazyLock;

use regex::Regex;
use twigo_ipc::Hidden;
use twigo_policy::redact::whole_tokens_replaced;

/// A name this short is aliased where a field carries it, not in free text,
/// where it would garble the words around it.
const SHORTEST_IN_TEXT: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Kind {
    Context,
    Cluster,
    Server,
    User,
    Namespace,
    Object,
}

impl Kind {
    /// What the log's field of that name carries; a space is its context.
    pub(super) fn of_field(name: &str) -> Option<Self> {
        Some(match name {
            "context" | "space" => Self::Context,
            "cluster" => Self::Cluster,
            "server" => Self::Server,
            "user" => Self::User,
            "namespace" => Self::Namespace,
            "object" => Self::Object,
            _ => return None,
        })
    }

    fn word(self) -> &'static str {
        match self {
            Self::Context => "context",
            Self::Cluster => "cluster",
            Self::Server => "server",
            Self::User => "user",
            Self::Namespace => "namespace",
            Self::Object => "object",
        }
    }
}

/// A name the catalog or the state knows, which stands for `canonical`: the
/// URL of a server is also its host and its host with the port.
pub(super) struct Name {
    pub text: String,
    pub kind: Kind,
    pub canonical: String,
}

/// What the report must hide by name, and from where the machine names the
/// person.
#[derive(Default)]
pub(super) struct Known {
    pub names: Vec<Name>,
    /// The home folders of the process and of the login shell.
    pub homes: Vec<String>,
    /// The account's name, as the environment and the home folder give it.
    pub accounts: Vec<String>,
}

#[derive(Default)]
struct Aliases {
    made: HashMap<(Kind, String), String>,
    counts: HashMap<Kind, usize>,
    used: u32,
}

impl Aliases {
    fn of(&mut self, kind: Kind, canonical: &str) -> String {
        self.used += 1;
        let counts = &mut self.counts;
        self.made
            .entry((kind, canonical.to_owned()))
            .or_insert_with(|| {
                let number = counts.entry(kind).or_default();
                *number += 1;
                format!("<{}-{number}>", kind.word())
            })
            .clone()
    }
}

pub(super) struct Redactor {
    /// What free text is searched for, and what each stands for.
    texts: Vec<String>,
    stand_for: Vec<(Kind, String)>,
    known: HashMap<String, (Kind, String)>,
    homes: Vec<String>,
    accounts: Vec<String>,
    aliases: Aliases,
    /// Accounts and emails, which are named by no alias.
    people: u32,
    hidden: Hidden,
}

impl Redactor {
    /// `learned` are the values the log's own fields carry, so that a name no
    /// list holds is hidden in free text too, as it is in its field.
    pub(super) fn new(known: Known, learned: impl IntoIterator<Item = (Kind, String)>) -> Self {
        let mut by_text = HashMap::new();
        let mut order = Vec::new();
        let named = known
            .names
            .into_iter()
            .map(|name| (name.text, name.kind, name.canonical))
            .chain(learned.into_iter().map(|(kind, value)| {
                let canonical = value.clone();
                (value, kind, canonical)
            }));
        for (text, kind, canonical) in named {
            if text.is_empty() || by_text.contains_key(&text) {
                continue;
            }
            by_text.insert(text.clone(), (kind, canonical));
            order.push(text);
        }
        let (texts, stand_for) = order
            .iter()
            .filter(|text| text.chars().count() >= SHORTEST_IN_TEXT)
            .map(|text| (text.clone(), by_text[text].clone()))
            .unzip();
        Self {
            texts,
            stand_for,
            known: by_text,
            homes: known.homes,
            accounts: known.accounts,
            aliases: Aliases::default(),
            people: 0,
            hidden: Hidden::default(),
        }
    }

    pub(super) fn hidden(&self) -> Hidden {
        Hidden {
            names: self.aliases.used + self.people,
            ..self.hidden
        }
    }

    /// The value of a field the log names for what it carries, as an alias,
    /// or as its kind for a path and a URL; none for any other field.
    pub(super) fn field(&mut self, name: &str, value: &str) -> Option<String> {
        if value.is_empty() {
            return None;
        }
        match name {
            "path" => {
                self.hidden.paths += 1;
                Some("<path>".to_owned())
            }
            "url" => {
                self.hidden.addresses += 1;
                Some("<url>".to_owned())
            }
            _ => {
                let kind = Kind::of_field(name)?;
                let canonical = match self.known.get(value) {
                    Some((known, canonical)) if *known == kind => canonical,
                    _ => value,
                };
                Some(self.aliases.of(kind, canonical))
            }
        }
    }

    pub(super) fn text(&mut self, text: &str) -> String {
        let (aliases, stand_for) = (&mut self.aliases, &self.stand_for);
        let text = whole_tokens_replaced(text, &self.texts, |index| {
            let (kind, canonical) = &stand_for[index];
            aliases.of(*kind, canonical)
        });
        let text = replaced(&JWT, &text, &mut self.hidden.tokens, |_| {
            Some(TOKEN.to_owned())
        });
        let text = replaced(&CREDENTIAL, &text, &mut self.hidden.tokens, |found| {
            looks_like_a_credential(&found[3]).then(|| format!("{}{}{TOKEN}", &found[1], &found[2]))
        });
        let text = replaced(&URL, &text, &mut self.hidden.addresses, |_| {
            Some("<url>".to_owned())
        });
        let text = replaced(&EMAIL, &text, &mut self.people, |_| {
            Some("<email>".to_owned())
        });
        let text = self.homes_hidden(&text);
        let text = self.accounts_hidden(&text);
        let text = self.addresses_hidden(&text);
        replaced(&QUOTED, &text, &mut self.hidden.quoted, |found| {
            (!only_aliases(&found[1])).then(|| "\"…\"".to_owned())
        })
    }

    fn homes_hidden(&mut self, text: &str) -> String {
        let paths = &mut self.hidden.paths;
        whole_tokens_replaced(text, &self.homes, |_| {
            *paths += 1;
            "~".to_owned()
        })
    }

    fn accounts_hidden(&mut self, text: &str) -> String {
        let people = &mut self.people;
        whole_tokens_replaced(text, &self.accounts, |_| {
            *people += 1;
            "<account>".to_owned()
        })
    }

    /// Addresses other than a loopback or an unspecified one, whether they
    /// stand bare, with a port, or in brackets; a letter, a digit or `_`
    /// beside one makes it part of a longer word, which stays.
    fn addresses_hidden(&mut self, text: &str) -> String {
        let mut hidden = String::with_capacity(text.len());
        let mut from = 0;
        for found in ADDRESS_LIKE.find_iter(text) {
            let mut candidate = found.as_str().trim_end_matches(['.', ':']);
            let mut start = found.start();
            if address(candidate).is_none() {
                // `addr:10.0.0.9:6443` reads `:10.0.0.9:6443`, since `add` is
                // hex; `::ffff:10.0.0.9` keeps its colons, as it parses.
                let trimmed = candidate.trim_start_matches(':');
                start += candidate.len() - trimmed.len();
                candidate = trimmed;
            }
            let end = start + candidate.len();
            let word = |c: char| c.is_alphanumeric() || c == '_';
            let alone = !text[..start].chars().next_back().is_some_and(word)
                && !text[end..].chars().next().is_some_and(word);
            if alone
                && address(candidate).is_some_and(|ip| !ip.is_loopback() && !ip.is_unspecified())
            {
                hidden.push_str(&text[from..start]);
                hidden.push_str("<address>");
                from = end;
                self.hidden.addresses += 1;
            }
        }
        hidden.push_str(&text[from..]);
        hidden
    }
}

const TOKEN: &str = "<token>";

static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?").expect("a pattern")
});

static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})").expect("a pattern")
});

static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"[A-Za-z][A-Za-z0-9+.-]*://[^\s"'<>]*[^\s"'<>.,;:!?)\]]"#).expect("a pattern")
});

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+").expect("a pattern")
});

/// What may be an IPv4 or IPv6 address, with a port or in brackets; only a
/// parse says that it is.
static ADDRESS_LIKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9A-Fa-f:.\[\]]{3,}").expect("a pattern"));

static QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)"((?:[^"\\]|\\.)*)""#).expect("a pattern"));

static ALIASES_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:<[a-z]+(?:-[0-9]+)?>|~)+$").expect("a pattern"));

/// A word after `Bearer` or `Basic` that is not an ordinary one: it has a
/// digit, a capital or a mark.
fn looks_like_a_credential(word: &str) -> bool {
    !word.bytes().all(|byte| byte.is_ascii_lowercase())
}

fn only_aliases(inside: &str) -> bool {
    ALIASES_ONLY.is_match(inside)
}

fn address(candidate: &str) -> Option<IpAddr> {
    candidate
        .parse::<SocketAddr>()
        .map(|socket| socket.ip())
        .or_else(|_| candidate.parse::<IpAddr>())
        .ok()
}

/// `text` with each match of `pattern` that `with` answers for replaced, and
/// `count` raised by one for each.
fn replaced(
    pattern: &Regex,
    text: &str,
    count: &mut u32,
    mut with: impl FnMut(&regex::Captures<'_>) -> Option<String>,
) -> String {
    pattern
        .replace_all(text, |found: &regex::Captures<'_>| {
            with(found)
                .inspect(|_| *count += 1)
                .unwrap_or_else(|| found[0].to_owned())
        })
        .into_owned()
}
