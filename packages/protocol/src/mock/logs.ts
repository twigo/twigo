import { IpcError } from "../error";
import type {
  AnsiColor,
  Bucket,
  Histogram,
  Level,
  LogBatch,
  LogEntry,
  LogPod,
  LogSource,
  LogTarget,
  LogView,
  LogWindow,
  StreamState,
  TextRange,
  TextStyle,
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
import { lowerAscii, parseText } from "./query";

/** The tab's streams (decision 23) and the cluster's followed logs (ARCHITECTURE 3.2). */
export const TAB_STREAMS = 10;
export const CLUSTER_STREAMS = 32;
/** The buffer's bound in lines (decision 24); the mock's lines are short, so bytes never bind first. */
const BOUND = 50_000;
const MATCHES = 10_000;
const BUCKETS = 80;
const TICK_MS = 100;
/** How often a workload's tab sees one of its pods replaced, as in a rollout. */
const ROLLOUT_MS = 25_000;
const NAMES = ["app", "istio-proxy", "log-shipper"];

type Stored = LogEntry & { readonly at: number };

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
 * JSON, logfmt, klog and ANSI among them, a crash-looping pod crashes, and
 * the view filters, searches and windows them as Rust does.
 */
export class MockLogs {
  readonly #target: LogTarget;
  readonly #cluster: Cluster | undefined;
  readonly #onMessage: (batch: LogBatch) => void;
  readonly #budget: (logs: MockLogs, wanted: number) => number;
  #source: LogSource;
  #view: LogView;
  #window: LogWindow | undefined;
  #entries: Stored[] = [];
  #streams = new Map<string, Stream>();
  #members = new Set<string>();
  #nextId = 1;
  #dropped = 0;
  #seq = 0;
  #unacked: number | undefined;
  #dirty = { pods: true, lines: true };
  #lastHistogram = 0;
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
    this.#view = checked(view);
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
    this.#entries = [];
    this.#streams.clear();
    this.#members.clear();
    this.#dropped = 0;
    this.#start(Date.now());
  }

  setView(view: LogView): void {
    this.#view = checked(view);
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
    for (const pod of this.#pods()) {
      this.#members.add(pod.name);
      for (const container of this.#chosen(pod)) {
        if (this.#streams.size >= TAB_STREAMS) break;
        const stream = this.#stream(pod, container, from);
        if (!writes(pod)) continue;
        const lines: Stored[] = [];
        while (stream.next < now) lines.push(...this.#write(stream));
        const kept = since.type === "lines" ? lines.slice(-since.lines) : lines;
        this.#entries.push(...kept);
        if (this.#source.previous) {
          this.#entries.push(this.#ended(stream, now - 2000));
          this.#streams.delete(key(pod.name, container));
        }
      }
    }
    this.#entries.sort((a, b) => a.at - b.at);
    this.#bound();
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
    if (this.#unacked !== undefined || this.#window === undefined) return;
    if (!this.#dirty.lines && !this.#dirty.pods) return;
    this.#send(now);
  }

  /** Writes what each stream wrote since the last tick, and follows the target's pods as they come and go. */
  #follow(now: number): void {
    this.#rollOut(now);
    const current = new Set(this.#pods().map((pod) => pod.name));
    for (const name of this.#members) {
      if (current.has(name)) continue;
      this.#members.delete(name);
      for (const [id, stream] of this.#streams) {
        if (stream.pod.name === name) this.#streams.delete(id);
      }
      this.#push({
        type: "left",
        id: this.#nextId++,
        pod: name,
        time: stamp(now),
        at: now,
      });
      this.#dirty.pods = true;
    }
    for (const pod of this.#pods()) {
      if (this.#members.has(pod.name)) continue;
      this.#members.add(pod.name);
      this.#push({
        type: "joined",
        id: this.#nextId++,
        pod: pod.name,
        time: stamp(now),
        owner: {
          group: "apps",
          version: "v1",
          kind: "ReplicaSet",
          namespace: pod.namespace,
          name: pod.generateName.slice(0, -1),
        },
        at: now,
      });
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
        for (const entry of written) this.#push(entry);
        if (written.some((entry) => entry.type === "ended")) break;
      }
    }
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

  #push(entry: Stored): void {
    const last = this.#entries[this.#entries.length - 1];
    if (!last || last.at <= entry.at) this.#entries.push(entry);
    else {
      const at = this.#entries.findIndex((each) => each.at > entry.at);
      this.#entries.splice(at, 0, entry);
    }
    this.#bound();
    this.#dirty.lines = true;
  }

  #bound(): void {
    const lines = this.#entries.filter((entry) => entry.type !== "dropped");
    const over = lines.length - BOUND;
    if (over <= 0) return;
    const kept = lines.slice(over);
    this.#dropped += over;
    this.#entries = [
      { type: "dropped", id: 0, count: this.#dropped, at: 0 },
      ...kept,
    ];
  }

  /** The stream's next entries: a line, or a crash loop's crash and its end. */
  #write(stream: Stream): Stored[] {
    const at = stream.next;
    const { random } = stream;
    stream.next = at + 200 + random() * random() * 4000;
    if (stream.pod.status === "CrashLoopBackOff") {
      const step = CRASH[stream.cycle];
      stream.cycle = (stream.cycle + 1) % (CRASH.length + 1);
      if (step === undefined) {
        const ended = this.#ended(stream, at);
        stream.restartAt = at + 40_000;
        stream.next = stream.restartAt;
        this.#dirty.pods = true;
        return [ended];
      }
      stream.next = at + 300 + random() * 900;
      return [this.#line(stream, at, step)];
    }
    return [this.#line(stream, at, fill(template(random), random))];
  }

  #line(stream: Stream, at: number, raw: string): Stored {
    const { text, styles } = ansi(raw);
    return {
      type: "line",
      id: this.#nextId++,
      pod: stream.pod.name,
      container: stream.container,
      time: stamp(at),
      level: levelOf(text),
      text,
      styles,
      marks: [],
      at,
    };
  }

  #ended(stream: Stream, at: number): Stored {
    return {
      type: "ended",
      id: this.#nextId++,
      pod: stream.pod.name,
      container: stream.container,
      time: stamp(at),
      exitCode: 1,
      reason: "Error",
      restarting: this.#source.previous ? null : stamp(at + 40_000),
      at,
    };
  }

  #send(now: number): void {
    const view = this.#visible();
    const total = view.length;
    const window = this.#window ?? { type: "tail", count: 0 };
    const [start, end] =
      window.type === "tail"
        ? [Math.max(0, total - window.count), total]
        : [Math.min(window.start, total), Math.min(window.end, total)];
    const search = searcher(this.#view.search);
    const entries = view.slice(start, end).map((entry) => {
      const { at: _at, ...wire } = entry;
      return wire.type === "line" && search
        ? { ...wire, marks: search(wire.text) }
        : wire;
    });
    let count = 0;
    const indexes: number[] = [];
    if (search) {
      view.forEach((entry, index) => {
        if (entry.type !== "line") return;
        for (const _ of search(entry.text)) {
          count++;
          indexes.push(index);
        }
      });
    }
    indexes.splice(0, Math.max(0, indexes.length - MATCHES));
    const histogram =
      now - this.#lastHistogram > 1000 ? this.#histogram() : null;
    if (histogram) this.#lastHistogram = now;
    this.#seq++;
    this.#unacked = this.#seq;
    const status: ViewState = { state: "ready" };
    this.#onMessage({
      seq: this.#seq,
      status,
      pods: this.#dirty.pods ? this.#logPods() : null,
      total,
      window: { start, entries },
      matches: { count, entries: indexes },
      histogram,
      dropped: this.#dropped,
    });
    this.#dirty = { pods: false, lines: histogram === null };
  }

  /** The entries the view keeps: markers always, lines by level, filter and range. */
  #visible(): Stored[] {
    const { level, filter, range } = this.#view;
    const text = filter === null ? null : parseText(filter);
    const from = range ? Date.parse(range.from) : -Infinity;
    const to = range ? Date.parse(range.to) : Infinity;
    return this.#entries.filter((entry) => {
      if (entry.type === "dropped") return true;
      if (entry.at < from || entry.at >= to) return false;
      if (entry.type !== "line") return true;
      if (level === "warn" && entry.level !== "warn" && entry.level !== "error")
        return false;
      if (level === "error" && entry.level !== "error") return false;
      return !text || text.keeps([entry.text]);
    });
  }

  #histogram(): Histogram | null {
    const { range: _range, ...rest } = this.#view;
    const saved = this.#view;
    this.#view = { ...rest, range: null };
    const lines = this.#visible().filter(
      (entry): entry is Stored & { type: "line" } => entry.type === "line",
    );
    this.#view = saved;
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (!first || !last) return null;
    const span = Math.max(1, last.at - first.at + 1);
    const buckets: Bucket[] = Array.from({ length: BUCKETS }, () => ({
      lines: 0,
      warnings: 0,
      errors: 0,
    }));
    for (const line of lines) {
      const bucket =
        buckets[Math.floor(((line.at - first.at) / span) * BUCKETS)];
      if (!bucket) continue;
      bucket.lines++;
      if (line.level === "warn") bucket.warnings++;
      if (line.level === "error") bucket.errors++;
    }
    return { from: stamp(first.at), to: stamp(first.at + span), buckets };
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

