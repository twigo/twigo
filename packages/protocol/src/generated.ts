// Generated from crates/twigo-ipc: TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript

/**
 * One thing RBAC may allow: `patch` on `deployments/scale` of `apps`.
 */
export type Access = { verb: string, 
/**
 * Empty for the core group.
 */
group: string, resource: string, subresource: string | null, 
/**
 * The one object it is for, which a rule that lists `resourceNames`
 * needs; none for the resource as a whole.
 */
name: string | null, };

/**
 * What the person asks whether they may do in a space, as RBAC names it,
 * in one namespace or, with none, in all of them and for cluster-scoped
 * resources.
 */
export type AccessQuery = { space: string, namespace: string | null, checks: Array<Access>, };

export type Ack = { id: SubscriptionId, seq: number, };

/**
 * Objects that one thing happens to.
 */
export type Affected = { 
/**
 * What happens to them: `With it go`, `Evicts`.
 */
title: string, objects: Array<ObjectRef>, };

export type AnsiColor = "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue" | "brightMagenta" | "brightCyan" | "brightWhite";

export type AnswerApproval = { id: ApprovalId, answer: ApprovalAnswer, 
/**
 * What the person typed, for an ask with `typed`.
 */
typed: string | null, };

export type AnswerKubeconfigOffer = { id: KubeconfigOfferId, 
/**
 * The revision of the offer the person answered: an answer to another
 * than the offer's now changes nothing and is refused as a conflict.
 */
revision: number, answer: KubeconfigOfferAnswer, };

/**
 * A field another manager owns that an apply would change.
 */
export type ApplyConflict = { 
/**
 * As the server names it: `.spec.replicas`.
 */
path: string, manager: string, };

/**
 * What a dry-run found; a closed set, so the webview cannot miss a case.
 */
export type ApplyPreviewed = { "state": "unchanged", 
/**
 * What the edit said that Twigo leaves out: `status`, the
 * server's metadata.
 */
ignored: Array<string>, } | { "state": "ready", id: PreviewId, 
/**
 * Null for a manifest of a new object.
 */
live: unknown, result: unknown, warnings: Array<string>, 
/**
 * What goes by a merge patch: a separate step after a
 * server-side apply, or part of the one patch.
 */
removals: Array<string>, ignored: Array<string>, strategy: ApplyStrategy, } | { "state": "conflicts", conflicts: Array<ApplyConflict>, } | { "state": "stale", message: string, 
/**
 * Whether "Keep mine" answers it. It does not for a list sent whole,
 * which keeping the edit would send again, reverting the other
 * writer's change; only a reload answers that.
 */
keepable: boolean, } | { "state": "immutable", message: string, recreate: PreviewId | null, };

/**
 * An edit to preview, parsed by the webview's YAML parser, so there is one
 * YAML dialect.
 */
export type ApplyRequest = { space: string, 
/**
 * The object it edits; none for a new manifest, whose object is its
 * whole configuration and whose resource comes from discovery.
 */
opened: OpenedEdit | null, 
/**
 * The object as the person left it.
 */
edited: unknown, 
/**
 * Answer conflicts by taking the fields.
 */
force: boolean, 
/**
 * The conflicting paths the person gave up, as [`ApplyConflict`] names
 * them, which leave the configuration.
 */
drop: Array<string>, };

/**
 * How an edit that can go is sent.
 */
export type ApplyStrategy = "serverSideApply" | "mergePatch";

export type ApprovalAnswer = { "kind": "deny" } | { "kind": "once" } | { "kind": "lasting" } | { "kind": "mark", environment: Environment, };

/**
 * What a process asks to do, for the person to allow or deny.
 */
export type ApprovalAsk = { id: ApprovalId, context: string, 
/**
 * The process, as Twigo named it when it gave the process its token:
 * `Terminal 2`.
 */
process: string, 
/**
 * What the client says it runs, `kubectl apply`, from its own
 * `Kubectl-Command` header: a label, never checked.
 */
command: string | null, 
/**
 * The word a person reads in `"Allow Terminal 2 to <verb> <target>"`:
 * `exec` for `pods/exec` and `attach` for `pods/attach`, which RBAC
 * calls `create` or `get`, `evict` for `pods/eviction`, which RBAC calls
 * `create`, and RBAC's verb otherwise: `create`, `patch`, `delete`.
 */
verb: string, 
/**
 * `write` or `exec`.
 */
class: RequestClass, 
/**
 * As people and `kubectl` name it: `deployments/web in default`; a
 * create by the name its dry run stores, or its `generateName` and `…`
 * where the server generated that name, and by its path alone where no
 * dry run could say: `configmaps in default`; an exec, an attach or an
 * eviction by its pod alone, as `verb` says the rest:
 * `pods/web-1 in default`.
 */
target: string, 
/**
 * Whom the request acts as, from `kubectl --as`, `--as-group` and
 * `--as-uid`: the user and, when the request names them, the groups,
 * the uid and the extras, in one line: `x, groups system:masters`.
 */
impersonate: string | null, detail: ApprovalDetail, 
/**
 * Whether the context's name must be typed before it is allowed: a
 * delete's, a pod's eviction's among them.
 */
typed: boolean, 
/**
 * How long an answer of `lasting` holds, offered for a terminal's asks
 * but a delete's: every write and exec of this process on this context
 * for that long, deletes excepted. Any other process is allowed once.
 */
lastingMinutes: number | null, 
/**
 * Nobody has said what the context is: the person answers `mark` with
 * its type, or `deny`, and the request then meets the mode that type
 * gives, which may ask again.
 */
unmarked: boolean, };

/**
 * What Twigo could show of what the request would do.
 */
export type ApprovalDetail = { "kind": "diff", 
/**
 * Null for a create.
 */
live: unknown, result: unknown, 
/**
 * The server's `Warning` headers on the dry run; for a Secret or a
 * ConfigMap that holds a Helm release, one line of Twigo's in their
 * place, as they may quote its values or the release.
 */
warnings: Array<string>, } | { "kind": "session", container: string | null, command: Array<string>, tty: boolean, stdin: boolean, } | { "kind": "delete", propagation: string | null, } | { "kind": "unknown", reason: NoDiff, body: string | null, };

/**
 * What the broker tells a window.
 */
export type ApprovalEvent = { "event": "asked", ask: ApprovalAsk, } | { "event": "withdrawn", id: ApprovalId, };

export type ApprovalId = number;

export type Block = { "type": "fields", fields: Array<Field>, } | { "type": "conditions", conditions: Array<Condition>, } | { "type": "data", entries: Array<DataEntry>, 
/**
 * Whether [`GetValues`] sends their values: a ConfigMap's text
 * values, never a Secret's.
 */
readable: boolean, } | { "type": "tree", nodes: Array<TreeNode>, } | { "type": "events" } & EventList | { "type": "diagnostics", findings: Array<Finding>, } | { "type": "containers", containers: Array<Container>, } | { "type": "table", columns: Array<string>, rows: Array<Array<Value>>, } | { "type": "list" } & EmbeddedList;

/**
 * Why the gate stopped it.
 */
export type BlockReason = "mode" | "noGrant" | "noApproval" | "unmarked";

/**
 * A request the gate stopped before it left the process.
 */
export type Blocked = { context: string, mode: Mode, source: ModeSource, class: RequestClass, reason: BlockReason, 
/**
 * What it asked for, as RBAC names it: `create`, `get`, `proxy`.
 */
verb: string, 
/**
 * What it asked that of: `pods/web-1/exec in default`, or a path.
 */
target: string, };

export type Bucket = { 
/**
 * Every line in the span, warnings and errors included.
 */
lines: number, warnings: number, errors: number, };

export type BusyWhy = "inUse" | "notPermitted";

/**
 * What the catalog's sources list, and what they could not.
 */
export type Catalog = { contexts: Array<Context>, 
/**
 * Files that exist but could not be read or merged, whose contexts are
 * missing, and files whose changes go unseen.
 */
failures: Array<CatalogFailure>, };

export type CatalogFailure = { 
/**
 * The file, as a person names it: `~/.kube/config`.
 */
source: string, error: IpcError, };

export type Cell = null | boolean | number | number | string;

/**
 * What the API server says about itself, from `/version`.
 */
export type ClusterVersion = { 
/**
 * Such as `v1.33.4`.
 */
gitVersion: string, };

export type Column = { name: string, kind: ColumnKind, 
/**
 * 0 is shown by default; higher only in the wide view.
 */
priority: number, 
/**
 * Its text cells hold a duration the server printed, alone (`5m`) or
 * after a pod's count of restarts (`3 (5m ago)`), which counts back
 * from the row's `received`; absent where false, as for most columns.
 */
printsDuration?: boolean, };

export type ColumnKind = "string" | "integer" | "number" | "boolean" | "date" | "age" | "cpu" | "memory" | "other";

export type ColumnValues = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, values: Array<string>, };

/**
 * Two revisions of a release, for a comparison.
 */
export type CompareRevisions = { release: ReleaseRef, from: number, to: number, part: ComparedPart, };

export type ComparedPart = "values" | "defaults" | "manifest";

/**
 * The two sides masked as their views are, but that a masked value which
 * differs from its counterpart reads `<N bytes, before>` on the lower
 * revision's side and `<N bytes, after>` on the higher's, whichever is
 * `from`: values pair by their path, a manifest's Secrets by kind,
 * namespace and name, a Secret whose document writes no namespace in its
 * release's, and a key by the value the server would store,
 * `stringData`'s over `data`'s.
 */
export type ComparedRevisions = { from: string, to: string, };

export type Condition = { type: string, status: string, 
/**
 * Whether this status is good news, as Ready=True is and
 * MemoryPressure=True is not.
 */
tone: Tone, reason: string | null, message: string | null, 
/**
 * RFC 3339.
 */
lastTransition: string | null, 
/**
 * RFC 3339, when its reporter last confirmed it, as a node's kubelet
 * does.
 */
lastHeartbeat: string | null, 
/**
 * The Diagnostics section already says why it is wrong, so it shows
 * only as its chip.
 */
explained: boolean, };

