//! What the command bus plans (ARCHITECTURE 5.1, 6.4): each action finds
//! what it acts on, says what it will do and what it risks, and holds its
//! run.

mod delete;
mod reveal;

pub(crate) use delete::delete;
pub(crate) use reveal::reveal;

use twigo_ipc::{ErrorKind, IpcError};

/// A kind as a sentence names it: `pod`, `stateful set`, `API service`.
pub(crate) fn kind_words(kind: &str) -> String {
    let chars: Vec<char> = kind.chars().collect();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    for (index, &c) in chars.iter().enumerate() {
        let starts = index > 0
            && c.is_uppercase()
            && (chars[index - 1].is_lowercase()
                || chars.get(index + 1).is_some_and(|next| next.is_lowercase()));
        if starts && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        word.push(c);
    }
    words.push(word);
    words
        .into_iter()
        .map(|word| {
            let acronym = word.chars().count() > 1 && word.chars().all(|c| !c.is_lowercase());
            if acronym { word } else { word.to_lowercase() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text` with its first letter in capitals, to start a sentence.
pub(crate) fn sentence(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().chain(chars).collect()
    })
}

/// A kubectl command line, each word quoted as a POSIX shell reads it.
pub(crate) fn kubectl(words: &[&str]) -> Result<String, IpcError> {
    shlex::try_join(words.iter().copied()).map_err(|error| {
        IpcError::new(
            ErrorKind::InvalidInput,
            format!("no shell can take these words: {error}"),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kind_reads_as_words_and_keeps_its_acronyms() {
        for (kind, words) in [
            ("Pod", "pod"),
            ("StatefulSet", "stateful set"),
            ("PersistentVolumeClaim", "persistent volume claim"),
            ("APIService", "API service"),
            ("CSIDriver", "CSI driver"),
            ("IPAddress", "IP address"),
            ("Ec2NodeClass", "ec2 node class"),
        ] {
            assert_eq!(kind_words(kind), words, "{kind}");
        }
    }

    #[test]
    fn a_kubectl_line_quotes_only_what_a_shell_would_split() {
        assert_eq!(
            kubectl(&["kubectl", "--context", "kind-a", "delete", "pods", "web-1"]).unwrap(),
            "kubectl --context kind-a delete pods web-1"
        );
        assert_eq!(
            kubectl(&[
                "kubectl",
                "--context",
                "my cluster",
                "-o",
                "go-template={{.x}}"
            ])
            .unwrap(),
            "kubectl --context 'my cluster' -o 'go-template={{.x}}'"
        );
    }
}
