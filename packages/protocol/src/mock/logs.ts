import { IpcError } from "../error";
import type {
  LogBatch,
  LogPod,
  LogSource,
  LogTarget,
  LogView,
  LogWindow,
  StreamState,
  ViewState,
} from "../generated";
import {
  deploymentOf,
  generatedAt,
  hash,
  mulberry32,
  type Cluster,
  type Pod,
} from "./cluster";
import { LogBuffer, type Kind, type Timed } from "./logview/buffer";
import { level } from "./logview/level";
import { parse } from "./logview/line";
import {
  entries,
  histogram,
  judge,
  keeps,
  matches,
  rfc3339,
  spec,
  total,
  type Spec,
} from "./logview/view";

/** A tab's streams (ARCHITECTURE 4.6) and the cluster's followed logs (3.2). */
export const TAB_STREAMS = 10;
export const CLUSTER_STREAMS = 32;
const TICK_MS = 100;
/** How often a workload's tab sees one of its pods replaced, as in a rollout. */
const ROLLOUT_MS = 25_000;
/** The recorded pods' first container is `api`, so a finding's logs reach a mock stream. */
const NAMES = ["api", "istio-proxy", "log-shipper"];

interface Stream {
  readonly pod: Pod;
  readonly container: string;
  readonly random: () => number;
  /** When it writes its next line, in ms. */
  next: number;
  /** A crash loop's place in its cycle of lines, and when it starts again. */
  cycle: number;
  restartAt: number | undefined;
}

/**
 * A logs tab of the mock backend: the target's pods write realistic lines,
 * JSON, logfmt, klog and ANSI among them, as the kubelet sends them, a
 * crash-looping pod crashes, and `logview` reads, buffers and shows them
 * as Rust does.
 */
export class MockLogs {
  readonly #target: LogTarget;
  readonly #cluster: Cluster | undefined;
  readonly #onMessage: (batch: LogBatch) => void;
  readonly #budget: (logs: MockLogs, wanted: number) => number;
  #source: LogSource;
  #spec: Spec;
  #window: LogWindow | undefined;
  readonly #buffer = new LogBuffer();
  #streams = new Map<string, Stream>();
  #members = new Set<string>();
  /** The entries the view kept as they came since the source or the view last changed. */
  #arrived = 0;
  #seq = 0;
  #unacked: number | undefined;
  #dirty = { pods: true, lines: true };
  #rolledAt = Date.now();
  #timer: ReturnType<typeof setInterval>;