export type Container = { name: string, role: ContainerRole, image: string, 
/**
 * None in a pod template, and until the kubelet reports it.
 */
state: ContainerState | null, 
/**
 * As kubectl prints them: `8080/TCP (http)`.
 */
ports: Array<string>, 
/**
 * What its card shows: how it ended, as its code and when, `Exited` for
 * a termination that is its state now, whose reason the state says, and
 * `Last exit`, with its reason, for an earlier one. Empty for a container
 * that never ended.
 */
fields: Array<Field>, 
/**
 * What else kubectl describe prints of it, folded: when it started, the
 * last termination's message, its requests and limits, command,
 * arguments, working directory, pull policy, probes, security, image and
 * container IDs.
 */
details: Array<Field>, 
/**
 * Each variable by name, then each source of many as "From".
 */
env: Array<Field>, 
/**
 * By the path it is mounted at.
 */
mounts: Array<Field>, };

export type ContainerRole = "init" | "sidecar" | "regular" | "ephemeral";

export type ContainerState = { 
/**
 * "Running", "Waiting · CrashLoopBackOff", "Terminated · Completed".
 */
text: string, tone: Tone, ready: boolean, 
/**
 * Its process runs, which a shell or an attach needs.
 */
running: boolean, restarts: number, };

export type ContainerUsage = { name: string, cpu: Measure, memory: Measure, };

/**
 * Which containers of each pod a session follows.
 */
export type Containers = { "type": "default" } | { "type": "named", name: string, } | { "type": "all" };

/**
 * A context the catalog lists.
 */
export type Context = { name: string, 
/**
 * From the `twigo` extension of the kubeconfig context; none by default.
 */
color: ContextColor | null, 
/**
 * The kubeconfig file that defines it, as a person names it:
 * `~/.kube/config`.
 */
source: string, 
/**
 * The URL of the cluster it reaches, only its scheme, host and port:
 * `https://10.0.0.1:6443`. None when the kubeconfig names no server
 * that parses.
 */
server: string | null, 
/**
 * Its mode, where the mode comes from and what it is marked as.
 */
access: ContextAccess, 
/**
 * The namespace the kubeconfig context names, which a new space of it
 * starts on; none when it names none.
 */
namespace: string | null, 
/**
 * Why no connection can be made, when the kubeconfig already says:
 * `context.empty`, `context.missing-cluster` or `context.missing-user`.
 */
problem: IpcError | null, };

/**
 * What a context lets through now, and why.
 */
export type ContextAccess = { 
/**
 * In force now: `guarded` while a `read-only` context is unlocked.
 */
mode: Mode, 
/**
 * Where the mode comes from, an unlock aside.
 */
source: ModeSource, 
/**
 * The person's type, else its kubeconfig's where that is a lock.
 */
environment: Environment | null, 
/**
 * When an unlock ends and the context relocks, in milliseconds since
 * the epoch.
 */
unlockedUntil: number | null, };

/**
 * How a context gets its credentials.
 */
export type ContextAuth = { "state": "none" } | { "state": "invalid", error: IpcError, } | { "state": "untrusted", plugin: ExecPlugin, } | { "state": "plugin", plugin: ExecPlugin, status: PluginStatus, };

export type ContextColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";

export type DataEntry = { key: string, bytes: number, 
/**
 * From `binaryData`, or a Secret value that is not UTF-8.
 */
binary: boolean, };

/**
 * What the webview tells the diagnostics log (ARCHITECTURE 4.10): an error
 * it caught or did not, which the log writes with the window's label.
 */
export type DiagnosticsEntry = { level: DiagnosticsLevel, message: string, stack: string | null, 
/**
 * What caught it: `error`, `unhandledrejection`, or the React root
 * option that did.
 */
source: string, };

export type DiagnosticsLevel = "error" | "warn" | "info";

/**
 * A context's resources as discovery last answered, or why it did not.
 * `cluster` names the cluster the context reaches: its URL, its
 * `tls-server-name` and the CAs it is trusted with.
 */
export type Discovered = { "state": "pending", cluster: string, } | { "state": "ready", cluster: string, resources: Array<Resource>, } | { "state": "failed", error: IpcError, };

export type DownloadLogs = { id: SubscriptionId, 
/**
 * The lines the view keeps, else every line the buffer holds.
 */
filtered: boolean, };

/**
 * A list of objects of one resource, run as any list is: the webview
 * subscribes with it in the object's space.
 */
export type EmbeddedList = { gvr: Gvr, 
/**
 * The kind of its objects, which opening a row names.
 */
kind: string, namespaced: boolean, 
/**
 * None for every namespace, as a node's pods are.
 */
namespace: string | null, fieldSelector: string | null, 
/**
 * As in [`crate::ListQuery`].
 */
owners: Array<string> | null, };

export type EnvVar = { name: string, value: string, };

/**
 * What a context is marked as, by a person, or by its kubeconfig where that
 * tightens: Production or Staging; a context nobody marked has none. It
 * sets the default mode and colour.
 */
export type Environment = "production" | "staging" | "development" | "local";

/**
 * Why something failed, named by a condition: `family.condition`.
 *
 * A wire name is written out for each code, so renaming a variant
 * never moves it, and once a release has shipped a code it is never
 * reused or removed: a code that no site builds any more stays, as a
 * report or an issue may still name it. The test `error_codes` pins
 * every name and kind.
 */
export type ErrorCode = "connect.refused" | "connect.unresolved" | "connect.timeout" | "connect.certificate" | "connect.tls" | "connect.proxy" | "connect.lost" | "connect.other" | "server.unauthorized" | "server.forbidden" | "server.not-found" | "server.conflict" | "server.invalid" | "server.timeout" | "server.unavailable" | "server.other" | "credentials.untrusted" | "credentials.plugin-missing" | "credentials.plugin-failed" | "credentials.plugin-timeout" | "credentials.plugin-cancelled" | "credentials.oidc-config" | "credentials.oidc-refresh" | "credentials.unusable" | "kubeconfig.unreadable" | "kubeconfig.unparsable" | "kubeconfig.unmergeable" | "kubeconfig.unwatched" | "context.not-listed" | "context.empty" | "context.missing-cluster" | "context.missing-user" | "context.invalid" | "context.no-plugin" | "policy.blocked" | "policy.file-unreadable" | "policy.file-sets-mode" | "policy.not-locked" | "policy.changed" | "protection.unreadable" | "protection.unsaved" | "protection.readable" | "protection.unmoved" | "answer.undecodable" | "discovery.not-aggregated" | "openapi.no-kind" | "openapi.not-listed" | "openapi.unreadable" | "environment.unresolved" | "forward.not-found" | "forward.invalid-port" | "forward.no-port" | "forward.unsupported-target" | "forward.port-in-use" | "forward.port-not-permitted" | "forward.listen-failed" | "forward.no-ready-pod" | "forward.port-refused" | "forward.waiting-for-slot" | "forward.cluster-unanswered" | "target.gone" | "state.set-aside" | "state.unsaved" | "state.reserved" | "state.not-json" | "space.not-found" | "trust.set-aside" | "trust.unsaved" | "audit.off" | "audit.unwritten" | "tokens.unsaved" | "file.unwritten" | "file.unrevealed" | "file.dialog-failed" | "file.not-local" | "internal.panic" | "internal.ipc" | "internal.request" | "action.object-changed" | "action.cluster-changed" | "action.mode-changed" | "action.kept-changing" | "action.no-change" | "action.unsupported-kind" | "action.paused" | "action.no-target" | "action.mixed-targets" | "action.unquotable" | "action.drain-refused" | "apply.invalid-edit" | "apply.masked-value" | "apply.wrong-target" | "apply.kind-not-served" | "apply.no-object" | "apply.integer-too-large" | "apply.other-version" | "undo.nothing" | "undo.ended" | "trigger.job-exists" | "bus.not-waiting" | "bus.preview-replaced" | "window.gone" | "subscription.not-found" | "app.quitting" | "approval.gone" | "approval.other-window" | "approval.unmarked" | "approval.marked" | "approval.once-only" | "confirm.name-mismatch" | "confirm.countdown" | "offer.gone" | "offer.other-window" | "offer.answering" | "offer.changed" | "offer.locked" | "offer.unmoved" | "session.started" | "session.busy" | "shell.no-container" | "shell.pod-not-running" | "terminal.start-failed" | "terminal.wait-failed" | "terminal.kubeconfig-path" | "logs.unsupported-target" | "logs.invalid-time" | "logs.no-previous" | "logs.stream-failed" | "filter.invalid-regex" | "filter.invalid-selector" | "object.not-listed" | "object.values-withheld" | "secret.not-a-secret" | "secret.no-key" | "helm.not-a-release" | "helm.truncated" | "helm.too-large" | "helm.revision-gone" | "helm.no-value" | "proxy.actor-refused" | "proxy.unbound" | "link.refused" | "link.open-failed" | "keyboard.unavailable" | "keyboard.not-found";

export type ErrorKind = "invalidInput" | "notFound" | "conflict" | "forbidden" | "unauthorized" | "permissions" | "timeout" | "unavailable" | "internal";

/**
 * An object's events, newest first.
 */
export type EventList = { events: Array<ObjectEvent>, 
/**
 * They have been listed, so that an empty list means there are none:
 * false while they are still coming, and once true it stays true,
 * whatever `unavailable` says of a later relist.
 */
listed: boolean, 
/**
 * Why they cannot be listed, as when the person may not list events;
 * None while they are listed or still coming.
 */
unavailable: IpcError | null, };

/**
 * An exec credential plugin as the kubeconfig names it (ARCHITECTURE 6.2).
 */
export type ExecPlugin = { command: string, args: Array<string>, env: Array<EnvVar>, 
/**
 * Identifies what the person trusts: the command, its arguments and
 * its environment.
 */
digest: string, 
/**
 * It may open a browser or print a device code, so it runs only while
 * a Twigo window has the focus.
 */
signsIn: boolean, };

/**
 * The plugins the kubeconfigs name that the person has not trusted, for
 * the review on the first start.
 */
export type ExecReview = { 
/**
 * The person has answered a review before, so a new plugin asks only
 * when it is about to run.
 */
reviewed: boolean, plugins: Array<ReviewedPlugin>, };

/**
 * Runs a plan, with what its friction asks for.
 */
export type Execute = { plan: PlanId, 
/**
 * What the person typed, for a `typed` friction.
 */
typed: string | null, };

