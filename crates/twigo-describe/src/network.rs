//! Services and Ingresses: what kubectl describe prints of them (kubectl
//! v1.37.1, `describeService`, `describeIngressV1`), their endpoints read
//! from the namespace's EndpointSlices as kubectl reads them.

use serde_json::Value;
use twigo_ipc::{Block, Finding, Section, Span, Tone, Value as Shown};

use crate::show::{Fields, NODE, POD, SECRET, SERVICE, code, labels, link, plain, toned};
use crate::workloads::fact;
use crate::{Described, Found, Input, Need, text};

/// The label an EndpointSlice names its Service by.
const SERVICE_NAME: &str = "kubernetes.io/service-name";
/// How many endpoints a port lists before it counts the rest, as kubectl.
const SHOWN: usize = 3;
/// What a port without a ready endpoint lists.
const NONE: &str = "none";

fn namespaced(object: &Value, group: &str, resource: &str) -> Need {
    Need {
        group: group.to_owned(),
        version: "v1".to_owned(),
        resource: resource.to_owned(),
        namespaced: true,
        namespace: text(&object["metadata"]["namespace"]),
        field_selector: None,
    }
}

fn slices_need(object: &Value) -> Need {
    namespaced(object, "discovery.k8s.io", "endpointslices")
}

fn services_need(object: &Value) -> Need {
    namespaced(object, "", "services")
}

pub(crate) fn service_needs(object: &Value) -> Vec<Need> {
    vec![slices_need(object)]
}

pub(crate) fn ingress_needs(object: &Value) -> Vec<Need> {
    vec![services_need(object), slices_need(object)]
}

/// The slices of a Service, or why they cannot be listed; None until they
/// are.
fn slices_of<'a>(
    found: Option<&'a Found>,
    service: &str,
) -> Option<Result<Vec<&'a Value>, &'a str>> {
    Some(match found? {
        Found::Listed { objects } => Ok(objects
            .iter()
            .filter(|slice| slice["metadata"]["labels"][SERVICE_NAME] == service)
            .collect()),
        Found::Unavailable { message } => Err(message.as_str()),
    })
}

fn ready(endpoint: &Value) -> bool {
    endpoint["conditions"]["ready"].as_bool() != Some(false)
}

/// The ready endpoints of a port by its name, `ip:port`, as kubectl's
/// `formatEndpointSlices` lists them: three, then how many more.
fn endpoints(slices: &[&Value], port: &str) -> String {
    let mut shown: Vec<String> = Vec::new();
    let mut count = 0;
    for slice in slices {
        let ports = slice["ports"].as_array().filter(|ports| !ports.is_empty());
        for endpoint in slice["endpoints"].as_array().into_iter().flatten() {
            if !ready(endpoint) {
                continue;
            }
            let address = endpoint["addresses"][0].as_str().unwrap_or_default();
            match ports {
                None => {
                    count += 1;
                    if shown.len() < SHOWN {
                        shown.push(address.to_owned());
                    }
                }
                Some(ports) => {
                    for slice_port in ports {
                        if slice_port["name"].as_str().unwrap_or_default() != port {
                            continue;
                        }
                        count += 1;
                        if shown.len() < SHOWN {
                            let number = slice_port["port"].as_i64().unwrap_or_default();
                            shown.push(if address.contains(':') {
                                format!("[{address}]:{number}")
                            } else {
                                format!("{address}:{number}")
                            });
                        }
                    }
                }
            }
        }
    }
    if shown.is_empty() {
        return NONE.to_owned();
    }
    let listed = shown.join(", ");
    if count > SHOWN {
        format!("{listed} + {} more", count - SHOWN)
    } else {
        listed
    }
}

