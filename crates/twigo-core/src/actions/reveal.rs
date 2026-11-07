//! Shows a value of an open Secret (ARCHITECTURE 3.6, 6.4): it leaves Rust
//! only as the Reveal runs, read from the Secret as last listed then, and
//! nothing is sent to the cluster.

use twigo_ipc::{IpcError, SubscriptionId};
use twigo_policy::friction::Risk;
use twigo_policy::redact::secret_value;

use super::kubectl;
use crate::Core;
use crate::bus::{Finished, Planned};

pub(crate) fn reveal(
    core: &Core,
    window: &str,
    object: SubscriptionId,
    key: String,
) -> Result<Planned, IpcError> {
    let (context, reading) = core.objects.with(window, object, |opened| {
        (opened.context().to_owned(), opened.reading())
    })?;
    let secret = reading.json()?;
    let (_, binary) = secret_value(&secret, &key)?;
    let name = secret["metadata"]["name"].as_str().unwrap_or_default();
    let namespace = secret["metadata"]["namespace"].as_str().unwrap_or_default();
    // A key holds only `-`, `.`, `_` and alphanumerics (IsConfigMapKey), so
    // it needs no escape in a Go string.
    let template = if binary {
        format!(r#"go-template={{{{index .data "{key}"}}}}"#)
    } else {
        format!(r#"go-template={{{{index .data "{key}" | base64decode}}}}"#)
    };
    let line = kubectl(&[
        "kubectl",
        "--context",
        &context,
        "get",
        "secrets",
        name,
        "-n",
        namespace,
        "-o",
        &template,
    ])?;
    Ok(Planned {
        question: format!("Reveal {key} of secret {name} in {namespace} from {context}?"),
        confirm: "Reveal value".to_owned(),
        consequences: vec![format!(
            "It shows until you hide it or close the secret{}.",
            if binary { ", as base64" } else { "" }
        )],
        kubectl: line,
        doing: format!("Revealing {key}"),
        command: "reveal",
        target: format!("secrets/{name} in {namespace}, key {key}"),
        writes: Vec::new(),
        context,
        risk: Risk::Reveal,
        run: Box::new(move |_| {
            Box::pin(async move {
                let (value, binary) = secret_value(&reading.json()?, &key)?;
                Ok(Finished::Revealed { value, binary })
            })
        }),
    })
}