/**
 * One thing the issue states about this run.
 */
export type Fact = { id: FactId, label: string, value: string, 
/**
 * Whether the person may leave it out of the issue.
 */
optional: boolean, };

export type FactId = "twigo" | "system" | "engine" | "kubernetes" | "lastPanic";

export type Field = { label: string, value: Value, 
/**
 * It holds the cluster's default, as a pod's Restart policy Always:
 * its section folds such fields behind their count.
 */
default: boolean, };

export type Finding = { 
/**
 * Danger for what keeps the object from working, warning for what
 * may.
 */
tone: Tone, 
/**
 * What is wrong: "Container api keeps crashing".
 */
title: string, 
/**
 * Why, as a sentence whose times are read when shown.
 */
detail: Array<Span>, 
/**
 * What the component that saw it said, shown as it said it: a
 * termination message, a waiting reason's message, an event's note.
 */
message: string | null, 
/**
 * A container's finding's logs, for its Previous logs and the last
 * line its previous instance wrote.
 */
logs: FindingLogs | null, };

export type FindingLogs = { container: string, 
/**
 * It has a previous instance, which a logs tab reads with `previous`.
 */
previous: boolean, 
/**
 * The last line of its instance that ended last, without its escapes,
 * once it has a previous one: null until Twigo has read it, or when it
 * wrote none.
 */
lastLine: string | null, };

export type Fold = "open" | "folded" | "finding";

export type Forward = { id: ForwardId, target: ForwardTarget, 
/**
 * The target's kind: `Service`.
 */
kind: string, 
/**
 * The target's port, as the start named it.
 */
port: number, portName: string | null, 
/**
 * The port's `appProtocol`, as the target declares it, so that the
 * webview can tell an HTTP port without another call.
 */
appProtocol: string | null, local: number, 
/**
 * The addresses its listeners were last bound on: `127.0.0.1`, and `::1`
 * where that bound. None for one that has not bound since the app
 * started: one restored stopped, or whose local port another process
 * held then. One stopped later keeps them and listens on none.
 */
addresses: Array<string>, state: ForwardState, 
/**
 * The pod new connections go to, once one is chosen.
 */
pod: string | null, 
/**
 * The pod's port they reach, once known.
 */
podPort: number | null, 
/**
 * Open TCP connections, those waiting for a session included.
 */
connections: number, 
/**
 * Of `connections`, those waiting for a place among the context's
 * sessions (ARCHITECTURE 3.2).
 */
queued: number, 
/**
 * Bytes to the pod and from it, since the app started.
 */
sent: number, received: number, 
/**
 * What the last connection that failed said, until a connection opened
 * after it carries bytes from the pod, or the forward is ready again
 * after not being so: a pod's port that refused, a pod whose upgrade
 * answered 404, no pod to go to within the wait, a cluster that did not
 * answer.
 */
failure: IpcError | null, };

export type ForwardEvent = { "event": "changed", forward: Forward, } | { "event": "removed", id: ForwardId, };

/**
 * Unique in the app and kept across restarts, as a `pf://` tab names it.
 */
export type ForwardId = number;

export type ForwardPort = { 
/**
 * What a start names: a Service's port, or a container's.
 */
port: number, name: string | null, 
/**
 * A Service's `targetPort` as written, a name or a number, when it is
 * not `port`.
 */
targetPort: string | null, 
/**
 * The container that declares it, for a pod or a workload.
 */
container: string | null, appProtocol: string | null, 
/**
 * The local port of this port's forward where it has one; else the one
 * a start takes when none is given: the one this port of this target
 * had last, else `port`, else, for a `port` below 1024, `port` plus
 * 8000.
 */
local: number, 
/**
 * The forward of this port, when the space has one, running or stopped.
 */
forward: ForwardId | null, };

/**
 * The TCP ports of a target, in the order of its spec.
 */
export type ForwardPorts = { 
/**
 * The target's kind, as its tab and its row say it: `Service`.
 */
kind: string, ports: Array<ForwardPort>, 
/**
 * The `port` a start without a choice takes: one whose name says HTTP
 * or web first, then the others in the spec's order, named or not, and
 * one whose name says metrics, health or debug last.
 */
default: number, };

export type ForwardStarted = { "outcome": "started", forward: Forward, } | { "outcome": "busy", local: number, why: BusyWhy, 
/**
 * The next port above `local` that was free on both loopbacks when
 * asked, from 1024 up.
 */
free: number, };

export type ForwardState = { "state": "starting" } | { "state": "restored" } | { "state": "ready" } | { "state": "reconnecting", reason: IpcError, } | { "state": "failed", error: IpcError, } | { "state": "stopped" };

/**
 * What a forward reaches: a pod, a Service, or a Deployment, ReplicaSet,
 * StatefulSet or DaemonSet.
 */
export type ForwardTarget = { space: string, gvr: Gvr, namespace: string, name: string, };

/**
 * What a person goes through before a plan runs, by what it risks and the
 * context's mode (ARCHITECTURE 6.4).
 */
export type Friction = { "kind": "atOnce" } | { "kind": "countdown", seconds: number, } | { "kind": "confirm" } | { "kind": "typed", text: string, };

/**
 * Asks for the values of a ConfigMap's keys, which its Overview lists with
 * their sizes only.
 */
export type GetValues = { id: SubscriptionId, keys: Array<string>, };

/**
 * The rows grouped by the text of a column: the groups in the natural
 * order of their values, runs of ASCII digits by their value and ASCII
 * letters folded, the empty value last, and the rows of each group in
 * the query's sort.
 */
export type Grouping = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, 
/**
 * The values of the groups the window skips. Their rows still count
 * in `total`, in `counts` and in their group's `rows`; a value no
 * group has does nothing.
 */
collapsed: Array<string>, };

export type Gvr = { 
/**
 * Empty for the core group.
 */
group: string, version: string, resource: string, };

/**
 * What the object's page says around its name and under its views, the
 * same in the inspector and on the full page.
 */
export type Header = { 
/**
 * The controller at the top of its owners: a pod's Deployment through
 * its ReplicaSet, a Job's CronJob. The direct controller while the one
 * above it is not listed; None without a controller.
 */
owner: ObjectRef | null, 
/**
 * The node a pod is bound to; None before it is scheduled, and for
 * other kinds.
 */
node: string | null, 
/**
 * RFC 3339, `metadata.creationTimestamp`: the object's age, which an
 * object opened on its own has no list row to take it from.
 */
created: string | null, 
/**
 * Where the generated part of its name starts, in UTF-16 units, as a
 * list row's [`generated`](crate::Row::generated) says it, so that an
 * object opened on its own cuts its name as the list does. The core
 * fills it: the rule lives with the rows.
 */
generated: number | null, 
/**
 * The cells the server prints for it in a list, Name, Namespace and Age
 * left out, from which the page takes the word of its list's health
 * column, so the two always say the same.
 */
printed: Array<Printed>, 
/**
 * One sentence after that word: the first finding's title, else the
 * object's vitals in words; empty when neither says anything.
 */
sentence: Array<Span>, 
/**
 * The strip under the views, in order; empty for a kind without one.
 * A pod's CPU and Memory are not among them: they come with its usage.
 */
vitals: Array<Vital>, };

/**
 * A secret-grade part of a revision, which a Reveal shows.
 */
export type HelmPart = { "kind": "values", 
/**
 * The chart's defaults, not the person's values.
 */
defaults: boolean, path: Array<ValueStep>, } | { "kind": "secret", document: number, items: Array<number>, key: string, } | { "kind": "document", document: number, } | { "kind": "manifest" } | { "kind": "notes" } | { "kind": "description" };

/**
 * How many times the redaction hid each kind of thing in the log.
 */
export type Hidden = { 
/**
 * Contexts, clusters, servers, users, namespaces, objects, the account
 * and emails, each as an alias.
 */
names: number, paths: number, tokens: number, 
/**
 * URLs and addresses other than loopback.
 */
addresses: number, 
/**
 * Double-quoted strings.
 */
quoted: number, 
/**
 * Lines of the file that were not records, which the log shows as a
 * placeholder, never as their text.
 */
lines: number, };

/**
 * The view's lines over time, its range aside, in equal spans from `from`
 * to `to`; no spans while the buffer holds no line.
 */
export type Histogram = { 
/**
 * RFC 3339, or empty without spans.
 */
from: string, 
/**
 * RFC 3339, or empty without spans.
 */
to: string, buckets: Array<Bucket>, };

/**
 * The error every command returns, and every state that holds a failure.
 *
 * `code` names the condition and is what a person reads, searches and
 * copies, and what a test holds; `kind` is its class, derived from it,
 * which retries, sign-ins and refusals branch on; `message` is for people
 * and is never matched. The core branches on `kind`, the webview on `code`
 * where one condition matters and on `kind` where a class does.
 */
export type IpcError = { code: ErrorCode, kind: ErrorKind, message: string, 
/**
 * With `permissions`: the mode and its source, when the gate stopped a
 * request.
 */
blocked?: Blocked, 
/**
 * With a request the API server answered: its status, as data.
 */
server?: ServerStatus, };

/**
 * The characters one key types; empty where it types none.
 */
export type KeyMapping = { value: string, withShift: string, 
/**
 * With Option on macOS.
 */
withAltGr: string, withShiftAltGr: string, };

/**
 * What each key of the active keyboard layout types (ARCHITECTURE 5.2).
 * WebKit has no Keyboard Map API, so the keybinding service learns the
 * layout from Rust.
 */
export type KeyboardLayout = { 
/**
 * The OS's name for the layout: the input source ID on macOS, such as
 * `com.apple.keylayout.Ukrainian`, the XKB layout name on Linux, such as
 * `Ukrainian`, and the keyboard layout handle (HKL) in hex on Windows.
 */
id: string, 
/**
 * The writing-system keys, by `KeyboardEvent.code` (`KeyA`, `Slash`).
 */
keys: { [key in string]: KeyMapping }, };

/**
 * Names of a kubeconfig's entries, by section.
 */
export type KubeconfigNames = { contexts: Array<string>, clusters: Array<string>, users: Array<string>, };

/**
 * Entries a tool wrote into a terminal's own kubeconfig, such as `aws eks
 * update-kubeconfig` does, offered for moving into the user's kubeconfig.
 */