function key(pod: string, container: string): string {
  return `${pod}/${container}`;
}

/** A pod that waits to start writes nothing. */
function writes(pod: Pod): boolean {
  return pod.status !== "Pending" && pod.status !== "ContainerCreating";
}

/** A view whose filter or search is no regex is refused, as Rust refuses it. */
function checked(view: LogView): LogView {
  if (view.filter !== null) parseText(view.filter);
  searcher(view.search);
  return view;
}

/** The kubelet's stamp: RFC 3339 with nanoseconds. */
function stamp(at: number): string {
  const nanos = String(Math.floor((at % 1) * 1e6)).padStart(6, "0");
  return new Date(Math.floor(at)).toISOString().replace("Z", `${nanos}Z`);
}

/** A substring in any case of ASCII letters, or a regex between slashes in any case; null for no search. */
function searcher(
  source: string | null,
): ((text: string) => TextRange[]) | null {
  const text = source?.trim() ?? "";
  if (text === "") return null;
  if (text.length >= 2 && text.startsWith("/") && text.endsWith("/")) {
    const pattern = text.slice(1, -1);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "gi");
    } catch (error) {
      throw new IpcError(
        "invalidInput",
        `the search /${pattern}/ is no regex: ${String(error)}`,
      );
    }
    return (line) =>
      [...line.matchAll(regex)]
        .filter((match) => match[0].length > 0)
        .map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
        }));
  }
  const needle = lowerAscii(text);
  return (line) => {
    const haystack = lowerAscii(line);
    const found: TextRange[] = [];
    let from = haystack.indexOf(needle);
    while (from >= 0) {
      found.push({ start: from, end: from + needle.length });
      from = haystack.indexOf(needle, from + needle.length);
    }
    return found;
  };
}

