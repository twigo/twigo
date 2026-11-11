//! The TCP ports a target declares (ARCHITECTURE 4.6), read from its object.

use serde_json::Value;
use twigo_ipc::{ErrorKind, ForwardPort, IpcError};

/// The ports of `object`, a `kind`, in the order of its spec, TCP ones only.
/// Their `local` and `forward` are for the caller to fill.
pub(super) fn declared(
    kind: &str,
    name: &str,
    object: &Value,
) -> Result<Vec<ForwardPort>, IpcError> {
    let ports = match kind {
        "Service" => service(&object["spec"]),
        "Pod" => containers(&object["spec"]),
        _ => containers(&object["spec"]["template"]["spec"]),
    };
    if ports.is_empty() {
        return Err(IpcError::new(
            ErrorKind::InvalidInput,
            format!("{kind} {name} declares no TCP port to forward to"),
        ));
    }
    Ok(ports)
}

fn is_tcp(port: &Value) -> bool {
    port["protocol"]
        .as_str()
        .is_none_or(|protocol| protocol == "TCP")
}

fn named(port: &Value) -> Option<String> {
    port["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn number(port: &Value, key: &str) -> Option<u16> {
    port[key].as_u64().and_then(|port| u16::try_from(port).ok())
}

fn service(spec: &Value) -> Vec<ForwardPort> {
    spec["ports"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|port| is_tcp(port))
        .filter_map(|declared| {
            let port = number(declared, "port")?;
            let target_port = match &declared["targetPort"] {
                Value::Number(number) => Some(number.to_string()),
                Value::String(name) => Some(name.clone()),
                _ => None,
            }
            .filter(|target| *target != port.to_string());
            Some(ForwardPort {
                port,
                name: named(declared),
                target_port,
                container: None,
                app_protocol: declared["appProtocol"].as_str().map(str::to_owned),
                local: 0,
                forward: None,
            })
        })
        .collect()
}

/// The ports of the containers that run for the pod's life: its containers,
/// then its sidecars.
fn containers(spec: &Value) -> Vec<ForwardPort> {
    let sidecars = spec["initContainers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|container| container["restartPolicy"].as_str() == Some("Always"));
    spec["containers"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(sidecars)
        .flat_map(|container| {
            let owner = container["name"].as_str().map(str::to_owned);
            container["ports"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|port| is_tcp(port))
                .filter_map(move |declared| {
                    Some(ForwardPort {
                        port: number(declared, "containerPort")?,
                        name: named(declared),
                        target_port: None,
                        container: owner.clone(),
                        app_protocol: None,
                        local: 0,
                        forward: None,
                    })
                })
        })
        .collect()
}

/// How early a name has its port chosen when none is: one that says HTTP
/// first, an unnamed one next, then the others, and last those that say
/// metrics, health or debug, which people look at less.
fn rank(name: Option<&str>) -> u8 {
    let Some(name) = name else {
        return 1;
    };
    let name = name.to_ascii_lowercase();
    if ["metric", "health", "debug"]
        .iter()
        .any(|word| name.contains(word))
    {
        3
    } else if name.contains("http") || name.contains("web") {
        0
    } else {
        2
    }
}

/// The `port` a start without a choice takes: the best-ranked, the first of
/// them in the spec's order.
pub(super) fn default(ports: &[ForwardPort]) -> u16 {
    ports
        .iter()
        .min_by_key(|port| rank(port.name.as_deref()))
        .expect("a target with ports")
        .port
}

/// The local port a start takes when none is given: the one this port of
/// this target had last, else the same number, else, for a port below 1024,
/// which an app may not bind everywhere, that number plus 8000.
pub(super) fn local(remembered: Option<u16>, port: u16) -> u16 {
    remembered.unwrap_or(if port < 1024 { port + 8000 } else { port })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn names(ports: &[ForwardPort]) -> Vec<(u16, Option<&str>)> {
        ports
            .iter()
            .map(|port| (port.port, port.name.as_deref()))
            .collect()
    }

    #[test]
    fn a_services_tcp_ports_come_in_the_specs_order_with_their_target_ports() {
        let service = json!({ "spec": { "ports": [
            { "name": "http", "port": 80, "targetPort": "web", "appProtocol": "kubernetes.io/h2c" },
            { "port": 9000, "protocol": "UDP" },
            { "name": "same", "port": 8080, "targetPort": 8080 },
            { "name": "other", "port": 8443, "targetPort": 9443 },
            { "port": 5432, "protocol": "TCP" },
        ] } });
        let ports = declared("Service", "web", &service).unwrap();
        assert_eq!(
            names(&ports),
            [
                (80, Some("http")),
                (8080, Some("same")),
                (8443, Some("other")),
                (5432, None)
            ]
        );
        assert_eq!(ports[0].target_port.as_deref(), Some("web"));
        assert_eq!(ports[0].app_protocol.as_deref(), Some("kubernetes.io/h2c"));
        assert_eq!(ports[1].target_port, None, "a target port that is the port");
        assert_eq!(ports[2].target_port.as_deref(), Some("9443"));
    }

    #[test]
    fn a_pods_and_a_templates_container_ports_come_with_their_containers() {
        let spec = json!({
            "initContainers": [
                { "name": "setup", "ports": [{ "containerPort": 1 }] },
                { "name": "proxy", "restartPolicy": "Always", "ports": [{ "name": "admin", "containerPort": 15000 }] },
            ],
            "containers": [
                { "name": "app", "ports": [
                    { "name": "http", "containerPort": 8080 },
                    { "containerPort": 53, "protocol": "UDP" },
                ] },
                { "name": "metrics", "ports": null },
            ],
        });
        let pod = json!({ "spec": spec });
        let template = json!({ "spec": { "template": { "spec": spec } } });
        for (kind, object) in [("Pod", pod), ("Deployment", template)] {
            let ports = declared(kind, "api", &object).unwrap();
            assert_eq!(
                names(&ports),
                [(8080, Some("http")), (15000, Some("admin"))]
            );
            assert_eq!(ports[0].container.as_deref(), Some("app"));
            assert_eq!(ports[1].container.as_deref(), Some("proxy"));
        }
    }

    #[test]
    fn a_target_with_no_tcp_port_is_refused_in_words() {
        let pod = json!({ "spec": { "containers": [{ "name": "dns", "ports": [
            { "containerPort": 53, "protocol": "UDP" }
        ] }] } });
        let refused = declared("Pod", "dns-0", &pod).unwrap_err();
        assert_eq!(refused.kind, ErrorKind::InvalidInput);
        assert_eq!(
            refused.message,
            "Pod dns-0 declares no TCP port to forward to"
        );
    }

    #[test]
    fn the_default_port_says_http_first_and_metrics_health_and_debug_last() {
        let port = |number: u16, name: Option<&str>| ForwardPort {
            port: number,
            name: name.map(str::to_owned),
            target_port: None,
            container: None,
            app_protocol: None,
            local: 0,
            forward: None,
        };
        assert_eq!(
            default(&[
                port(9090, Some("metrics")),
                port(5432, Some("pg")),
                port(80, Some("web"))
            ]),
            80
        );
        assert_eq!(
            default(&[port(9090, Some("http-metrics")), port(5432, Some("pg"))]),
            5432
        );
        assert_eq!(
            default(&[port(9090, Some("health")), port(5432, Some("pg"))]),
            5432
        );
        assert_eq!(default(&[port(9090, Some("debug")), port(1, None)]), 1);
        assert_eq!(
            default(&[port(8080, Some("one")), port(8081, Some("two"))]),
            8080,
            "the first of equals"
        );
    }

    #[test]
    fn the_local_port_is_the_last_one_else_the_port_else_the_port_plus_8000_below_1024() {
        assert_eq!(local(Some(18080), 8080), 18080);
        assert_eq!(local(None, 8080), 8080);
        assert_eq!(local(None, 80), 8080);
        assert_eq!(local(Some(80), 80), 80);
        assert_eq!(local(None, 1024), 1024);
        assert_eq!(local(None, 1023), 9023);
    }
}
