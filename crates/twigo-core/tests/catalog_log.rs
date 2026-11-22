//! What the catalog logs of a file that fails, in a test binary of its own:
//! a scoped subscriber hears a callsite that another test's thread registered
//! first only some of the time.

use std::fs;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Level, Metadata, Subscriber};
use twigo_core::catalog::Catalog;
use twigo_kube::kubeconfig::Sources;

#[derive(Clone, Default)]
struct Heard(Arc<Mutex<Vec<(Level, String, String)>>>);

#[derive(Default)]
struct Fields {
    code: String,
    path: String,
}

impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "code" => self.code = format!("{value:?}"),
            "path" => self.path = format!("{value:?}"),
            _ => {}
        }
    }
}

impl Subscriber for Heard {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        self.0
            .lock()
            .unwrap()
            .push((*event.metadata().level(), fields.code, fields.path));
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
}

#[test]
fn a_failing_file_is_logged_when_its_failure_starts_and_ends_and_not_at_each_read() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config");
    fs::write(&file, "contexts: [unclosed").unwrap();
    let sources = Sources::explicit(file.clone());
    let catalog = Catalog::default();
    let heard = Heard::default();
    tracing::subscriber::with_default(heard.clone(), || {
        catalog.follow(sources.clone());
        catalog.follow(sources.clone());
        catalog.follow(sources.clone());
        fs::write(&file, "contexts: []").unwrap();
        catalog.follow(sources.clone());
    });
    let (code, path) = ("kubeconfig.unparsable", file.display().to_string());
    assert_eq!(
        *heard.0.lock().unwrap(),
        [
            (Level::WARN, code.to_owned(), path.clone()),
            (Level::INFO, code.to_owned(), path),
        ]
    );
}

#[test]
fn a_failure_that_changes_is_one_warning_and_the_file_ends_once_nothing_fails() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("config");
    fs::write(&file, "contexts: [unclosed").unwrap();
    let sources = Sources::explicit(file.clone());
    let catalog = Catalog::default();
    let heard = Heard::default();
    tracing::subscriber::with_default(heard.clone(), || {
        catalog.follow(sources.clone());
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        catalog.follow(sources.clone());
        fs::remove_dir(&file).unwrap();
        fs::write(&file, "contexts: []").unwrap();
        catalog.follow(sources.clone());
    });
    let path = file.display().to_string();
    assert_eq!(
        *heard.0.lock().unwrap(),
        [
            (
                Level::WARN,
                "kubeconfig.unparsable".to_owned(),
                path.clone()
            ),
            (
                Level::WARN,
                "kubeconfig.unreadable".to_owned(),
                path.clone()
            ),
            (Level::INFO, "kubeconfig.unreadable".to_owned(), path),
        ]
    );
}