  /** `budget` grants the session some of the cluster's followed logs. */
  constructor(
    target: LogTarget,
    source: LogSource,
    view: LogView,
    cluster: Cluster | undefined,
    budget: (logs: MockLogs, wanted: number) => number,
    onMessage: (batch: LogBatch) => void,
  ) {
    this.#target = target;
    this.#cluster = cluster;
    this.#source = source;
    this.#spec = spec(view);
    this.#budget = budget;
    this.#onMessage = onMessage;
    this.#start(Date.now());
    this.#timer = setInterval(() => {
      this.#tick(Date.now());
    }, TICK_MS);
  }

  /** The streams it holds open, which the cluster's budget counts. */
  get streams(): number {
    return this.#streams.size;
  }

  setSource(source: LogSource): void {
    this.#source = source;
    this.#buffer.clear();
    this.#arrived = 0;
    this.#streams.clear();
    this.#members.clear();
    this.#start(Date.now());
  }

  /** Refuses a view whose filter, search or range does not parse, as Rust does. */
  setView(view: LogView): void {
    this.#spec = spec(view);
    this.#buffer.judge((kind) => judge(this.#spec, kind));
    this.#arrived = 0;
    this.#dirty.lines = true;
  }

  setWindow(window: LogWindow): void {
    this.#window = window;
    this.#dirty.lines = true;
  }

  ack(seq: number): void {
    if (this.#unacked === seq) this.#unacked = undefined;
  }

  close(): void {
    clearInterval(this.#timer);
  }

  /** The target's pods, as the cluster has them now. */
  #pods(): Pod[] {
    const { gvr, namespace, name } = this.#target;
    const pods = this.#cluster?.pods ?? [];
    const inNamespace = pods.filter((pod) => pod.namespace === namespace);
    switch (`${gvr.group}/${gvr.resource}`) {
      case "/pods":
        return inNamespace.filter((pod) => pod.name === name);
      case "apps/deployments":
        return inNamespace.filter((pod) => deploymentOf(pod) === name);
      case "apps/replicasets":
        return inNamespace.filter((pod) => pod.generateName === `${name}-`);
      case "apps/statefulsets":
      case "apps/daemonsets":
      case "batch/jobs":
      case "batch/cronjobs":
        return inNamespace.filter((pod) => pod.name.startsWith(`${name}-`));
      default:
        throw new IpcError(
          "invalidInput",
          `logs follow pods and workloads, not ${gvr.resource}`,
        );
    }
  }

  /** The containers of each pod the source picks. */
  #chosen(pod: Pod): string[] {
    const names = NAMES.slice(0, pod.containers);
    const { containers, pods } = this.#source;
    if (pods !== null && !pods.includes(pod.name)) return [];
    switch (containers.type) {
      case "default":
        return names.slice(0, 1);
      case "named":
        return names.filter((each) => each === containers.name);
      case "all":
        return names;
    }
  }

  #start(now: number): void {
    const since = this.#source.since;
    const from =
      since.type === "seconds" ? now - since.seconds * 1000 : now - 3_600_000;
    const incoming: Timed[] = [];
    for (const pod of this.#pods()) {
      this.#members.add(pod.name);
      for (const container of this.#chosen(pod)) {
        if (this.#streams.size >= TAB_STREAMS) break;
        const stream = this.#stream(pod, container, from);
        if (!writes(pod)) continue;
        const lines: Timed[] = [];
        while (stream.next < now) lines.push(...this.#write(stream));
        const kept = this.#source.previous
          ? lastInstance(lines)
          : since.type === "lines"
            ? lines.slice(-since.lines)
            : lines;
        incoming.push(...kept);
        if (this.#source.previous) {
          const end = kept[kept.length - 1]?.[0] ?? nanos(now - 2000);
          incoming.push(this.#ended(stream, end + 1_000_000n));
          this.#streams.delete(key(pod.name, container));
        }
      }
    }
    this.#insert(incoming);
    this.#dirty = { pods: true, lines: true };
  }

  #stream(pod: Pod, container: string, from: number): Stream {
    const random = mulberry32(hash(`${pod.name}/${container}`));
    const stream: Stream = {
      pod,
      container,
      random,
      next: from + random() * 3000,
      cycle: 0,
      restartAt: undefined,
    };
    this.#streams.set(key(pod.name, container), stream);
    return stream;
  }

  #tick(now: number): void {
    if (!this.#source.previous) this.#follow(now);
    const window = this.#window;
    if (this.#unacked !== undefined || window === undefined) return;
    if (!this.#dirty.lines && !this.#dirty.pods) return;
    this.#send(window);
  }

  /** Writes what each stream wrote since the last tick, and follows the target's pods as they come and go. */
  #follow(now: number): void {
    this.#rollOut(now);
    const at = nanos(now);
    const incoming: Timed[] = [];
    const current = new Set(this.#pods().map((pod) => pod.name));
    for (const name of this.#members) {
      if (current.has(name)) continue;
      this.#members.delete(name);
      for (const [id, stream] of this.#streams) {
        if (stream.pod.name === name) this.#streams.delete(id);
      }
      incoming.push([at, { type: "left", pod: name, time: rfc3339(at) }]);
      this.#dirty.pods = true;
    }
    for (const pod of this.#pods()) {
      if (this.#members.has(pod.name)) continue;
      this.#members.add(pod.name);
      incoming.push([
        at,
        {
          type: "joined",
          pod: pod.name,
          time: rfc3339(at),
          owner: {
            group: "apps",
            version: "v1",
            kind: "ReplicaSet",
            namespace: pod.namespace,
            name: pod.generateName.slice(0, -1),
          },
        },
      ]);
      for (const container of this.#chosen(pod)) {
        if (this.#streams.size < TAB_STREAMS) this.#stream(pod, container, now);
      }
      this.#dirty.pods = true;
    }
    const granted = this.#budget(this, this.#streams.size);
    let followed = 0;
    for (const stream of this.#streams.values()) {
      if (followed++ >= granted || !writes(stream.pod)) continue;
      if (stream.restartAt !== undefined) {
        if (now < stream.restartAt) continue;
        stream.restartAt = undefined;
        this.#dirty.pods = true;
      }
      while (stream.next < now) {
        const written = this.#write(stream);
        incoming.push(...written);
        if (written.some(([, kind]) => kind.type === "ended")) break;
      }
    }
    this.#insert(incoming);
  }

  /** Now and then replaces a pod the tab follows, so a workload's tab shows a rollout. */
  #rollOut(now: number): void {
    if (this.#target.gvr.resource === "pods" || !this.#cluster) return;
    if (now - this.#rolledAt < ROLLOUT_MS) return;
    this.#rolledAt = now;
    const followed = [...this.#streams.values()].map((stream) => stream.pod);
    const pod = followed[Math.floor(Math.random() * followed.length)];
    if (pod) this.#cluster.rollOut(pod, now);
  }

  #insert(incoming: readonly Timed[]): void {
    if (incoming.length === 0) return;
    const checked = this.#spec;
    this.#buffer.insert(incoming, (at, kind) => {
      const judged = judge(checked, kind);
      if (keeps(checked, at, judged)) this.#arrived++;
      return judged;
    });
    this.#dirty.lines = true;
  }

  /** The stream's next entries: a line, or a crash loop's crash and its end. */
  #write(stream: Stream): Timed[] {
    const at = stream.next;
    const { random } = stream;
    stream.next = at + 200 + random() * random() * 4000;
    if (stream.pod.status === "CrashLoopBackOff") {
      const step = CRASH[stream.cycle];
      stream.cycle = (stream.cycle + 1) % (CRASH.length + 1);
      if (step === undefined) {
        const ended = this.#ended(stream, nanos(at));
        stream.restartAt = at + 40_000;
        stream.next = stream.restartAt;
        this.#dirty.pods = true;
        return [ended];
      }
      stream.next = at + 300 + random() * 900;
      return [read(stream, kubelet(at, step))];
    }
    return [read(stream, kubelet(at, fill(template(random), random)))];
  }

  #ended(stream: Stream, at: bigint): Timed {
    return [
      at,
      {
        type: "ended",
        pod: stream.pod.name,
        container: stream.container,
        time: rfc3339(at),
        exitCode: 1,
        reason: "Error",
        restarting: this.#source.previous
          ? null
          : rfc3339(at + 40_000_000_000n),
      },
    ];
  }

  #send(window: LogWindow): void {
    const buffer = this.#buffer;
    const checked = this.#spec;
    this.#seq++;
    this.#unacked = this.#seq;
    const status: ViewState = { state: "ready" };
    this.#onMessage({
      seq: this.#seq,
      status,
      pods: this.#dirty.pods ? this.#logPods() : null,
      total: total(buffer, checked),
      window: entries(buffer, checked, window),
      matches: matches(buffer, checked),
      histogram: histogram(buffer),
      dropped: buffer.droppedEver,
      arrived: this.#arrived,
    });
    this.#dirty = { pods: false, lines: false };
  }

  #logPods(): LogPod[] {
    const granted = this.#budget(this, this.#streams.size);
    const order = [...this.#streams.keys()];
    return this.#pods().map((pod) => ({
      name: pod.name,
      generated: generatedAt(pod.name, pod.generateName, {
        "pod-template-hash": pod.templateHash,
      }),
      status: pod.status,
      tone:
        pod.status === "Running" || pod.status === "Completed"
          ? "neutral"
          : pod.status === "Pending" || pod.status === "ContainerCreating"
            ? "warning"
            : "danger",
      containers: NAMES.slice(0, pod.containers).map((name) => ({
        name,
        stream: this.#state(pod, name, order, granted),
      })),
    }));
  }

  #state(
    pod: Pod,
    container: string,
    order: string[],
    granted: number,
  ): StreamState {
    const id = key(pod.name, container);
    const stream = this.#streams.get(id);
    if (!stream) {
      if (this.#source.previous && this.#chosen(pod).includes(container))
        return { state: "ended" };
      return this.#chosen(pod).includes(container)
        ? { state: "overLimit" }
        : { state: "off" };
    }
    if (order.indexOf(id) >= granted) return { state: "queued" };
    if (!writes(pod)) return { state: "waiting", reason: pod.status };
    if (stream.restartAt !== undefined)
      return { state: "waiting", reason: "CrashLoopBackOff" };
    return { state: "following" };
  }
}