const WORDS: Readonly<Record<string, Level>> = {
  trace: "trace",
  debug: "debug",
  dbg: "debug",
  info: "info",
  inf: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  wrn: "warn",
  error: "error",
  err: "error",
  fatal: "error",
  crit: "error",
  critical: "error",
  panic: "error",
};

const PINO: readonly [number, Level][] = [
  [60, "error"],
  [50, "error"],
  [40, "warn"],
  [30, "info"],
  [20, "debug"],
  [10, "trace"],
];

/** A line's level: from a JSON object's field, logfmt's `level=`, klog's prefix, or a level word among its first tokens. */
export function levelOf(text: string): Level | null {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const object = JSON.parse(trimmed) as Record<string, unknown>;
      for (const field of [
        "level",
        "lvl",
        "severity",
        "levelname",
        "log.level",
      ]) {
        const value = object[field];
        if (typeof value === "string")
          return WORDS[value.toLowerCase()] ?? null;
        if (typeof value === "number")
          return PINO.find(([at]) => value >= at)?.[1] ?? null;
      }
      return null;
    } catch {
      // Not JSON after all: read it as text.
    }
  }
  const logfmt = /(?:^|\s)(?:level|lvl)=("?)([A-Za-z]+)\1/.exec(trimmed);
  if (logfmt?.[2]) return WORDS[logfmt[2].toLowerCase()] ?? null;
  const klog = /^([IWEF])\d{4} /.exec(trimmed);
  if (klog)
    return ({ I: "info", W: "warn", E: "error", F: "error" } as const)[
      klog[1] as "I"
    ];
  for (const token of trimmed.split(/\s+/).slice(0, 3)) {
    const word = token.replace(/^\[|[\]:]+$/g, "").toLowerCase();
    const level = WORDS[word];
    if (level) return level;
  }
  return null;
}

const ESC = String.fromCharCode(27);
const SGR_SPLIT = new RegExp(`(${ESC}\\[[0-9;]*m)`);
const SGR = new RegExp(`^${ESC}\\[([0-9;]*)m$`);

const COLORS: readonly AnsiColor[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

/** The text without its SGR escapes, and the runs they styled: the mock writes the sixteen colours and bold only. */
function ansi(raw: string): { text: string; styles: TextStyle[] } {
  let text = "";
  const styles: TextStyle[] = [];
  let fg: AnsiColor | null = null;
  let bold = false;
  let start = 0;
  const close = () => {
    if ((fg || bold) && text.length > start)
      styles.push({
        range: { start, end: text.length },
        fg,
        bg: null,
        bold,
        dim: false,
        italic: false,
        underline: false,
      });
    start = text.length;
  };
  for (const part of raw.split(SGR_SPLIT)) {
    const sgr = SGR.exec(part);
    if (!sgr) {
      text += part;
      continue;
    }
    close();
    const codes = sgr[1] === undefined || sgr[1] === "" ? "0" : sgr[1];
    for (const code of codes.split(";").map(Number)) {
      if (code === 0) [fg, bold] = [null, false];
      else if (code === 1) bold = true;
      else if (code >= 30 && code <= 37) fg = COLORS[code - 30] ?? null;
      else if (code >= 90 && code <= 97) {
        const base = COLORS[code - 90];
        fg = base
          ? (`bright${base[0]?.toUpperCase()}${base.slice(1)}` as AnsiColor)
          : null;
      }
    }
  }
  close();
  return { text, styles };
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

/** A crash loop's lines before it exits with 1. */
const CRASH: readonly string[] = [
  "starting auth-api 1.42.0 (commit 9f3b469)",
  'level=warn msg="db pool" attempt=1 err="dial tcp 10.0.3.4:5432: connect: connection refused"',
  'level=warn msg="db pool" attempt=2 err="dial tcp 10.0.3.4:5432: connect: connection refused"',
  "\u001b[31;1mERROR\u001b[0m db pool: giving up after 3 attempts host=pg-auth.payments.svc",
  "panic: dial tcp 10.0.3.4:5432: connect: connection refused",
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