export type KubeconfigOffer = { id: KubeconfigOfferId, 
/**
 * How many times the offer of this id was sent again with a change;
 * an answer names the revision it answers.
 */
revision: number, 
/**
 * The terminal's label.
 */
terminal: string, 
/**
 * The id `terminal_create` answered for the terminal, which finds its
 * tab where labels repeat: every space has its own `Terminal 1`.
 */
session: SubscriptionId, 
/**
 * The context the terminal was pinned to.
 */
context: string, contexts: Array<string>, clusters: Array<string>, users: Array<string>, 
/**
 * The user's file a move writes to, the one kubectl writes new entries
 * to, as a person reads it: `~/.kube/config`.
 */
target: string, 
/**
 * What a move leaves out: a name the user's files hold in its section,
 * a context whose cluster or user means another entry there, and a
 * cluster or user that only such contexts name.
 */
leftOut: KubeconfigNames, };

export type KubeconfigOfferAnswer = "move" | "dismiss";

export type KubeconfigOfferEvent = { "event": "offered", offer: KubeconfigOffer, } | { "event": "withdrawn", id: KubeconfigOfferId, } | { "event": "direct", session: SubscriptionId, contexts: Array<string>, };

export type KubeconfigOfferId = number;

export type Label = { key: string, value: string, };

export type Level = "trace" | "debug" | "info" | "warn" | "error";

export type LevelFilter = "all" | "warn" | "error";

/**
 * One flush of a subscription. Rust sends the next batch only after the
 * webview acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type ListBatch = { seq: number, 
/**
 * The number of the view this batch reflects: that of the last
 * [`SetView`] the list had taken when it built the batch, 0 before any.
 * Several changes that arrive while a batch waits for its ack are taken
 * together, so a batch may skip the numbers between.
 */
view: number, 
/**
 * Rows matching the query, in or out of the window, those of collapsed
 * groups included.
 */
total: number, 
/**
 * Present in the first batch and whenever the server's columns change.
 */
columns: Array<Column> | null, 
/**
 * Present when the window's rows or their order changed. The view keeps
 * exactly these rows.
 */
window: Window | null, 
/**
 * Rows that entered the window or changed.
 */
upserts: Array<Row>, 
/**
 * The state of the rows the list shows: the least ready of the parts
 * whose rows it holds, a part that has listed and waits for a watch
 * counting as `stale`. While it holds no part's rows, the least ready
 * of the parts still on their way, one whose first list broke off
 * counting as `connecting`, and once none is, the worst refusal. So
 * `ready`, `relisting` and `stale` say that some part's rows are shown.
 */
status: ViewState, 
/**
 * Present in the first batch and whenever a part's state changes.
 */
parts?: Parts, 
/**
 * With `count_by`: the matching rows per value of that column, present
 * in the first batch and whenever a count changes.
 */
counts: Array<ValueCount> | null, 
/**
 * With `group_by`: the groups that hold matching rows, in group order,
 * present once the list has the column and whenever a group appears,
 * disappears or moves, or its rows or counts change. Empty once the
 * list no longer has the column.
 */
groups: Array<RowGroup> | null, 
/**
 * For a list with metric columns: whether their samples arrive,
 * present once a scope has answered or failed, and whenever it
 * changes. Before a scope has answered, a list says the failure its
 * last request ended in, if the core remembers one, so its first batch
 * that shows rows has it, and the first answers correct it; with none
 * remembered it says none, but for a stale API, which says
 * `unavailable` with the columns. It keeps the state it said while its
 * scopes are asked again.
 */
metrics: MetricsState | null, };

export type ListQuery = { space: string, gvr: Gvr, 
/**
 * Whether the resource lives in namespaces, as discovery says: one
 * that does not ignores `namespaces`, and one that does gets a
 * Namespace column unless `namespaces` names one.
 */
namespaced: boolean, 
/**
 * Empty for every namespace where the person may list the resource:
 * the cluster's when they may list it cluster-wide, else each one a
 * review allows among the namespaces they may list. A person who may
 * list neither gets the cluster's refusal.
 */
namespaces: Array<string>, labelSelector: string | null, 
/**
 * Sent to the server, as `spec.nodeName=kind-control-plane` picks a
 * node's pods.
 */
fieldSelector: string | null, 
/**
 * Keeps the rows whose controller is one of the objects with these
 * uids, as a workload's pods are its ReplicaSets'; empty keeps none.
 */
owners: Array<string> | null, 
/**
 * A substring of a shown cell in any case of ASCII letters, `!` before
 * it to keep the rows without one, or a regex between slashes, also in
 * any case: `/^web-\d+/`, negated as `!/…/`.
 */
text: string | null, 
/**
 * The user's column choices by name, which the text filter follows
 * besides Name: true shows a column, false hides it, and the rest show
 * by priority 0. The server resolves them against its own columns, so
 * a choice for a column the list lacks, such as Namespace under one
 * namespace, does nothing. Null shows the columns of priority 0.
 */
columns: { [key in string]: boolean } | null, 
/**
 * Null, or a column the list lacks, sorts by Name.
 */
sort: Sort | null, 
/**
 * A column to count the matching rows by, such as a pod's Status; one
 * the list lacks counts nothing.
 */
countBy: string | null, 
/**
 * A column to group the matching rows by; one the list lacks groups
 * nothing.
 */
groupBy: Grouping | null, 
/**
 * Keeps the rows whose column holds one of the values, read as text.
 * The counts of `count_by` come before it, so the values it drops keep
 * theirs; a column the list lacks keeps every row.
 */
values: ColumnValues | null, };

/**
 * A mode that a kubeconfig, a provider or a type gives, which can only
 * tighten a context.
 */
export type Lock = { mode: Mode, source: LockSource, };

/**
 * Where a lock comes from.
 */
export type LockSource = { "kind": "kubeconfig" } | { "kind": "provider" } | { "kind": "environment", environment: Environment, };

/**
 * The entry a [`LogWindow::Around`] was asked around, and where it
 * stands: at its index while the view keeps it, else where it would
 * stand if the view kept it.
 */
export type LogAround = { id: number, 
/**
 * An index into the view's entries, as [`LogEntries::start`].
 */
index: number, };

/**
 * One flush of a session. Rust sends the next only after the webview
 * acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type LogBatch = { seq: number, 
/**
 * The target's: whether its pods are listed, may be read, or are gone.
 */
status: ViewState, 
/**
 * Present in the first batch and whenever a pod, a container or a
 * stream's state changes.
 */
pods: Array<LogPod> | null, 
/**
 * Entries the view keeps, in or out of the window.
 */
total: number, 
/**
 * Present when the window's entries changed; the view keeps exactly
 * these.
 */
window: LogEntries | null, 
/**
 * Present when the search, or what it matches, changed; empty without
 * a search.
 */
matches: LogMatches | null, 
/**
 * Present when it changed.
 */
histogram: Histogram | null, 
/**
 * Entries the buffer's bound dropped since the session opened
 * (ARCHITECTURE 4.6).
 */
dropped: number, 
/**
 * Entries the view has kept as they came since the session opened or
 * its source or view last changed, a count that only grows meanwhile:
 * a paused list counts the new ones by it, since `total` stops growing
 * at the bound.
 */
arrived: number, 
/**
 * The source and view changes the session has applied since it
 * opened, a no-op among them, so the webview knows which of those it
 * sent `arrived` and the window already reflect.
 */
changes: number, };

export type LogContainer = { name: string, stream: StreamState, };

export type LogEntries = { 
/**
 * An index into the view's entries, as in [`LogWindow::Range`].
 */
start: number, entries: Array<LogEntry>, 
/**
 * Where the entry of a [`LogWindow::Around`] stands, so the webview
 * tells the answer to the window it asked for from an earlier one,
 * and places an entry the view no longer keeps; absent for the other
 * windows.
 */
around: LogAround | null, };

/**
 * Every entry has an `id`, which stays its own while the buffer holds it,
 * so the webview keeps its place as entries enter and leave before it.
 */
export type LogEntry = { "type": "line", id: number, pod: string, container: string, 
/**
 * RFC 3339 with nanoseconds, as the kubelet stamps the line.
 */
time: string, level: Level | null, 
/**
 * Without its ANSI escapes.
 */
text: string, 
/**
 * What its ANSI escapes styled.
 */
styles: Array<TextStyle>, 
/**
 * The search's matches.
 */
marks: Array<TextRange>, } | { "type": "ended", id: number, pod: string, container: string, 
/**
 * RFC 3339.
 */
time: string, exitCode: number | null, reason: string | null, 
/**
 * RFC 3339, when the kubelet starts it again, in a crash loop's
 * back-off. The kubelet tells it only once the back-off's waiting
 * state shows, so a later batch fills it in under the same id.
 */
restarting: string | null, } | { "type": "joined", id: number, pod: string, 
/**
 * RFC 3339.
 */
time: string, 
/**
 * What controls the pod, by its controller owner reference: a
 * Deployment's pod's ReplicaSet, a CronJob's pod's Job.
 */
owner: ObjectRef | null, } | { "type": "left", id: number, pod: string, 
/**
 * RFC 3339.
 */
time: string, } | { "type": "dropped", id: number, count: number, };

export type LogMatches = { 
/**
 * Every match in the view.
 */
count: number, 
/**
 * The id of each match's entry, in the view's order, so an entry with
 * two matches comes twice: the last 10,000 matches, since a search
 * steps back from the newest. Ids, unlike indices, stay as entries
 * enter and leave, so the webview finds a match outside its window
 * by asking for the window around it.
 */
entries: Array<number>, };

export type LogPod = { name: string, 
/**
 * Where the generated part of its name starts, as a row's
 * [`generated`](crate::Row::generated).
 */
generated: number | null, 
/**
 * As the pod list's Status column has it: Running, CrashLoopBackOff.
 */
status: string, tone: Tone, containers: Array<LogContainer>, };

/**
 * What a session reads from the cluster; a change reopens its streams.
 */
export type LogSource = { containers: Containers, 
/**
 * The pods to follow, by name; null follows the target's pods, new
 * ones included, as long as the tab's ten streams last (ARCHITECTURE 4.6).
 */
pods: Array<string> | null, since: Since, 
/**
 * Each container's previous instance, the one that ended, read to its
 * end rather than followed.
 */
previous: boolean, };