pub(crate) fn service(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let name = text(&object["metadata"]["name"]).unwrap_or_default();
    let namespace = text(&object["metadata"]["namespace"]);
    let mut fields = Fields::default();
    fields.text("Type", &spec["type"]);
    fields.maybe("Selector", labels(&spec["selector"]));
    fields.maybe("IPs", strings(&spec["clusterIPs"]).map(code));
    fields.text("IP family policy", &spec["ipFamilyPolicy"]);
    fields.maybe("IP families", strings(&spec["ipFamilies"]).map(plain));
    fields.maybe("External IPs", strings(&spec["externalIPs"]).map(code));
    fields.text("Desired load balancer IP", &spec["loadBalancerIP"]);
    fields.text("External name", &spec["externalName"]);
    fields.maybe(
        "Load balancer",
        load_balancer(&object["status"]["loadBalancer"]["ingress"]).map(code),
    );
    fields.text("Load balancer class", &spec["loadBalancerClass"]);
    fields.maybe(
        "Source ranges",
        strings(&spec["loadBalancerSourceRanges"]).map(code),
    );
    fields.text("Session affinity", &spec["sessionAffinity"]);
    fields.text("External traffic", &spec["externalTrafficPolicy"]);
    fields.text("Internal traffic", &spec["internalTrafficPolicy"]);
    fields.scalar("Health check node port", &spec["healthCheckNodePort"]);
    fields.text("Traffic distribution", &spec["trafficDistribution"]);
    fields.flag("Publish not-ready", &spec["publishNotReadyAddresses"]);
    let slices = slices_of(fact(input.facts, &slices_need(object)), &name);
    let mut sections = vec![Section {
        id: "core.service".to_owned(),
        title: "Service".to_owned(),
        blocks: vec![Block::Fields { fields: fields.0 }],
    }];
    let listed = slices.as_ref().and_then(|slices| slices.as_ref().ok());
    let rows: Vec<Vec<Shown>> = spec["ports"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|port| {
            let port_name = port["name"].as_str().unwrap_or_default();
            let protocol = port["protocol"].as_str().unwrap_or("TCP");
            let mut row = vec![
                plain(if port_name.is_empty() {
                    "unset"
                } else {
                    port_name
                }),
                plain(format!(
                    "{}/{protocol}",
                    crate::show::scalar(&port["port"]).unwrap_or_default()
                )),
                plain(format!(
                    "{}/{protocol}",
                    crate::show::scalar(&port["targetPort"]).unwrap_or_default()
                )),
                plain(crate::show::scalar(&port["nodePort"]).unwrap_or_default()),
                plain(text(&port["appProtocol"]).unwrap_or_default()),
            ];
            row.push(match &slices {
                Some(Ok(slices)) => code(endpoints(slices, port_name)),
                Some(Err(message)) => plain(*message),
                None => plain(""),
            });
            row
        })
        .collect();
    if !rows.is_empty() {
        sections.push(Section {
            id: "core.ports".to_owned(),
            title: "Ports".to_owned(),
            blocks: vec![Block::Table {
                columns: [
                    "Name",
                    "Port",
                    "Target",
                    "Node port",
                    "App protocol",
                    "Endpoints",
                ]
                .map(str::to_owned)
                .to_vec(),
                rows,
            }],
        });
    }
    if let Some(slices) = listed {
        sections.extend(endpoint_table(slices, namespace.as_deref()));
    }
    let mut findings = Vec::new();
    if let Some(slices) = listed
        && served_by_pods(object)
        && !slices.iter().any(|slice| {
            slice["endpoints"]
                .as_array()
                .into_iter()
                .flatten()
                .any(ready)
        })
    {
        findings.push(Finding {
            logs: None,
            tone: Tone::Warning,
            title: "No ready pod serves it".to_owned(),
            detail: vec![Span::Text {
                text: "No pod that its selector picks is ready.".to_owned(),
            }],
            message: None,
        });
    }
    Described { findings, sections }
}