/** A container's previous instance: its lines from the last start a crash loop wrote, without the end that followed. */
function lastInstance(entries: readonly Timed[]): Timed[] {
  const last = (from: number, test: (kind: Kind) => boolean) => {
    for (let at = from - 1; at >= 0; at--) {
      const entry = entries[at];
      if (entry && test(entry[1])) return at;
    }
    return -1;
  };
  const ended = last(entries.length, (kind) => kind.type === "ended");
  const end = ended < 0 ? entries.length : ended;
  const start = last(
    end,
    (kind) => kind.type === "line" && kind.text === CRASH[0],
  );
  return entries.slice(Math.max(0, start), end);
}

function key(pod: string, container: string): string {
  return `${pod}/${container}`;
}

/** A pod that waits to start writes nothing. */
function writes(pod: Pod): boolean {
  return pod.status !== "Pending" && pod.status !== "ContainerCreating";
}

/** Unix milliseconds, fractions included, in nanoseconds. */
function nanos(ms: number): bigint {
  const whole = Math.floor(ms);
  return BigInt(whole) * 1_000_000n + BigInt(Math.floor((ms - whole) * 1e6));
}

/** What a container wrote at `at`, as the kubelet sends it with `timestamps=true`. */
function kubelet(at: number, written: string): string {
  return `${rfc3339(nanos(at))} ${written}`;
}