/**
 * What a logs tab follows: a pod, or a Deployment, ReplicaSet,
 * StatefulSet, DaemonSet, Job or CronJob, whose pods it merges and whose
 * new pods join it, as a rollout's do.
 */
export type LogTarget = { space: string, gvr: Gvr, namespace: string, name: string, };

export type LogVerbosity = "info" | "debug" | "trace";

/**
 * How a session shows its buffer; a change filters it again in Rust and
 * reopens nothing.
 */
export type LogView = { level: LevelFilter, 
/**
 * Keeps the lines whose text matches, in the list filter's syntax: a
 * substring in any case of ASCII letters, `!` before it to keep the
 * lines without one, or a regex between slashes, also in any case,
 * negated as `!/…/`.
 */
filter: string | null, 
/**
 * Marks the matches in the text of the lines the view keeps: a
 * substring in any case of ASCII letters, or a regex between slashes,
 * also in any case.
 */
search: string | null, 
/**
 * Keeps the lines from `from` to `to`, picked on the histogram.
 */
range: TimeRange | null, };

/**
 * The lines of the view a window reads, markers included.
 */
export type LogWindow = { "type": "tail", count: number, } | { "type": "range", start: number, end: number, } | { "type": "around", id: number, before: number, after: number, };

/**
 * A Secret of a manifest, at the root of its document or inside a List's
 * `items`.
 */
export type ManifestSecret = { 
/**
 * The document's index among those Helm's split gives, from 0.
 */
document: number, 
/**
 * The indexes through `items` from the document to the Secret; empty
 * for a Secret that is the document.
 */
items: Array<number>, name: string, namespace: string | null, 
/**
 * The line of `text` its document starts at, from 1.
 */
line: number, 
/**
 * Its keys of `data` and `stringData` with their sizes, a key in both
 * once, as `stringData`'s, which the server writes over `data`.
 */
entries: Array<DataEntry>, };

/**
 * One resource, in nanocores for CPU and bytes for memory.
 */
export type Measure = { 
/**
 * Null without a sample.
 */
used: number | null, 
/**
 * A container's request, or a pod's when every container counted in
 * `used` has one.
 */
request: number | null, 
/**
 * A container's limit, or a pod's when every container counted in
 * `used` has one.
 */
limit: number | null, 
/**
 * A node's allocatable.
 */
allocatable: number | null, };

/**
 * What the Metrics API of a context answers. A context that does not
 * serve it has no metric columns and no usage, and so no state, but for
 * the one `Absent` says to an open object.
 */
export type MetricsState = "ready" | "unavailable" | "forbidden" | "absent";

/**
 * How much a context lets through (ARCHITECTURE 6.4). Rust owns it, and the
 * webview only shows it.
 */
export type Mode = "read-write" | "guarded" | "read-only";

/**
 * Where a context's mode comes from, highest first (ARCHITECTURE 6.4).
 */
export type ModeSource = { "kind": "unlisted" } | { "kind": "moved" } | { "kind": "policyFile", file: string, pattern: string | null, reason?: string, } | { "kind": "protectionUnreadable", file: string, reason: string, } | { "kind": "user", overrides: Lock | null, } | { "kind": "kubeconfig" } | { "kind": "provider" } | { "kind": "environment", environment: Environment, } | { "kind": "unmarked" };

/**
 * A terminal to start for `context`.
 */
export type NewTerminal = { context: string, 
/**
 * What its asks and its offers call it, as its tab does: `Terminal 2`.
 */
label: string, };

/**
 * Why a write has no diff.
 */
export type NoDiff = { "reason": "subresource" } | { "reason": "aggregated" } | { "reason": "unverified" } | { "reason": "refused", error: IpcError, } | { "reason": "notAResource" };

/**
 * One flush of an open object. Rust sends the next only after the webview
 * acknowledged this one's `seq`, and coalesces changes meanwhile.
 */
export type ObjectBatch = { seq: number, status: ViewState, 
/**
 * False until the object is listed, and once it is deleted.
 */
exists: boolean, 
/**
 * Present when it changed, while the overview part is shown.
 */
overview: Overview | null, 
/**
 * The object's JSON with managedFields dropped and a Secret's values
 * replaced by their sizes; present when it changed, while the manifest
 * part is shown.
 */
manifest: string | null, 
/**
 * Present when they changed, while the events part is shown.
 */
events: EventList | null, 
/**
 * Present when it changed, while the related part is shown.
 */
related: Related | null, 
/**
 * Present when it changed, while the usage part is shown, for a pod
 * or a node of a context that serves the Metrics API: in the batch that
 * brings the object once the context's discovery is known, else in a
 * later one, which the usual order of events, resources first, makes
 * rare; and in the next one when the part is asked for later. Until the
 * scope that serves the object has answered once it is `waiting`, or
 * says the failure its last request ended in, or `unavailable` where the
 * API is stale; after that a `ready` usage whose `used` is null says
 * that an answer came without the object, with the containers that run
 * listed all the same. An object that had an answer keeps its figures
 * while the request that serves it is asked anew.
 */
usage: Usage | null, };

export type ObjectEvent = { 
/**
 * Normal or Warning.
 */
type: string, reason: string, message: string, 
/**
 * The component that reported it.
 */
source: string, 
/**
 * How often it happened; 1 for a single event.
 */
count: number, 
/**
 * RFC 3339.
 */
first: string | null, 
/**
 * RFC 3339.
 */
last: string | null, 
/**
 * The part of the object it is about, such as `spec.containers{app}`.
 */
fieldPath: string | null, };

/**
 * What the views of an open object ask for; Rust follows only these. The page
 * asks for the Overview on every view, so that its header and its keys hold on
 * all of them. It asks for the events and the related objects only while their
 * view is shown, for the manifest while the YAML view is shown or, in an
 * editor, an edit is held, and for the usage only of a pod or a node, on the
 * Overview, in a visible window.
 */
export type ObjectParts = { 
/**
 * The Overview document, its events included: Rust watches the object's
 * events for as long as it is asked, whichever view is shown.
 */
overview: boolean, 
/**
 * The object as the YAML tab shows it, while that view is shown or an
 * edit is held.
 */
manifest: boolean, 
/**
 * The object's events as the Events tab lists them, while that view is
 * shown.
 */
events: boolean, 
/**
 * Its owners and the objects it owns, while the Related tab is shown.
 */
related: boolean, 
/**
 * What a pod or a node uses, read while the Overview is shown and the
 * document is visible.
 */
usage: boolean, };

/**
 * Names one object of a space.
 */
export type ObjectQuery = { space: string, gvr: Gvr, 
/**
 * Whether the resource lives in namespaces, as discovery says.
 */
namespaced: boolean, 
/**
 * None for a cluster-scoped object.
 */
namespace: string | null, name: string, };

/**
 * An object a link points at, by kind: the webview finds its resource
 * through discovery.
 */
export type ObjectRef = { 
/**
 * Empty for the core group.
 */
group: string, version: string, kind: string, 
/**
 * The namespace of the object that points at it, which the webview
 * drops when discovery says the kind is cluster-scoped.
 */
namespace: string | null, name: string, };

/**
 * The new issue's form, filled with the ticked facts; with no facts it is
 * the bare template.
 */
export type OpenIssue = { 
/**
 * The ids of the facts the person left ticked: Rust states them again
 * from this run, so only what it wrote goes in the link.
 */
facts: Array<FactId>, };

/**
 * Rust sends nothing of the lines until the webview sets a window.
 */
export type OpenLogs = { target: LogTarget, source: LogSource, view: LogView, };

export type OpenObject = { object: ObjectQuery, parts: ObjectParts, };

export type OpenRelease = { release: ReleaseRef, 
/**
 * The revision to show; null follows the latest.
 */
revision: number | null, parts: ReleaseParts, };

/**
 * Starts the session a plan's run answered with.
 */
export type OpenShell = { id: SubscriptionId, cols: number, rows: number, };

/**
 * The object as it was opened, which an edit is measured against. Its
 * `lock` is apart from `base`: "Keep mine" after a change on the server
 * diffs against the old base and locks to the new version, since diffing
 * against the new live object would revert the other writer's change.
 */
export type OpenedEdit = { target: ResourceRef, 
/**
 * The object as the webview received it: without managedFields, a
 * Secret's values masked.
 */
base: unknown, 
/**
 * The `resourceVersion` to hold the apply to.
 */
lock: string, 
/**
 * The object as it stood at `lock`, when that is not `base`: "Keep
 * mine" locks to a newer version than the one edited, and this is what
 * says a later status write changed nothing.
 */
locked?: unknown, };

/**
 * How a running plan goes, over its channel; every kind but `running` is
 * the last.
 */
export type OperationEvent = { "state": "running", text: string, } | { "state": "done", text: string, undoUntil: number | null, } | { "state": "stopped", text: string, } | { "state": "revealed", value: string, binary: boolean, } | { "state": "session", id: SubscriptionId, 
/**
 * Whether the process has a terminal: a shell's always does, an
 * attach's as its container's spec says.
 */
tty: boolean, 
/**
 * Whether what is typed reaches the process, as `tty` goes.
 */
stdin: boolean, } | { "state": "failed", error: IpcError, };

/**
 * An object described for people: what its header says, then sections in
 * their order, each a list of blocks from a closed set (ARCHITECTURE 4.3).
 */
export type Overview = { header: Header, sections: Array<Section>, };

/**
 * What one part reads. A webview that meets a kind it does not know
 * counts the part without naming it.
 */
export type Part = { "kind": "cluster" } | { "kind": "namespace", name: string, };

export type PartState = { part: Part, state: ViewState, 
/**
 * Its rows are in the list: it has listed and is not refused.
 */
shown: boolean, };

/**
 * The upstreams a list reads: one for the cluster, or one per namespace
 * (ARCHITECTURE 3.7). A part's rows are in the list once it has listed and
 * while it is not refused, whatever the other parts are.
 */
export type Parts = { count: number, 
/**
 * The parts that are not ready, each with its own state.
 */
unready: Array<PartState>, 
/**
 * For every namespace, the namespaces it leaves out because the person
 * may not list the resource there; 0 for a selection, or for a
 * cluster-wide part.
 */
omitted: number, };