/// Every endpoint of the slices: its address, whether it is ready, its
/// node and the pod behind it.
fn endpoint_table(slices: &[&Value], namespace: Option<&str>) -> Option<Section> {
    let mut rows: Vec<(String, Vec<Shown>)> = Vec::new();
    for slice in slices {
        for endpoint in slice["endpoints"].as_array().into_iter().flatten() {
            let addresses = strings(&endpoint["addresses"]).unwrap_or_default();
            if rows.iter().any(|(seen, _)| *seen == addresses) {
                continue;
            }
            let conditions = &endpoint["conditions"];
            let state = if conditions["terminating"].as_bool() == Some(true) {
                toned("terminating", Tone::Warning)
            } else if ready(endpoint) {
                plain("ready")
            } else {
                toned("not ready", Tone::Warning)
            };
            let target = &endpoint["targetRef"];
            let pod = match (target["kind"].as_str(), target["name"].as_str()) {
                (Some("Pod"), Some(name)) => link(POD, namespace, name, name),
                (Some(kind), Some(name)) => plain(format!("{kind}/{name}")),
                _ => plain(""),
            };
            let node = text(&endpoint["nodeName"])
                .map_or_else(|| plain(""), |node| link(NODE, None, &node, node.clone()));
            rows.push((addresses.clone(), vec![code(addresses), state, node, pod]));
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    (!rows.is_empty()).then(|| Section {
        id: "core.endpoints".to_owned(),
        title: "Endpoints".to_owned(),
        blocks: vec![Block::Table {
            columns: ["Address", "State", "Node", "Pod"]
                .map(str::to_owned)
                .to_vec(),
            rows: rows.into_iter().map(|(_, row)| row).collect(),
        }],
    })
}

/// A list of strings joined by commas; None when empty.
fn strings(list: &Value) -> Option<String> {
    let items: Vec<&str> = list.as_array()?.iter().filter_map(Value::as_str).collect();
    (!items.is_empty()).then(|| items.join(", "))
}

/// Load balancer ingress points as kubectl's `buildIngressString` writes
/// them: the IP with its mode, else the hostname.
fn load_balancer(ingress: &Value) -> Option<String> {
    let points: Vec<String> = ingress
        .as_array()?
        .iter()
        .map(|point| match text(&point["ip"]) {
            Some(ip) => match text(&point["ipMode"]) {
                Some(mode) => format!("{ip} ({mode})"),
                None => ip,
            },
            None => point["hostname"].as_str().unwrap_or_default().to_owned(),
        })
        .collect();
    (!points.is_empty()).then(|| points.join(", "))
}

pub(crate) fn ingress(input: &Input<'_>) -> Described {
    let object = input.object;
    let spec = &object["spec"];
    let namespace = text(&object["metadata"]["namespace"]);
    let namespace = namespace.as_deref();
    let services = fact(input.facts, &services_need(object));
    let slices = fact(input.facts, &slices_need(object));
    let mut fields = Fields::default();
    fields.maybe(
        "Class",
        text(&spec["ingressClassName"]).map(|class| {
            link(
                ("networking.k8s.io", "v1", "IngressClass"),
                None,
                &class,
                class.clone(),
            )
        }),
    );
    fields.add(
        "Address",
        load_balancer(&object["status"]["loadBalancer"]["ingress"])
            .map_or_else(|| plain("none yet"), code),
    );
    let mut missing: Vec<String> = Vec::new();
    let mut unserved: Vec<String> = Vec::new();
    let mut backend = |backend: &Value| -> (Shown, Shown) {
        describe_backend(
            backend,
            namespace,
            services,
            slices,
            &mut missing,
            &mut unserved,
        )
    };
    fields.add(
        "Default backend",
        if spec["defaultBackend"].is_object() {
            {
                let (target, endpoints) = backend(&spec["defaultBackend"]);
                Shown::List {
                    items: vec![target, endpoints],
                }
            }
        } else {
            plain("the controller's")
        },
    );
    let mut sections = vec![Section {
        id: "core.ingress".to_owned(),
        title: "Ingress".to_owned(),
        blocks: vec![Block::Fields { fields: fields.0 }],
    }];
    let mut rows = Vec::new();
    for rule in spec["rules"].as_array().into_iter().flatten() {
        let host = text(&rule["host"]).unwrap_or_else(|| "*".to_owned());
        for path in rule["http"]["paths"].as_array().into_iter().flatten() {
            let (target, endpoints) = backend(&path["backend"]);
            rows.push(vec![
                plain(host.clone()),
                code(path["path"].as_str().unwrap_or_default()),
                plain(path["pathType"].as_str().unwrap_or_default()),
                target,
                endpoints,
            ]);
        }
    }
    if !rows.is_empty() {
        sections.push(Section {
            id: "core.rules".to_owned(),
            title: "Rules".to_owned(),
            blocks: vec![Block::Table {
                columns: ["Host", "Path", "Type", "Backend", "Endpoints"]
                    .map(str::to_owned)
                    .to_vec(),
                rows,
            }],
        });
    }
    let tls: Vec<Vec<Shown>> = spec["tls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|tls| {
            vec![
                plain(strings(&tls["hosts"]).unwrap_or_else(|| "*".to_owned())),
                text(&tls["secretName"]).map_or_else(
                    || plain("the controller's"),
                    |secret| link(SECRET, namespace, &secret, secret.clone()),
                ),
            ]
        })
        .collect();
    if !tls.is_empty() {
        sections.push(Section {
            id: "core.tls".to_owned(),
            title: "TLS".to_owned(),
            blocks: vec![Block::Table {
                columns: ["Hosts", "Secret"].map(str::to_owned).to_vec(),
                rows: tls,
            }],
        });
    }
    missing.sort();
    missing.dedup();
    unserved.sort();
    unserved.dedup();
    let finding = |title: String| Finding {
        logs: None,
        tone: Tone::Warning,
        title,
        detail: vec![Span::Text {
            text: "The ingress sends traffic to it.".to_owned(),
        }],
        message: None,
    };
    let findings = missing
        .into_iter()
        .map(|service| finding(format!("Service {service} does not exist")))
        .chain(
            unserved
                .into_iter()
                .map(|service| finding(format!("No ready pod serves Service {service}"))),
        )
        .collect();
    Described { findings, sections }
}

/// Whether pods serve a Service through EndpointSlices that its controller
/// keeps: not an ExternalName one nor one without a selector, for which it
/// makes none (kubernetes v1.37.1 `endpointslice_controller.go`).
fn served_by_pods(service: &Value) -> bool {
    service["spec"]["type"] != "ExternalName"
        && service["spec"]["selector"]
            .as_object()
            .is_some_and(|selector| !selector.is_empty())
}

/// A backend as `service:port`, a link to its Service, and its ready
/// endpoints, found as kubectl's `describeBackendV1` finds them: the
/// Service's port by number or name, then the slices' port of that name.
fn describe_backend(
    backend: &Value,
    namespace: Option<&str>,
    services: Option<&Found>,
    slices: Option<&Found>,
    missing: &mut Vec<String>,
    unserved: &mut Vec<String>,
) -> (Shown, Shown) {
    let service = &backend["service"];
    if !service.is_object() {
        let resource = &backend["resource"];
        return (
            plain(format!(
                "{} {}",
                resource["kind"].as_str().unwrap_or_default(),
                resource["name"].as_str().unwrap_or_default()
            )),
            plain(""),
        );
    }
    let name = service["name"].as_str().unwrap_or_default();
    let port = &service["port"];
    let shown_port = port["number"]
        .as_i64()
        .filter(|number| *number != 0)
        .map_or_else(
            || port["name"].as_str().unwrap_or_default().to_owned(),
            |number| number.to_string(),
        );
    let target = link(SERVICE, namespace, name, format!("{name}:{shown_port}"));
    let endpoints = match services {
        Some(Found::Listed { objects }) => {
            match objects
                .iter()
                .find(|object| object["metadata"]["name"] == name)
            {
                None => {
                    missing.push(name.to_owned());
                    toned("no such service", Tone::Warning)
                }
                Some(found) => {
                    let port_name = found["spec"]["ports"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .rfind(|candidate| {
                            (port["number"].as_i64().is_some_and(|number| number != 0)
                                && candidate["port"] == port["number"])
                                || (port["name"].as_str().is_some_and(|name| !name.is_empty())
                                    && candidate["name"] == port["name"])
                        })
                        .and_then(|candidate| candidate["name"].as_str())
                        .unwrap_or_default();
                    match slices_of(slices, name) {
                        Some(Ok(slices)) => {
                            let shown = endpoints(&slices, port_name);
                            if shown == NONE && served_by_pods(found) {
                                unserved.push(name.to_owned());
                            }
                            code(shown)
                        }
                        Some(Err(message)) => plain(message),
                        None => plain(""),
                    }
                }
            }
        }
        Some(Found::Unavailable { message }) => plain(message.clone()),
        None => plain(""),
    };
    (target, endpoints)
}