/** A kubelet line as Rust reads it. */
function read(stream: Stream, line: string): Timed {
  const { at, text, styles } = parse(line);
  if (at === null)
    throw new Error(`the mock wrote a line without its time: ${line}`);
  return [
    at,
    {
      type: "line",
      pod: stream.pod.name,
      container: stream.container,
      level: level(text),
      text,
      styles,
    },
  ];
}

const ROUTES = [
  "/v1/session",
  "/v1/token",
  "/v1/users/u-31",
  "/healthz",
  "/v1/orders",
];

/** Lines a healthy container writes, by level; `{route}`, `{ms}` and `{n}` are filled in. */
const INFO: readonly string[] = [
  'level=info msg="request served" method=GET path={route} status=200 dur={ms}ms',
  'level=info msg="request served" method=POST path={route} status=201 dur={ms}ms',
  '{"level":"info","msg":"token issued","user":"u-{n}","dur_ms":{ms}}',
  '{"level":"debug","msg":"cache hit","key":"session:{n}"}',
  "\u001b[32mINFO\u001b[0m  worker picked job id={n} queue=default",
  "\u001b[36mDEBUG\u001b[0m pool stats idle=4 busy={n}",
  "I1103 10:41:02.402135       1 controller.go:120] synced {n} objects",
  "GET {route} 200 {ms}ms",
];
const WARN: readonly string[] = [
  'level=warn msg="slow query" table=sessions dur={ms}ms',
  '{"level":"warn","msg":"retrying upstream","route":"{route}","attempt":2}',
  "\u001b[33mWARN\u001b[0m  queue depth {n} above 100",
];
const ERROR: readonly string[] = [
  '{"level":"error","msg":"upstream timeout","route":"{route}","after_ms":5000}',
  "E1103 10:41:02.402135       1 reflector.go:561] failed to list *v1.Pod: connection refused",
];

/** A healthy container's next line: mostly info, now and then a warning or an error. */
function template(random: () => number): string {
  const roll = random();
  const pool = roll < 0.92 ? INFO : roll < 0.98 ? WARN : ERROR;
  return pool[Math.floor(random() * pool.length)] ?? "";
}

/** The line a crash loop writes as it exits. */
export const CRASH_LINE =
  "panic: dial tcp 10.0.3.4:5432: connect: connection refused";

/** A crash loop's lines before it exits with 1. */
const CRASH: readonly string[] = [
  "starting auth-api 1.42.0 (commit 9f3b469)",
  'level=warn msg="db pool" attempt=1 err="dial tcp 10.0.3.4:5432: connect: connection refused"',
  'level=warn msg="db pool" attempt=2 err="dial tcp 10.0.3.4:5432: connect: connection refused"',
  "\u001b[31;1mERROR\u001b[0m db pool: giving up after 3 attempts host=pg-auth.payments.svc",
  CRASH_LINE,
  "",
  "goroutine 1 [running]:",
  "main.main()",
  "\t/src/cmd/auth-api/main.go:42 +0x1c5",
];

function fill(template: string, random: () => number): string {
  return template
    .replace("{route}", ROUTES[Math.floor(random() * ROUTES.length)] ?? "/")
    .replace("{ms}", String(1 + Math.floor(random() * random() * 900)))
    .replace("{n}", String(Math.floor(random() * 200)));
}