/**
 * What a command will do, for the person to confirm. It runs only by its
 * id, once, on the cluster it was planned for.
 */
export type Plan = { id: PlanId, 
/**
 * The context it acts on, none for what acts on no context, as
 * starting over from the person's protection file.
 */
context: PlanContext | null, friction: Friction, 
/**
 * The question a dialog asks, naming the cluster: `Delete pod web-1
 * from kind-a?`
 */
question: string, 
/**
 * What the confirming button says: `Delete pod`.
 */
confirm: string, 
/**
 * Whether it takes something away for good, which its button shows.
 */
destructive: boolean, 
/**
 * What follows, a sentence each.
 */
consequences: Array<string>, 
/**
 * The exact objects it acts on and those that follow, by what happens
 * to them.
 */
affected: Array<Affected>, 
/**
 * The kubectl or helm command that does the same; none for what only
 * Twigo does, such as a change of a context's mode.
 */
commandLine: string | null, 
/**
 * What a toast or the status bar says while it counts down or runs:
 * `Deleting pod web-1`.
 */
doing: string, };

/**
 * The context a plan acts on, with its type and mode as it was planned.
 */
export type PlanContext = { name: string, environment: Environment | null, mode: Mode, };

export type PlanId = number;

/**
 * What a person asks a command to do.
 */
export type PlanRequest = { "action": "delete", space: string, targets: Array<ResourceRef>, } | { "action": "scale", space: string, target: ResourceRef, replicas: number, } | { "action": "restart", space: string, target: ResourceRef, } | { "action": "cordon", space: string, node: string, unschedulable: boolean, } | { "action": "drain", space: string, node: string, } | { "action": "trigger", space: string, namespace: string, name: string, } | { "action": "suspend", space: string, target: ResourceRef, suspend: boolean, } | { "action": "undo", space: string, } | { "action": "reveal", object: SubscriptionId, key: string, } | { "action": "revealHelm", release: SubscriptionId, revision: number, part: HelmPart, } | { "action": "apply", space: string, preview: PreviewId, } | { "action": "shell", target: ShellTarget, kind: ShellKind, } | { "action": "setMode", context: string, mode: Mode | null, } | { "action": "setEnvironment", context: string, environment: Environment | null, } | { "action": "unlock", context: string, } | { "action": "startOver" };

export type PluginStatus = { "state": "idle" } | { "state": "waiting" } | { "state": "running", 
/**
 * When the run started, RFC 3339.
 */
since: string, output: string, } | { "state": "ready", 
/**
 * RFC 3339; none when the credential lasts until the cluster
 * rejects it.
 */
expires: string | null, } | { "state": "failed", error: IpcError, output: string, 
/**
 * The kubeconfig's `installHint`, when the command was not found.
 */
installHint: string | null, };

/**
 * What a preview prepared, kept in Rust for the window that asked until a
 * plan takes it (`PlanRequest::Apply`) or the window goes; a newer preview
 * of the same object replaces it.
 */
export type PreviewId = number;

/**
 * A cell the server printed for an object, as text.
 */
export type Printed = { column: string, value: string, };

/**
 * Why a terminal goes through the policy proxy.
 */
export type ProxyWhy = "mode" | "provider" | "policyFile";

export type Related = { owners: Array<RelatedObject>, owned: Array<RelatedObject>, 
/**
 * Why some owned objects cannot be listed.
 */
unavailable: IpcError | null, };

export type RelatedObject = { target: ObjectRef, 
/**
 * The owner reference that ties them is the controller's.
 */
controller: boolean, };

/**
 * One flush of an open release. Rust sends the next only after the webview
 * acknowledged this one's `seq`, and coalesces changes meanwhile; a part is
 * present when it changed, while it is asked for.
 */
export type ReleaseBatch = { seq: number, 
/**
 * The state of the Secrets of the release's namespace, as a list's.
 */
status: ViewState, 
/**
 * False until a revision is listed, and once none is left, as after an
 * uninstall without `--keep-history`.
 */
exists: boolean, 
/**
 * The revision the parts are of: the one asked for, else the latest.
 * Null until its page is read or the read fails, and again from when
 * the Secret of the one shown goes until the next page is read or the
 * read fails, whether the release follows the latest or the revision
 * was pinned and Helm still keeps it; a pinned revision Helm no longer
 * keeps is named at once, with `helm.revision-gone`, while Helm keeps
 * another revision of the release, and null once it keeps none.
 */
revision: number | null, 
/**
 * The highest revision Helm keeps, which `helm get` reads.
 */
latest: number | null, 
/**
 * The highest revision Helm keeps below `revision`, from the labels of
 * its Secrets, which Compare with Previous compares it with; null where
 * it keeps none, as after `--history-max` pruned the ones before, and
 * where Helm no longer keeps `revision` itself (`helm.revision-gone`).
 */
previous: number | null, 
/**
 * Why the shown revision cannot be read; its parts are null then. What
 * its Secret holds says it until the Secret changes, in exactly these
 * codes: `helm.not-a-release`, `helm.truncated`, `helm.too-large`,
 * `internal.panic` for a decode that panicked, and `helm.revision-gone`
 * for a revision Helm no longer keeps. Any other code is a request that
 * failed, such as `server.forbidden`, `server.unavailable`,
 * `connect.refused` or `answer.undecodable` for an answer Twigo could
 * not read, which says nothing of the revision and stays only while it
 * fails for that version of the Secret: Rust asks again after the hub's
 * backoff, a refusal after the hub's pause for RBAC's no, and at every
 * relist.
 */
problem: IpcError | null, 
/**
 * Described as an object's is: a header whose `printed` are the release
 * row's cells and whose `created` is the revision's `last_deployed`, then
 * sections (Diagnostics, Objects, Hooks, Chart, Metadata). With the
 * overview part.
 */
overview: Overview | null, 
/**
 * The rendered NOTES.txt; empty for a chart without one. With the
 * overview part.
 */
notes: Scrubbed | null, 
/**
 * What Helm wrote of the revision, such as `Upgrade complete` or the
 * error a failed one ended in. With the overview part.
 */
description: Scrubbed | null, values: ReleaseValues | null, manifest: ReleaseManifest | null, 
/**
 * Newest first.
 */
history: Array<RevisionLine> | null, };

/**
 * The releases of a space's namespaces, one row a release, which is its
 * latest revision: Name and Revision from the labels Helm sets on its
 * Secrets, Status from the `status` label until that revision is decoded and
 * the release's own after, as `helm list` prints it, or `unreadable` where
 * what the revision's Secret holds cannot be read, and Chart
 * (`name-version`), App Version and Updated once that revision is decoded.
 * Helm writes a revision's Secret again when its status changes: until the
 * new version is decoded, Chart, App Version and Updated stay and Status is
 * the label's. Updated is an `age` column that reads the row's `created`,
 * the revision's `info.last_deployed`; Problem holds the wire name of the
 * code that keeps the revision from being read, as
 * [`ReleaseBatch::problem`] tells them, and is empty when it is read: a
 * request that fails keeps the label's Status. Its batches are
 * [`ListBatch`](crate::ListBatch)es, and `list_set_window`, `list_set_view`,
 * `list_ack` and `list_unsubscribe` serve it.
 */
export type ReleaseListQuery = { space: string, 
/**
 * As in [`ListQuery`](crate::ListQuery), for the namespaces where the
 * person may list Secrets.
 */
namespaces: Array<string>, 
/**
 * As in [`ListQuery`](crate::ListQuery) from here on.
 */
text: string | null, columns: { [key in string]: boolean } | null, sort: Sort | null, countBy: string | null, groupBy: Grouping | null, values: ColumnValues | null, };

/**
 * A revision's manifest as `helm get manifest` prints it, but each document
 * that holds a Secret written again with its values as their sizes and only
 * its `# Source:` comment kept, and each document Twigo could not read
 * replaced by its `# Source:` line and a line that says so. Hooks are not in
 * it, as they are not in Helm's.
 */
export type ReleaseManifest = { text: string, 
/**
 * In the order they stand.
 */
secrets: Array<ManifestSecret>, 
/**
 * In the order they stand.
 */
unread: Array<UnreadDocument>, };

/**
 * What the views of an open release ask for; Rust decodes and sends only
 * these.
 */
export type ReleaseParts = { 
/**
 * The shown revision's overview, notes and description, on every view.
 */
overview: boolean, 
/**
 * Its values, the person's and the chart's defaults, while the Values
 * view is shown.
 */
values: boolean, 
/**
 * Its manifest, while the Manifest view is shown.
 */
manifest: boolean, 
/**
 * A line for each revision Helm keeps, while History is shown.
 */
history: boolean, };

/**
 * One release: the namespace of its Secrets and its name.
 */
export type ReleaseRef = { space: string, namespace: string, name: string, };

/**
 * A revision's values as JSON text, in the stored order of their keys: keys,
 * booleans and nulls as Helm stored them, every string and number as
 * `<N bytes>`, N the length of its text in UTF-8, a number's as stored.
 */
export type ReleaseValues = { 
/**
 * What the person set, as `helm get values -o json` prints it: `null`
 * when they set nothing.
 */
user: string, 
/**
 * The chart's defaults as the release stores them, its subcharts' merged
 * in at install.
 */
defaults: string, };

/**
 * What "Report a Problem" shows (ARCHITECTURE 4.10): facts for the issue and
 * the log to paste, both redacted in Rust, which the webview never gets
 * unredacted.
 */
export type Report = { facts: Array<Fact>, 
/**
 * The last lines of the log as text, one record each, with what a
 * panic's record holds below it.
 */
log: string, hidden: Hidden, };

/**
 * What the gate takes a request for (ARCHITECTURE 6.4).
 */
export type RequestClass = "read" | "dryRun" | "write" | "secretRead" | "forward" | "exec";

/**
 * A resource the space's clusters serve, from discovery: what the explorer
 * lists and what `:` in quick access resolves names against (ARCHITECTURE 4.5).
 */
export type Resource = { gvr: Gvr, kind: string, singular: string, shortNames: Array<string>, namespaced: boolean, 
/**
 * Its subresources as discovery names them: `status`, `scale`.
 */
subresources: Array<string>, };

/**
 * An object of a space, by its resource as discovery names it.
 */
