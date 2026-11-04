//! Which containers of a pod a source chooses.

use serde_json::Value;
use twigo_ipc::Containers;

/// The annotation that names the container kubectl reads by default
/// (kubectl v0.34.1, `podcmd.DefaultContainerAnnotationName`).
const DEFAULT: &str = "kubectl.kubernetes.io/default-container";

/// The pod's init containers and containers, in the spec's order.
pub fn containers(pod: &Value) -> Vec<String> {
    ["initContainers", "containers"]
        .iter()
        .flat_map(|key| pod["spec"][key].as_array().into_iter().flatten())
        .filter_map(|container| container["name"].as_str().map(str::to_owned))
        .collect()
}

/// The containers `chosen` picks of the pod's, in the spec's order.
pub fn chosen(pod: &Value, chosen: &Containers) -> Vec<String> {
    let all = containers(pod);
    match chosen {
        Containers::All => all,
        Containers::Named { name } => all.into_iter().filter(|c| c == name).collect(),
        Containers::Default => {
            let annotated = pod["metadata"]["annotations"][DEFAULT]
                .as_str()
                .filter(|name| all.iter().any(|c| c == name));
            let first = pod["spec"]["containers"][0]["name"].as_str();
            annotated.or(first).map(str::to_owned).into_iter().collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_source_chooses_the_default_a_named_or_every_container() {
        let pod = json!({
            "metadata": { "annotations": { DEFAULT: "app" } },
            "spec": {
                "initContainers": [{ "name": "migrate" }],
                "containers": [{ "name": "proxy" }, { "name": "app" }],
            },
        });
        assert_eq!(containers(&pod), ["migrate", "proxy", "app"]);
        assert_eq!(chosen(&pod, &Containers::Default), ["app"]);
        assert_eq!(chosen(&pod, &Containers::All), ["migrate", "proxy", "app"]);
        let named = |name: &str| Containers::Named {
            name: name.to_owned(),
        };
        assert_eq!(chosen(&pod, &named("migrate")), ["migrate"]);
        assert!(chosen(&pod, &named("db")).is_empty());

        let mut unannotated = pod.clone();
        unannotated["metadata"]["annotations"][DEFAULT] = json!("gone");
        assert_eq!(chosen(&unannotated, &Containers::Default), ["proxy"]);
    }
}
