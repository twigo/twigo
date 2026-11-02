# Resource details: the drawer, the Overview and sections others can add

Research of 2026-11-02 for M1 steps 8 and 9, after the owner asked for details no poorer than Lens's, better where possible, and easy to extend.
Four surveys read source at tags: Freelens v2.0.0, the open fork of Lens, with Lens 5.0.0 for history; Headlamp v0.46.0; kubectl v1.37.0 with the Kubernetes Dashboard 7.14.0; Rancher Dashboard v2.15.3, k9s v0.51.0, VS Code 1.144.0 and its Kubernetes extension 1.4.1.
Nothing was run in those clients; what a survey read from code but did not run says "inference".
The decisions it led to are at the end and in [ARCHITECTURE](../ARCHITECTURE.md) 2.2, 3.6, 4.3, 5.4 and 6.6.

## What the clients show

### The drawer

- **Freelens keeps the open object in the URL and the width in storage.**
  `kube-details=<selfLink>` names the object, and a click on the selected row closes it ([toggle-details.injectable.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-detail-params/toggle-details.injectable.ts#L32-L40)).
  Escape, a click outside or the close icon close it ([drawer.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/drawer/drawer.tsx#L139-L169)).
  It opens at 725 px, drags between 300 px and 90 % of the window, resets on a double-click, and keeps the scroll position per history entry ([drawer.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/drawer/drawer.tsx#L123-L137), [drawer-storage.injectable.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/drawer/drawer-storage/drawer-storage.injectable.ts#L10-L20)).
  The header is `Kind: name` with a copy icon and the object's menu ([kube-object-details.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-object-details/kube-object-details.tsx#L58-L59)).
  Edit opens a YAML tab in the bottom dock, and there is no full-page view of an object.
- **Headlamp's drawer is a preview tab by another name.**
  A link opens a temporary activity that the next link replaces, and any click inside makes it permanent ([activitySlice.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/activity/activitySlice.tsx#L36-L65), [Activity.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/activity/Activity.tsx#L401-L409)).
  Users ask for what it lacks: a URL to share ([#3592](https://github.com/kubernetes-sigs/headlamp/issues/3592)) and a width to change ([#4968](https://github.com/kubernetes-sigs/headlamp/issues/4968)).
  Its drawer renders `DaemonSetDetails` where the route renders `WorkloadDetails`, so the two show different sections of one object ([KubeNodeDetails.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/resourceMap/details/KubeNodeDetails.tsx#L89-L112), [router](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/lib/router/index.tsx#L318-L329)).
- **Rancher's drawer falls back to YAML** unless the kind has both a custom edit and a custom detail component ([composables.ts](https://github.com/rancher/dashboard/blob/v2.15.3/shell/components/Drawer/ResourceDetailDrawer/composables.ts#L15-L30)).

Lesson: one component renders details wherever they appear, since Headlamp shows what two cost; the width is the user's and stays.

### Freshness

- **Freelens's drawer starts no watch.**
  It reads the object from its kind's store, which the list watches, or GETs it once ([current-kube-object-in-details.injectable.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-object-details/current-kube-object-in-details.injectable.ts#L26-L44)).
  Inference: an object reached through "Controlled By", whose kind no page watches, goes stale.
  ConfigMap and Secret details copy their data once, and stay stale until the cluster reconnects ([#1778](https://github.com/freelensapp/freelens/issues/1778)); pod environment values from a ConfigMap stay stale too ([#1546](https://github.com/freelensapp/freelens/issues/1546), and Lens [#902](https://github.com/lensapp/lens/issues/902)).
- **Headlamp watches each open object** with `fieldSelector=metadata.name=<name>`, and fetches its events once without a watch ([hooks.ts](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/lib/k8s/api/v2/hooks.ts#L108-L226), [ObjectEventList.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/common/ObjectEventList.tsx#L34-L88)).
  Its workload pods stay stale for minutes ([#4816](https://github.com/kubernetes-sigs/headlamp/issues/4816)), and a swallowed 410 leaves a view stale ([#7451](https://github.com/kubernetes-sigs/headlamp/issues/7451)).
- **The VS Code extension never updates** an open document: its file system's `watch()` does nothing ([kuberesources.virtualfs.ts](https://github.com/vscode-kubernetes-tools/vscode-kubernetes-tools/blob/1.4.1/src/kuberesources.virtualfs.ts#L36-L41)).
- **k9s polls** describe and YAML with a backoff and repaints only when the text changed ([describe.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/model/describe.go#L116-L172)).

Lesson: staleness is the most reported fault of every details view; whatever shows server state either follows it or says it does not.

### Sections and their order

- **Freelens** sorts by an `orderNumber`: metrics −1, metadata 0, the kind's details 10, a custom resource's 100, extensions 300 minus their priority, events last ([kube-object-detail-item-registrator.injectable.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-object-details/kube-object-detail-items/kube-object-detail-item-registrator.injectable.ts#L60), [kube-event-detail-item.injectable.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-object-details/kube-object-detail-items/implementations/kube-event-detail-item.injectable.ts#L15-L19)).
- **Headlamp** lays out header, metadata, the page's sections, children, plugin sections and events, gives each its own error boundary, and lets plugins reorder or remove them by id ([Resource.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/common/Resource/Resource.tsx#L258-L453)).
- **Rancher** sorts tabs by weight; its generic Conditions, Events and Related tabs take −1, −2 and −3, so a kind's own tabs come first ([ResourceTabs](https://github.com/rancher/dashboard/blob/v2.15.3/shell/components/form/ResourceTabs/index.vue#L183-L234), [Tabbed](https://github.com/rancher/dashboard/blob/v2.15.3/shell/components/Tabbed/index.vue#L163-L165)).
- **kubectl** prints metadata first and events last for every kind ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L773-L880)).

Lesson: metadata, then the kind's sections, then generic ones, then extensions, then events, each section with an id and an order.

### Pod and Deployment, the two most opened kinds

**Pod.**
kubectl prints the most ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L773-L880)):

- Priority, runtime class, service account, node, start time, "Terminating (lasts X)" while deleting, reason, message, seccomp profile, IPs, controller, nominated node, pod-level resources.
- Readiness gates, conditions, volumes per source type, QoS (status or computed), node selector, tolerations, topology spread, events.
- Per container ([L1785-L1809](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L1785-L1809)): ID, image and image ID, ports, command, args, state and last state (only when terminated), ready, restarts, limits, requests.
  It also prints all three probes on one line each, envFrom, the environment with fieldRefs resolved and key refs named but not read, mounts with subPath, and devices.

Freelens adds metrics, port-forward on each port, ConfigMap values resolved into the environment, about 35 volume types, and resize policy ([pod-details-container.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/workloads-pods/pod-details-container.tsx#L113-L211), [pod-container-env.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/workloads-pods/pod-container-env.tsx#L68-L232)).
It misses dnsPolicy, hostNetwork, restartPolicy and securityContext ([#14](https://github.com/freelensapp/freelens/issues/14)).
Headlamp adds a Diagnostics section, which gathers failing conditions, warning events, scheduling hints and a previous-logs button ([Diagnostics.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/diagnostics/Diagnostics.tsx#L484-L547)), and warns when an environment source changed after the container started ([Resource.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/common/Resource/Resource.tsx#L875-L1300)).
It shows only the liveness probe, and no requests or limits ([#5382](https://github.com/kubernetes-sigs/headlamp/issues/5382)).
The Dashboard shows all six condition columns, where kubectl shows type and status ([condition component](https://github.com/kubernetes/dashboard/blob/kubernetes-dashboard-7.14.0/modules/web/src/common/components/condition/component.ts#L26-L40)).

**Deployment.**
kubectl prints `desired | updated | total | available | unavailable`, the strategy with max surge and max unavailable, the pod template, conditions without their message, and the new and old ReplicaSets ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L4211-L4272)).
It finds them by the selector and keeps those whose controllerRef is the Deployment; the new one is the oldest whose template equals the Deployment's, `pod-template-hash` aside ([deployment.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/util/deployment/deployment.go#L102-L226)).
Freelens shows the ReplicaSets as "Deploy Revisions" and a pods table with metrics, but no images, rollout status or strategy parameters ([deployment-details.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/workloads-deployments/deployment-details.tsx#L72-L99)).
Headlamp shows the strategy, the progress deadline, a revision history with images, and pods by selector with metrics polled every 5 s, but no ReplicaSets ([extraInfo.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/workload/extraInfo.tsx#L37-L56), [RevisionHistorySection.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/common/Resource/RevisionHistorySection.tsx#L54-L173)).
The Dashboard shows no pods at all on a Deployment's page ([apihandler.go](https://github.com/kubernetes/dashboard/blob/kubernetes-dashboard-7.14.0/modules/api/pkg/handler/apihandler.go#L338-L402)).

Lesson: no client shows everything kubectl prints; the union of kubectl and the best of the others is the floor.

### The other core kinds

| Kind        | kubectl prints                                                                                                                          | Gaps in the others                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| StatefulSet | service name, pod management policy, update strategy and partition, PVC retention, pod phases, volume claim templates                   | Freelens: no replicas or claim templates, renders "0" for an empty selector         |
| DaemonSet   | node counts: desired, current, up-to-date, available, misscheduled                                                                      | kubectl: no update strategy or conditions                                           |
| Job         | parallelism, completions, mode, suspend, backoff, TTL, start, completion, duration, pod statuses, completed indexes                     | kubectl: no conditions                                                              |
| CronJob     | schedule, time zone, concurrency, history limits, deadline, last schedule, active jobs                                                  | kubectl: no last success or next run; Headlamp hides a deadline of 0 (#6973)        |
| Service     | IPs and families, traffic policies, ports with target, node port and endpoints (3 ready, then "+ N more")                               | Headlamp loads the namespace's endpoints and filters them in the client             |
| Ingress     | address, class, default backend, TLS, rules with each backend's endpoints                                                               | Headlamp: backends are text, not links                                              |
| Node        | roles, taints, lease holder and renewal, conditions with heartbeat, capacity, allocatable, non-terminated pods with %, allocated totals | Headlamp under-reports sidecar requests (#7678)                                     |
| PVC         | status, volume, capacity and modes once bound, volume mode, data source, Used By, conditions                                            | Headlamp has no Used By for ConfigMaps and Secrets either (#5848)                   |
| ConfigMap   | data in full, binaryData as sizes                                                                                                       | Freelens hides binaryData (#1882); Headlamp shows it as base64 and loses it (#6462) |
| Secret      | keys and sizes; a service account token in clear; no events                                                                             | see "Secrets and ConfigMaps"                                                        |

The rows above come from [describe.go at v1.37.0](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go): StatefulSet L3672-L3737, DaemonSet L2508-L2553, Job L2305-L2380, CronJob L2403-L2502, Service L2912-L3034, Ingress L2597-L2697, Node L3435-L3595, PVC L1645-L1783, ConfigMap L4334-L4372, Secret L2560-L2591.
The issues are Headlamp's [#6973](https://github.com/kubernetes-sigs/headlamp/issues/6973), [#7678](https://github.com/kubernetes-sigs/headlamp/issues/7678), [#5848](https://github.com/kubernetes-sigs/headlamp/issues/5848), [#6462](https://github.com/kubernetes-sigs/headlamp/issues/6462) and Freelens's [#1882](https://github.com/freelensapp/freelens/issues/1882).

### Custom resources and kinds without a hand-made view

- **kubectl** prints the whole object for any other kind, keys sorted and humanised, managedFields skipped ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L278-L398)).
- **Freelens** shows metadata, one row per printer column, conditions and events, and nothing of the spec or status ([details.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/custom-resources/details.tsx#L71-L109)).
  A CRD's printer columns and an extension's section then show the same fields twice ([#2916](https://github.com/freelensapp/freelens/issues/2916)).
- **Headlamp** evaluates the printer columns' JSONPaths in the browser, which leaves columns with escaped dots empty ([#7945](https://github.com/kubernetes-sigs/headlamp/issues/7945)).
  Its custom resource page skips the grid that plugins add to, so no plugin section reaches a custom resource ([CustomResourceDetails.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/crd/CustomResourceDetails.tsx#L83-L216)), and a built-in kind outside its map has no view at all.
- **Rancher** shows YAML; **k9s** shows the server's Table and kubectl's generic describe ([helpers.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/model/helpers.go#L21-L45)).
- **The API server answers a single GET as a Table too**: the GET handler hands its result to the same transform as a list, which converts it to a Table when asked, and `includeObject=Object` keeps the whole object in its row ([get.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L82), [response.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L264-L269), [asTable](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L367-L393)).
  So one request brings the object with the printer columns the server computed.

Lesson: the generic view is what most objects get, so it is a product of its own, not a fallback.

### Events

- **kubectl describe** lists core/v1 events with a field selector on the involved object's name, namespace, kind and uid ([event_expansion.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/client-go/kubernetes/typed/core/v1/event_expansion.go#L188-L203)).
  For a pod it drops the kind, and for a mirror pod it takes the uid from the `kubernetes.io/config.mirror` annotation ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L757-L767)); the code gives no reason for the first.
  For a node it merges two queries, by uid and by name, since the kubelet reports the name as the uid ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L3462-L3478)).
- **The Dashboard** selects on the name alone, so objects of different kinds with one name share their events ([common.go](https://github.com/kubernetes/dashboard/blob/kubernetes-dashboard-7.14.0/modules/api/pkg/resource/event/common.go#L44-L69)).
  Freelens matches by uid in a store of the last 1,000 events, so a busy cluster can show none ([store.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/events/store.ts#L32-L72)).
- **events.k8s.io/v1 selects on the same fields**: `regarding.*` maps onto `involvedObject.*`, and both groups share one store ([conversion.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/apis/events/v1/conversion.go#L63-L87), [storage_events.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/events/rest/storage_events.go#L50-L63)).
- **No field of an event is indexed, and the watch cache is off for events by default** ([storage.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/registry/core/event/storage/storage.go#L37-L58), [default_storage_factory_builder.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/pkg/kubeapiserver/default_storage_factory_builder.go#L55-L62)).
  Inference: every events query reads the namespace's events from etcd and filters them in the API server, which is why ARCHITECTURE 3.6 watches them only while they are shown.
- **Order and repeats.**
  describe sorts by `lastTimestamp` alone, so events written through events.k8s.io, which leave it empty, sort first ([sorted_event_list.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/util/event/sorted_event_list.go#L34-L36)).
  `kubectl events` sorts by `series.lastObservedTime`, then `lastTimestamp`, then `eventTime` ([events.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/cmd/events/events.go#L360-L374)).
  Both print a repeat as "3m (x12 over 1h)" from the series or the count ([event_printer.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/cmd/events/event_printer.go#L84-L99)).

### Secrets and ConfigMaps

- **kubectl** prints a Secret's keys with their sizes, except a service account token, which it prints in clear ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L2560-L2591)).
- **Freelens** shows each value's raw base64 in an editable field, with an eye that decodes it ([secret-details.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/config-secrets/secret-details.tsx#L88-L164)).
  A value revealed in a pod's environment cannot be hidden again ([secret-key.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/workloads-pods/secret-key.tsx#L42-L84)), and one stayed revealed after a switch to another pod ([#2416](https://github.com/freelensapp/freelens/issues/2416)).
  A ConfigMap gets an editable Monaco editor per key ([config-map-details.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/config-maps/config-map-details.tsx#L102-L133)).
- **Headlamp** masks values, reveals one into an editable field, copies the decoded value, and keeps unsaved edits through live updates ([secret/Details.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/secret/Details.tsx#L38-L116)).
  Its `btoa` re-encoding crashes the whole Containers section on a value outside Latin-1 ([#7619](https://github.com/kubernetes-sigs/headlamp/issues/7619)).
- **The Dashboard** lists every ConfigMap and Secret of the namespace to resolve a pod's environment, and sends the referenced Secret values to the browser ([detail.go](https://github.com/kubernetes/dashboard/blob/kubernetes-dashboard-7.14.0/modules/api/pkg/resource/pod/detail.go#L142-L196)).

Lesson: every web client ships Secret values to the page; ARCHITECTURE 3.6 already keeps them in Rust, and the reveal is where the others fail.

### Related objects

- **kubectl** relates by owner and selector: a Deployment's ReplicaSets, a StatefulSet's and DaemonSet's pods by selector and then controllerRef ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L4288-L4313)).
  It relates by reference too: a PVC's Used By lists the namespace's pods and checks their volumes ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L1666-L1711)), a Service's endpoints come from EndpointSlices labelled with its name ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L5256-L5319)), a node's pods from `spec.nodeName`.
- **The Dashboard** matches a ReplicaSet's Services by `matchLabels` only and ignores `matchExpressions` ([kubernetes.go](https://github.com/kubernetes/dashboard/blob/kubernetes-dashboard-7.14.0/modules/common/helpers/kubernetes.go#L25-L36)).
- **Headlamp** draws the widest graph, on a page of its own: owners, ConfigMaps and Secrets a pod uses, Service to pods, Ingress to Service, PVC to pods, HPA, RBAC, Gateway API and plugin relations ([relations.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/resourceMap/sources/definitions/relations.tsx#L108-L205)).
  Users ask to see it inside the details ([#7242](https://github.com/kubernetes-sigs/headlamp/issues/7242)).
- **Rancher** reads `metadata.relationships` from the objects its API returns ([RelatedResources.vue](https://github.com/rancher/dashboard/blob/v2.15.3/shell/components/RelatedResources.vue#L39-L60)); where they are computed was not verified.

### Actions

- Headlamp gates Logs, Terminal, Debug and Attach on an access review of each subresource ([pod/Details.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/pod/Details.tsx#L590-L679)).
- k9s offers Scale only for resources with a scale subresource, from discovery or a CRD's `subresources.scale`, and Edit and Delete only with their verbs outside read-only mode ([scale_extender.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/view/scale_extender.go#L26-L55), [browser.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/view/browser.go#L627-L667)).
- Rancher's actions are data, `{action, label, icon, enabled, weight}`, which per-kind models extend ([resource-class.js](https://github.com/rancher/dashboard/blob/v2.15.3/shell/plugins/dashboard-store/resource-class.js#L946-L1049)).

Twigo's commands and menus with `when` (ARCHITECTURE 5.1) cover this already; the gates they need are capability keys, the context's mode and the subresources discovery lists.

## How they let others extend details

- **Freelens: one token, add only.**
  Core kinds and extensions register `{Component, enabled, orderNumber}` on the same injection token, and a section receives only the object ([kube-object-detail-item-injection-token.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-object-details/kube-object-detail-items/kube-object-detail-item-injection-token.ts#L14-L22)).
  Extensions declare `{kind, apiVersions, components: {Details}, priority, visible}` ([kube-object-detail-registration.ts](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/kube-object-details/kube-object-detail-registration.ts#L13-L32)); the survey found no way to replace or hide a core section.
  Lens 5 had the same in a singleton registry, where core added Events to each kind by hand ([kube-object-detail-registry.tsx](https://github.com/lensapp/lens/blob/v5.0.0/src/renderer/initializers/kube-object-detail-registry.tsx#L60-L98)).
- **Headlamp: ids and processors.**
  `registerDetailsViewSection({id, section})` adds a section to every kind, and the section returns nothing for kinds it does not serve; a missing id becomes `generated-id-<time>` ([detailsViewSectionSlice.ts](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/components/DetailsViewSection/detailsViewSectionSlice.ts#L127-L142)).
  `registerDetailsViewSectionsProcessor` gets the resource and the sections and returns them reordered or filtered, by ids such as `headlamp.pod-containers` ([registry.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/plugin/registry.tsx#L670-L674)); header actions have the same pair ([registry.tsx](https://github.com/kubernetes-sigs/headlamp/blob/v0.46.0/frontend/src/plugin/registry.tsx#L499-L526)).
- **Rancher: layered resolution and locations.**
  A type resolves to a detail component from an extension first, then the built-in one, then the edit form, then YAML ([ResourceDetail/index.vue](https://github.com/rancher/dashboard/blob/v2.15.3/shell/components/ResourceDetail/index.vue#L107-L124)).
  `addTab`, `addPanel` and `addAction` take `(where, when, config)`, and the location tells the drawer from the page ([plugin.ts](https://github.com/rancher/dashboard/blob/v2.15.3/shell/core/plugin.ts#L224-L251), [types.ts](https://github.com/rancher/dashboard/blob/v2.15.3/shell/core/types.ts#L59-L91)).
  A version that lacks an extension point warns and ignores it ([plugin-helpers.ts](https://github.com/rancher/dashboard/blob/v2.15.3/shell/core/plugin-helpers.ts#L140-L177)).
- **VS Code: one owner per editor.**
  A custom editor owns a resource's whole editor, chosen by priority ([editorResolverService.ts](https://github.com/microsoft/vscode/blob/1.144.0/src/vs/workbench/services/editor/common/editorResolverService.ts#L130-L140)), and there is no point to add sections inside another's view.
  That is why its Kubernetes extension exports a contributor API of its own, versioned, which answers "unavailable" for versions it no longer has ([api.ts](https://github.com/vscode-kubernetes-tools/vscode-kubernetes-tools/blob/1.4.1/src/api/contract/api.ts#L9-L31)).
- **k9s and kubectl: registries by type with a fallback.**
  k9s keys its models and views by GVR and falls back to the server's Table for anything else ([registry.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/model/registry.go#L14-L100)); kubectl keys describers by GroupKind and falls back to a generic one ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L107-L122)).
  k9s computes QoS and health inside its table renderer, so its describe and YAML views cannot reuse them ([pod.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/render/pod.go#L132-L260)).

The patterns worth keeping: a registry keyed by type with a fallback that always works; sections with stable ids and an order; replacing a section only as an explicit override, as k9s requires `override` for a taken key ([actions.go](https://github.com/derailed/k9s/blob/v0.51.0/internal/view/actions.go#L115-L174)); actions as data behind `when`; a model of the object kept apart from its presentation; versioned contracts.

## What Twigo builds

### One document, described in Rust, rendered in two places

Rust describes an object into an **Overview document**: sections of typed blocks.
The drawer and the editor's Overview tab render the same document, and the MCP server's describe-style summaries (ARCHITECTURE 6.6) render it as text.

Why Rust rather than TypeScript:

- Secret values never leave Rust (ARCHITECTURE 3.6), so whatever reads them, sizes, environment references, reveals, sits there anyway.
- The facts that need other objects, a Deployment's ReplicaSets, a PVC's pods, a Service's endpoints, come from the hub's stores, which hold them already; the webview gets the answer, not the lists.
- MCP describes from the same code, rather than a second copy of the kinds' knowledge, which is the k9s counter-example above.
- The mock backend replays documents recorded from kind, rather than a second implementation in TypeScript; the query views' parity cases (`packages/protocol/src/mock/query-cases.json`) show what keeping one costs.

The cost: changing what a kind shows needs a Rust build and a new recording for the mock.
How a block looks stays in TypeScript.

### The document

Illustrative shape, not final:

```rust
struct Overview { object: ResourceRef, sections: Vec<Section> }
struct Section { id: SectionId, title: String, order: i32, source: Source, blocks: Vec<Block> }
enum Block {
    Fields(Vec<Field>),               // label, value, hint, actions
    Table { columns: Vec<Column>, rows: Vec<Vec<Value>> },
    Conditions(Vec<Condition>),       // every column, stale when observedGeneration lags
    Diagnostics(Vec<Finding>),        // why it is not ready, with the action that helps
    Containers(Vec<Container>),       // core only: state, last state, probes, env, mounts
    Volumes(Vec<Volume>),
    Data(DataKeys),                   // ConfigMap: keys and sizes, values on demand
    SecretData(SecretKeys),           // keys and sizes, reveal through a command
    List(ListQuery),                  // a live resource table, run by the hub's query views
    Events(EventsQuery),
    Tree(TreeNode),                   // spec and status of any kind, with schema descriptions
}
enum Value { Text(String), Time(String), Quantity(String), Ref(ResourceRef), Labels(Vec<(String, String)>), Badge(Tone, String), Code(String), Masked { bytes: u64 } }
```

- The blocks are a closed set: ts-rs generates their union, and the webview renders it with an exhaustive `switch`, so a new block is a type error until it is drawn.
  The open sets, kinds, sections and actions, are registries.
- A field's actions are command references with arguments (ARCHITECTURE 5.1), such as logs for a container or a port-forward for a port; the webview shows those whose `when` holds.
- A `Ref` carries its context, so a link never opens another cluster's object, the fault of Headlamp's [#8006](https://github.com/kubernetes-sigs/headlamp/issues/8006), [#8021](https://github.com/kubernetes-sigs/headlamp/issues/8021) and [#8089](https://github.com/kubernetes-sigs/headlamp/issues/8089).

### Describers

- A new crate, `twigo-describe`, maps a GroupKind to a describer and falls back to the generic one, as kubectl does.
- A describer is pure: `needs(object)` names the related queries it wants, and `describe(object, facts)` returns its sections.
  `twigo-core` runs the queries against the hub, applies `twigo-policy`'s redaction, and sends the document over a channel through the batcher.
- The pipeline adds the shared sections itself, so no describer repeats them: metadata first, then the kind's sections, printer columns for kinds without a describer, conditions, extension sections, events last.
- Workloads share one pod template section, as kubectl's describers do ([describe.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/kubectl/pkg/describe/describe.go#L2211-L2238)).
- Tests describe objects recorded from kind and compare the documents; the same recording feeds the mock, as `record_discovery` feeds `resources.json`.
- Adding a kind is one describer and its fixtures; the webview changes only for a new block.

### Sections from extensions

`resourceSections` in a manifest (ARCHITECTURE 5.4) declares sections as data, evaluated in Rust by the JSONPath evaluator of custom columns (3.3):

```jsonc
"resourceSections": [{
  "id": "certs.certificate",
  "for": [{ "group": "cert-manager.io", "kind": "Certificate" }],
  "title": "Certificate",
  "order": 350,
  "replaces": "core.printer-columns",
  "fields": [
    { "label": "Expires", "path": ".status.notAfter", "format": "time" },
    { "label": "Secret", "ref": { "kind": "Secret", "name": ".spec.secretName" } }
  ],
  "table": { "rows": ".spec.dnsNames[*]", "columns": [{ "label": "DNS name", "path": "@" }] }
}]
```

- Section ids carry the extension's prefix; core's are `core.*`.
- `replaces` names one section and is the only way to remove one, so Freelens's doubled fields ([#2916](https://github.com/freelensapp/freelens/issues/2916)) have a fix and a silent takeover does not; the section's header names the extension it came from.
  Two extensions replacing one section is an error shown on both.
- They reach every kind, custom resources included, and the drawer and MCP alike, since they live in the document; Headlamp's custom resource pages reach none.
- Tier 1 can later return blocks from a handler for what JSONPath cannot say, and tier 2 a frame block (ARCHITECTURE 5.3); both reuse the same document.

### Following the object

- **The editor** follows its object with the Object upstream that `Hub::object` already opens ([hub.rs](../../crates/twigo-cache/src/hub.rs)), and describes it again on every change.
- **The drawer** holds the same Object upstream once it has rested 150 ms on an object, so the drawer and the editor follow an object one way (decision 2).
  Re-reading the object whenever its row's `resourceVersion` changes would cost no watch, since the list's Table watch follows the row already ([meta.rs](../../crates/twigo-cache/src/meta.rs)), but it would be a second way, and objects reached through a link inside the drawer, held by no list, would need the watch anyway.
- **Events** run an events.k8s.io watch while their section or tab is shown, as 3.6 says, in the drawer too, since a failing pod is watched there as its events arrive.
- **Moving along rows with the arrows starts no upstream**, thanks to the pause, and each object a person stops on lingers 60 s as a list does.
  The hub evicts the least recently used idle upstream whenever a watch waits for the budget of 24 ([hub.rs](../../crates/twigo-cache/src/hub.rs)), so the watches a walk through twenty rows leaves behind never keep a list from its own.
- **Embedded lists** are query views like any other list, so they follow their rows by construction.
- **The Object upstream can ask for a Table with `includeObject=Object`.**
  The watch encoder runs every event through the same transform as a GET ([response.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L74-L82)), so each event would bring the server's printer columns with the whole object.
  On kind 1.37 a list and a watch of one pod brought the whole object in every row, and the column definitions in the list and the first event only (`crates/twigo-cache/tests/fixtures/pod-object-table-*`, recorded 2026-11-02).

### Live lists inside the Overview

A workload's pods, a CronJob's jobs, a node's pods and a Service's endpoints are `List` blocks: the same `ResourceTable` as the lists, with sorting, health, the context menu and opening, rather than a hand-made table such as Freelens's pods table ([pod-details-list.tsx](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/workloads-pods/pod-details-list.tsx#L184-L230)).
They need a query view filter on owner uids, which rows carry already; label selectors are matched in Rust today (3.4); `spec.nodeName` is a field selector, so a node's pods are an upstream of their own (3.2).
Used By, the pods that mount a ConfigMap, Secret or PVC, needs the pods' volumes and environment, which rows do not carry; a projection watch (3.3) of the namespace's pods could keep only those references, and runs only while the section is shown.

### What every Overview shows

- **Header:** kind icon, name with copy, namespace, age, the row's health, the actions of `resource/title`.
- **Metadata:** created with its date, Terminating with its grace period, uid, labels and annotations sorted, long and multiline values folded but whole on expand (Lens hid multiline ones, [#719](https://github.com/lensapp/lens/issues/719)), finalizers, owners as links to any kind discovery knows (Headlamp links only built-in kinds), managers from managedFields without their field sets.
- **Diagnostics,** when something is wrong: failing conditions, waiting and terminated reasons with exit codes, warning events, scheduling failures; each with the action that helps, such as previous logs.
- **The kind's sections,** or for any other kind: printer columns from the server, conditions, and spec and status as a tree with the field descriptions of its OpenAPI schema, fetched lazily (3.6).
- **Events,** newest first, sorted as `kubectl events` sorts them, repeats as "x12 over 1h", warnings in their tone.
- **Find** (⌘F) over every label and value, folded sections included, which Lens lacks ([#8092](https://github.com/lensapp/lens/issues/8092)).
- Sections fold and the state stays per kind; the drawer keeps its width and each object's scroll position.

Per kind, the floor is kubectl's output plus the best of the others, from the tables above.
Beyond it: all three probes, the security context and native sidecars for a Pod; ConfigMap values in a container's environment with a mark when the source changed after the container started; for a Deployment its rollout progress, its new and old ReplicaSets and a revision history with images; for a Node its allocated resources against allocatable and its lease.

### Secrets and ConfigMaps

- A Secret's document carries keys and sizes; reveal is a command per key that returns that value once, under the policy's Reveal row (6.4), and the webview forgets it when the object or the view changes.
- A value that is not UTF-8 shows as binary with its size, so no decoding can crash a section, as Headlamp's does.
- A service account token is masked like any value, where kubectl prints it.
- A ConfigMap's document carries keys and sizes; values come on demand for the keys in view, so a ConfigMap of 2,000 keys puts only the visible values in the DOM, and binaryData shows its sizes.
  Values show in a light highlighted view chosen by the key's suffix, not a Monaco editor per key; editing comes with the apply flow (6.5).

### Code layout

| Where                                                   | What                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `crates/twigo-ipc`                                      | The document's types, generated to TypeScript                                                       |
| `crates/twigo-describe`                                 | Describers by GroupKind, the generic describer, shared sections, the JSONPath sections of manifests |
| `crates/twigo-core`                                     | The overview service: GET or Object upstream, needs against the hub, redaction, the channel         |
| `packages/kube/src/overview/`                           | `Overview` (sections, folding, find, an error boundary per section), one renderer per block, values |
| `packages/kube/src/Details.tsx` and the `k8s://` editor | Both render `Overview`; the editor adds YAML, Events and Related                                    |
| `packages/protocol/src/mock`                            | Documents recorded from kind                                                                        |

## Decisions

Taken with the owner on 2026-11-02:

1. **The kinds' knowledge lives in Rust, in `twigo-describe`, shared with MCP**, rather than as data in `packages/kube`.
2. **The drawer stays live through the Object upstream**, as the editor does, and watches events while it shows them, rather than GETting once.
3. **Workload pods, CronJob jobs and node pods are live tables inside the Overview**, which needs an owner filter in the query views.
4. **An extension's section may replace a core section, only by naming its id**, and the header says so.

Steps 8 and 9 split along the document: step 8 builds the types, the pipeline with metadata, printer columns, conditions, events and the generic tree, Secrets and ConfigMaps, the drawer and the editor; step 9 adds the twelve describers, Diagnostics and the embedded lists.