export type ResourceRef = { gvr: Gvr, namespaced: boolean, 
/**
 * None for a cluster-scoped object.
 */
namespace: string | null, name: string, };

/**
 * Starts a forward again, on `local` when that names another port. A
 * stopped one binds its port and a failed one proves again, both
 * `Starting`. One that waits, starts, is ready or reconnects keeps its state
 * and its connections, and forgets the pods it avoided, so that its next
 * choice may take one that answered 404. One that its context's mode
 * refuses, or whose context no source lists, answers that error and stays as
 * it was: stopped, or failed with the refusal, on its port.
 */
export type ResumeForward = { id: ForwardId, local: number | null, };

export type ReviewedPlugin = { plugin: ExecPlugin, 
/**
 * The contexts that use it.
 */
contexts: Array<string>, };

/**
 * A revision as `helm history` prints it.
 */
export type RevisionLine = { revision: number, 
/**
 * Helm's word: `deployed`, `superseded`, `failed`, `pending-upgrade`…,
 * the label's until the revision is decoded, then the release's, which
 * `helm history` prints where the two differ; `unreadable` where what
 * its Secret holds cannot be read, as a list's row says it, and the
 * label's while a request for it fails.
 */
status: string, 
/**
 * RFC 3339, `info.last_deployed`; null until decoded.
 */
updated: string | null, 
/**
 * `name-version`; null until decoded.
 */
chart: string | null, appVersion: string | null, description: Scrubbed | null, 
/**
 * The revision a rollback restored, as Helm 4.3 and later record it.
 */
rollbackOf: number | null, 
/**
 * Why it cannot be read, as [`ReleaseBatch::problem`] says.
 */
problem: IpcError | null, };

export type Row = { id: RowId, 
/**
 * RFC 3339; the webview renders Age columns from it.
 */
created: string | null, 
/**
 * RFC 3339; when the core received the print of the durations in the
 * columns that say `printsDuration`, such as `3 (5m ago)`, which count
 * back from this time, so the webview draws them as of now. It moves
 * when such a duration reads another age, or the same one after its
 * step (an event that repeated), and a list sorted by those columns
 * reads it too.
 */
received: string, 
/**
 * Where the generated part of the object's name starts, in UTF-16
 * units: after its `metadata.generateName`, or at a pod's
 * `pod-template-hash` within it, so `api-7f9c8d6b5-x2kq9` reads `api-`
 * before what was generated. Null for a name the API server did not
 * generate.
 */
generated: number | null, 
/**
 * One per column; null in Age columns.
 */
cells: Array<Cell>, };

export type RowGroup = { 
/**
 * The column's text; empty for the rows that have none.
 */
value: string, 
/**
 * The group's matching rows, collapsed or not.
 */
rows: number, 
/**
 * With `count_by`: the group's rows per value of that column, counted
 * before `values` drops any and ordered as the list's counts are,
 * largest first; empty without it.
 */
counts: Array<ValueCount>, };

/**
 * `context/namespace/name`, or `context/name` for cluster-scoped objects.
 */
export type RowId = string;

/**
 * The text the person sees, to save to a file they choose.
 */
export type SaveReport = { text: string, };

/**
 * Names a kind of the cluster a space reaches.
 */
export type SchemaQuery = { space: string, 
/**
 * Empty for the core group.
 */
group: string, version: string, kind: string, };

/**
 * A text with every value of the revision's Secrets that stands in it as a
 * whole token replaced by `<hidden>`, but a value shorter than four
 * characters or with no letter or digit, which stays, as it cannot be told
 * from the numbers, the words and the punctuation around it.
 */
export type Scrubbed = { text: string, 
/**
 * Something was replaced, which a Reveal of the whole text shows.
 */
hidden: boolean, };

export type Section = { 
/**
 * Stable, such as `core.metadata`; folding is kept by it.
 */
id: string, title: string, 
/**
 * What its header says at its end, so that it answers while folded,
 * such as `2 volumes · 1 claim`; empty where nothing would.
 */
summary: Array<Span>, 
/**
 * Danger or warning when it holds what is wrong with the object, which
 * its header marks with an edge in that tone.
 */
tone: Tone | null, 
/**
 * How it opens until the person folds or opens it.
 */
fold: Fold, blocks: Array<Block>, };

/**
 * One cause of an `Invalid` status, as kubectl prints it: `field: message`.
 */
export type ServerCause = { reason: string, 
/**
 * `spec.replicas`; empty when the cause names no field.
 */
field: string, message: string, };

/**
 * What the API server said of a request it refused, beside Twigo's own
 * code. The reason is the server's, an open set that an aggregated API or
 * a webhook may answer any string for, so it is never a Twigo code.
 */
export type ServerStatus = { 
/**
 * The `reason` of the `Status`: `Forbidden`, `AlreadyExists`, `Invalid`;
 * empty when the server gave none.
 */
reason: string, causes: Array<ServerCause>, };

/**
 * How much Twigo's own crates write to the diagnostics log until Twigo
 * quits; the libraries stay at warnings.
 */
export type SetLogLevel = { level: LogVerbosity, };

export type SetLogSource = { id: SubscriptionId, source: LogSource, };

export type SetLogView = { id: SubscriptionId, view: LogView, };

export type SetLogWindow = { id: SubscriptionId, window: LogWindow, };

export type SetParts = { id: SubscriptionId, parts: ObjectParts, };

export type SetReleaseView = { id: SubscriptionId, 
/**
 * The revision to show; null follows the latest.
 */
revision: number | null, parts: ReleaseParts, };

/**
 * Changes the view of a list in place: the fields of [`ListQuery`] that
 * choose which of the list's rows show, in which order and how they are
 * counted and grouped. A change of anything else in a query, the space, the
 * resource, the namespaces, the selectors or the owners, is a new
 * subscription.
 */
export type SetView = { id: SubscriptionId, 
/**
 * The number of this view, which the webview counts up from 1: the
 * query the list subscribed with is view 0. The first batch that
 * reflects this view carries it in [`ListBatch::view`], so the webview
 * knows which rows answer which query.
 */
view: number, text: string | null, columns: { [key in string]: boolean } | null, sort: Sort | null, countBy: string | null, groupBy: Grouping | null, values: ColumnValues | null, };

/**
 * `start` and `end` index the rows a window reads: every matching row,
 * or with `group_by` those of the groups not collapsed, in group order.
 */
export type SetWindow = { id: SubscriptionId, start: number, 
/**
 * Exclusive.
 */
end: number, 
/**
 * Whether the list reads its metric columns now, which takes the
 * document visible, the list's editor on screen, and the list not one
 * inside an Overview narrower than 640 px, which always says false.
 * Before the list's columns are known it says true, so that a list
 * sorted by a metric is held from its first rows; once they are known,
 * while a metric column is drawn or sorted by. Only then are the
 * namespaces of the window's rows polled (ARCHITECTURE 3.6).
 */
metrics: boolean, };

/**
 * How many bytes of output the terminal has parsed since the last ack.
 */
export type ShellAck = { id: SubscriptionId, bytes: number, };

/**
 * The containers of a pod a shell can reach, those that run.
 */
export type ShellContainers = { containers: Array<string>, 
/**
 * The one its `kubectl.kubernetes.io/default-container` annotation
 * names, when that one runs, else the first of `containers`.
 */
default: string, };

/**
 * Why a session ended; none can resume, as an exec cannot.
 */
export type ShellEnd = { "reason": "exited", code: number, } | { "reason": "signaled", signal: string, } | { "reason": "detached" } | { "reason": "noShell", message: string, } | { "reason": "failed", error: IpcError, } | { "reason": "connectionLost" } | { "reason": "relocked" };

/**
 * Where the login shell's environment stands (ARCHITECTURE 6.1).
 */
export type ShellEnvironment = { "state": "resolving" } | { "state": "resolved" } | { "state": "failed", 
/**
 * The shell's path, such as `/bin/zsh`.
 */
shell: string, 
/**
 * What went wrong, worded to follow the shell's path: `did not answer in 10 s`.
 */
reason: IpcError, 
/**
 * The end of what the shell printed, the environment left out.
 */
output: string, };

/**
 * How a session goes; `ended` comes last, after all the output of a process
 * that ended. A session cut short by `relocked`, or by a `connectionLost`
 * from a wake, a moved route or replaced clients, sends only the output it
 * had gathered.
 */
export type ShellEvent = { "state": "queued" } | { "state": "connecting" } | { "state": "running" } | { "state": "ended", end: ShellEnd, };

/**
 * What the person typed or pasted, in the order the webview sends it, one
 * call at a time.
 */
export type ShellInput = { id: SubscriptionId, data: Array<number>, };

export type ShellKind = "shell" | "attach";

/**
 * What a session's channel carries: its output as bytes, and its events.
 * Only TypeScript reads this type, which Rust sends as two kinds of body.
 */
export type ShellMessage = ArrayBuffer | ShellEvent;

/**
 * A pod a shell may be opened in.
 */
export type ShellPod = { space: string, namespace: string, pod: string, };

export type ShellResize = { id: SubscriptionId, cols: number, rows: number, };

export type ShellTarget = { space: string, namespace: string, pod: string, container: string, };

/**
 * Where each container's lines start.
 */
export type Since = { "type": "lines", lines: number, } | { "type": "seconds", seconds: number, } | { "type": "start" };

export type Sort = { 
/**
 * A column name from [`ListBatch::columns`].
 */
column: string, descending: boolean, };

/**
 * A workbench space: one context or a group of them (ARCHITECTURE 4.2).
 */
export type Space = { id: string, name: string, 
/**
 * The names of its contexts; the catalog's `Context` says the rest,
 * as long as a source lists it.
 */
contexts: Array<string>, };

export type Span = { "type": "text", text: string, } | { "type": "ago", at: string, } | { "type": "until", at: string, };

export type StartForward = { target: ForwardTarget, 
/**
 * A `port` of the target's [`ForwardPorts`].
 */
port: number, 
/**
 * None takes the port's `local`.
 */
local: number | null, };

/**
 * UI state that is not settings (ARCHITECTURE 4.8), such as a space's
 * layout or the command history. The value is JSON that the webview writes
 * and reads back; the core checks only that it is JSON.
 */
export type StateEntry = { 
/**
 * The space it belongs to; none for the whole app.
 */
space: string | null, key: string, value: string, };

/**
 * Every stored value, read once as the webview starts.
 */
export type StateSnapshot = { app: { [key in string]: string }, 
/**
 * By space id.
 */
spaces: { [key in string]: { [key in string]: string } }, };

export type StreamState = { "state": "off" } | { "state": "overLimit" } | { "state": "queued" } | { "state": "connecting" } | { "state": "following" } | { "state": "ended" } | { "state": "waiting", reason: string | null, } | { "state": "error", error: IpcError, };

export type SubscriptionId = number;

/**
 * How a terminal reaches clusters, which its tab shows.
 */
export type TerminalKind = { "kind": "kubeconfig" } | { "kind": "proxy", why: ProxyWhy, };

/**
 * A parked terminal, which starts once `shell_open` names it.
 */
export type TerminalSession = { id: SubscriptionId, kind: TerminalKind, 
/**
 * The shell's file name: `zsh`.
 */
shell: string, 
/**
 * Whether Twigo sets `KUBECONFIG` again after the shell's startup
 * files, as it does for zsh, bash, fish and pwsh; for another shell a
 * startup file that sets it replaces the terminal's.
 */
kubeconfigKept: boolean, };

/**
 * Indexes a line's text in UTF-16 units; `end` is exclusive.
 */
export type TextRange = { start: number, end: number, };

/**
 * A run of text an ANSI escape styled; 256 and true colours come as the
 * nearest of the sixteen.
 */
export type TextStyle = { range: TextRange, fg: AnsiColor | null, bg: AnsiColor | null, bold: boolean, dim: boolean, italic: boolean, underline: boolean, };

/**
 * RFC 3339; `to` is exclusive.
 */
export type TimeRange = { from: string, to: string, };

export type Tone = "neutral" | "success" | "warning" | "danger";

export type TreeNode = { 
/**
 * A map's key, or a list item's name, else its index.
 */
key: string, 
/**
 * The key as people read it: a field's name in words, such as
 * "Termination grace period seconds"; other keys as they are.
 */
label: string, value: TreeValue, };

export type TreeValue = { "type": "scalar", text: string, } | { "type": "map", entries: Array<TreeNode>, } | { "type": "list", items: Array<TreeNode>, };

export type UnreadDocument = { document: number, 
/**
 * The line of `text` it stands at, from 1.
 */
line: number, 
/**
 * The path its `# Source:` comment names, if it has one.
 */
source: string | null, };

/**
 * What a pod or a node uses, from the sample its list's rows show.
 */
export type Usage = { state: MetricsState, 
/**
 * True in a usage sent before the request that serves the object has
 * answered once: the state is `ready`, the figures are null, and
 * `containers` names the pod's running containers by its own status,
 * in the order the answer lists them and with their requests and
 * limits, so the webview draws the section at its height at once; an
 * answer that comes without the pod lists them as well, with `waiting`
 * false. False for a stale API, which says `unavailable` at once since
 * discovery knows it without a request, and for a scope whose last
 * request failed, which says that failure at once and is asked all the
 * same.
 */
waiting: boolean, 
/**
 * RFC 3339, when the sample was taken; null without one, as for a
 * pod that is not running or started a moment ago.
 */
sampled: string | null, 
/**
 * A pod's sum over its containers, or the node's own figures.
 */
cpu: Measure, memory: Measure, 
/**
 * A ready usage lists every container that runs by the pod's own status
 * and every one that has a sample, in the pod's order, each with its
 * request and limit; `used` is null for one the answer lacks, as for a
 * container that has just started or restarted, whose pod metrics-server
 * leaves out while any of its containers has no earlier point. Empty for
 * a node and for a usage that is not ready.
 */
containers: Array<ContainerUsage>, };

export type Value = { "type": "text", text: string, } | { "type": "time", at: string, } | { "type": "link", target: ObjectRef, text: string, } | { "type": "labels", labels: Array<Label>, } | { "type": "list", items: Array<Value>, } | { "type": "code", text: string, } | { "type": "toned", text: string, tone: Tone, } | { "type": "spans", spans: Array<Span>, };

export type ValueCount = { value: string, count: number, };

/**
 * A map's key or a list's index.
 */
export type ValueStep = string | number;

/**
 * The state of a subscription, or of one part of a list (ARCHITECTURE 3.7).
 */
export type ViewState = { "state": "queued" } | { "state": "connecting", 
/**
 * The last failure that may pass, which each retry meets.
 */
cause?: IpcError, } | { "state": "syncing", loaded: number, } | { "state": "ready" } | { "state": "relisting" } | { "state": "stale", 
/**
 * The last failure that may pass, which each retry meets.
 */
cause?: IpcError, } | { "state": "forbidden", verb: string, resource: string, } | { "state": "unauthorized" } | { "state": "error", error: IpcError, };

/**
 * One cell of the vitals strip, such as `Restarts` `4` `11 d ago`.
 */
export type Vital = { label: string, 
/**
 * Toned only when it is abnormal.
 */
value: Value, 
/**
 * What follows the value, quieter, such as when a pod last restarted.
 */
note: Array<Span>, };

export type Window = { 
/**
 * An index into the rows the window reads, as in [`SetWindow`].
 */
start: number, ids: Array<RowId>, };

export type Commands = {
  spaces_list: { request: null; response: Array<Space>; message: null };
  contexts_watch: { request: null; response: Catalog; message: Catalog };
  context_relock: { request: string; response: null; message: null };
  command_plan: { request: PlanRequest; response: Plan; message: null };
  command_execute: { request: Execute; response: null; message: OperationEvent };
  command_cancel: { request: PlanId; response: null; message: null };
  access_review: { request: AccessQuery; response: Array<boolean>; message: null };
  apply_preview: { request: ApplyRequest; response: ApplyPreviewed; message: null };
  space_open: { request: string; response: Space; message: null };
  resources_watch: { request: string; response: null; message: Discovered };
  namespaces_list: { request: string; response: Array<string>; message: null };
  cluster_version: { request: string; response: ClusterVersion; message: null };
  list_subscribe: { request: ListQuery; response: SubscriptionId; message: ListBatch };
  list_set_window: { request: SetWindow; response: null; message: null };
  list_set_view: { request: SetView; response: null; message: null };
  list_ack: { request: Ack; response: null; message: null };
  list_unsubscribe: { request: SubscriptionId; response: null; message: null };
  object_open: { request: OpenObject; response: SubscriptionId; message: ObjectBatch };
  object_set_parts: { request: SetParts; response: null; message: null };
  object_ack: { request: Ack; response: null; message: null };
  object_values: { request: GetValues; response: Array<string | null>; message: null };
  object_close: { request: SubscriptionId; response: null; message: null };
  helm_list_subscribe: { request: ReleaseListQuery; response: SubscriptionId; message: ListBatch };
  helm_release_open: { request: OpenRelease; response: SubscriptionId; message: ReleaseBatch };
  helm_release_set_view: { request: SetReleaseView; response: null; message: null };
  helm_release_ack: { request: Ack; response: null; message: null };
  helm_release_close: { request: SubscriptionId; response: null; message: null };
  helm_compare: { request: CompareRevisions; response: ComparedRevisions; message: null };
  schema_get: { request: SchemaQuery; response: string; message: null };
  shell_containers: { request: ShellPod; response: ShellContainers; message: null };
  shell_open: { request: OpenShell; response: null; message: ShellMessage };
  shell_input: { request: ShellInput; response: null; message: null };
  shell_resize: { request: ShellResize; response: null; message: null };
  shell_ack: { request: ShellAck; response: null; message: null };
  shell_close: { request: SubscriptionId; response: null; message: null };
  terminal_create: { request: NewTerminal; response: TerminalSession; message: null };
  kubeconfig_offers_watch: { request: null; response: Array<KubeconfigOffer>; message: KubeconfigOfferEvent };
  kubeconfig_offer_answer: { request: AnswerKubeconfigOffer; response: null; message: null };
  forward_ports: { request: ForwardTarget; response: ForwardPorts; message: null };
  forward_start: { request: StartForward; response: ForwardStarted; message: null };
  forward_stop: { request: ForwardId; response: null; message: null };
  forward_resume: { request: ResumeForward; response: ForwardStarted; message: null };
  forward_remove: { request: ForwardId; response: null; message: null };
  forwards_watch: { request: null; response: Array<Forward>; message: ForwardEvent };
  logs_open: { request: OpenLogs; response: SubscriptionId; message: LogBatch };
  logs_set_source: { request: SetLogSource; response: null; message: null };
  logs_set_view: { request: SetLogView; response: null; message: null };
  logs_set_window: { request: SetLogWindow; response: null; message: null };
  logs_ack: { request: Ack; response: null; message: null };
  logs_download: { request: DownloadLogs; response: string | null; message: null };
  logs_close: { request: SubscriptionId; response: null; message: null };
  keyboard_layout_watch: { request: null; response: KeyboardLayout; message: KeyboardLayout };
  state_load: { request: null; response: StateSnapshot; message: null };
  state_set: { request: Array<StateEntry>; response: null; message: null };
  problems_watch: { request: null; response: Array<IpcError>; message: Array<IpcError> };
  shell_environment_watch: { request: null; response: ShellEnvironment; message: ShellEnvironment };
  shell_environment_retry: { request: null; response: null; message: null };
  context_auth_watch: { request: string; response: ContextAuth; message: ContextAuth };
  context_sign_in: { request: string; response: null; message: null };
  context_sign_in_cancel: { request: string; response: null; message: null };
  exec_review: { request: null; response: ExecReview; message: null };
  exec_trust: { request: Array<string>; response: null; message: null };
  approvals_watch: { request: null; response: null; message: ApprovalEvent };
  approval_answer: { request: AnswerApproval; response: null; message: null };
  url_open: { request: string; response: null; message: null };
  diagnostics_log: { request: DiagnosticsEntry; response: null; message: null };
  log_reveal: { request: null; response: null; message: null };
  log_level_set: { request: SetLogLevel; response: null; message: null };
  report_problem: { request: null; response: Report; message: null };
  report_open_issue: { request: OpenIssue; response: null; message: null };
  report_save: { request: SaveReport; response: string | null; message: null };
};
