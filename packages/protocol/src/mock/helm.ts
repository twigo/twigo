import { IpcError, wire } from "../error";
import type {
  Cell,
  Column,
  ComparedRevisions,
  CompareRevisions,
  HelmPart,
  IpcError as Wire,
  ListQuery,
  OpenRelease,
  Overview,
  ReleaseBatch,
  ReleaseListQuery,
  ReleaseManifest,
  ReleaseParts,
  ReleaseRef,
  ReleaseValues,
  RevisionLine,
  Scrubbed,
  SetReleaseView,
  ViewState,
} from "../generated";
import { HELM_RELEASES } from "../helm";
import { SHOWS_ROWS } from "../viewState";
import type { Cluster } from "./cluster";
import { ENDS_MS } from "./edits";
import HELM from "./helm.json";
import REVEALED from "./helm-revealed.json";
import type { MockKind, MockRow } from "./kinds";

/** A revision as `twigo-helm`'s mock test wrote it from the recorded Secrets: every part null for one that cannot be read. */
interface Revision {
  readonly revision: number;
  readonly problem: Wire | null;
  readonly overview?: Overview;
  readonly notes?: Scrubbed;
  readonly description?: Scrubbed;
  readonly values?: ReleaseValues;
  readonly manifest?: ReleaseManifest;
  readonly line: RevisionLine;
}

interface Recorded {
  readonly namespace: string;
  readonly name: string;
  readonly latest: {
    readonly revision: number;
    readonly status: string;
    readonly chart: string | null;
    readonly appVersion: string | null;
    readonly lastDeployed: string | null;
    readonly problem: string | null;
  };
  readonly revisions: readonly Revision[];
  readonly compared: readonly {
    readonly from: number;
    readonly to: number;
    readonly values: ComparedRevisions;
    readonly defaults: ComparedRevisions;
    readonly manifest: ComparedRevisions;
  }[];
}

interface Revealed {
  readonly part: HelmPart;
  readonly value: string;
  readonly binary: boolean;
}

/**
 * The namespaces the recorded releases were made in, and those of the mock's
 * cluster they are shown in, so that `rbacNamespaces` and
 * `rbacTypedNamespaces`, whose person may read some namespaces only, have
 * rows in the ones they may read. Every text of a recorded release is
 * renamed alike, a namespace in a link and in the notes included.
 */
const NAMESPACES: Readonly<Record<string, string>> = {
  "fmt-a": "payments",
  "fmt-b": "default",
  "fmt-d": "auth",
};

function renamed<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value).replace(
      /\bfmt-[abd]\b/g,
      (found) => NAMESPACES[found] ?? found,
    ),
  ) as T;
}

const RELEASES: readonly Recorded[] = renamed(HELM.releases) as never;

/** What a Reveal of each part of each revision answers, `namespace/name` and the revision first. */
const REVEALS: Readonly<
  Record<string, Readonly<Record<string, readonly Revealed[]>>>
> = renamed(REVEALED) as never;

/** The columns of `crates/twigo-core/src/helm/releases.rs`. */
const COLUMNS: readonly Column[] = [
  { name: "Name", kind: "string", priority: 0 },
  { name: "Revision", kind: "integer", priority: 0 },
  { name: "Status", kind: "string", priority: 0 },
  { name: "Chart", kind: "string", priority: 0 },
  { name: "App Version", kind: "string", priority: 0 },
  { name: "Updated", kind: "age", priority: 0 },
  { name: "Problem", kind: "string", priority: 0 },
];

function rowOf(
  cluster: Cluster,
  { namespace, name, latest }: Recorded,
  withNamespace: boolean,
): MockRow {
  const cells: Cell[] = [
    name,
    latest.revision,
    latest.problem === null ? latest.status : "unreadable",
    latest.chart,
    latest.appVersion,
    null,
    latest.problem,
  ];
  const [first = null, ...rest] = cells;
  return {
    id: `${cluster.context}/${namespace}/${name}`,
    namespace,
    created:
      latest.lastDeployed === null ? null : Date.parse(latest.lastDeployed),
    received: cluster.built,
    labels: {},
    controller: null,
    cells: withNamespace ? [first, namespace, ...rest] : cells,
    generated: null,
    fields: {},
  };
}

/** The releases of a cluster as the list machinery serves rows of a kind. */
export const HELM_KIND: MockKind = {
  columns: COLUMNS,
  fields: [],
  rows: (cluster, withNamespace) =>
    RELEASES.map((release) => rowOf(cluster, release, withNamespace)),
};

/** What the core makes of a release query, to run it through the list machinery. */
export function listQueryOf(request: ReleaseListQuery): ListQuery {
  return {
    ...request,
    gvr: HELM_RELEASES,
    namespaced: true,
    labelSelector: null,
    fieldSelector: null,
    owners: null,
  };
}

const recordedRelease = ({ namespace, name }: ReleaseRef) =>
  RELEASES.find(
    (release) => release.namespace === namespace && release.name === name,
  );

/** Keys sorted, so that a part the webview sends matches the one recorded whatever order its fields come in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, each]) => `${JSON.stringify(key)}:${canonical(each)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const gone = (revision: number) =>
  wire("helm.revision-gone", `revision ${String(revision)} is no longer kept`);

/**
 * Two revisions masked and paired, as `helm_compare` answers: the recorded
 * pairs are of neighbours, and either side first.
 */
export function compare({
  release,
  from,
  to,
  part,
}: CompareRevisions): ComparedRevisions {
  const found = recordedRelease(release);
  const revisions = [from, to].map((number) =>
    found?.revisions.find((revision) => revision.revision === number),
  );
  for (const [at, revision] of revisions.entries()) {
    const number = at === 0 ? from : to;
    if (!revision) {
      throw new IpcError("helm.revision-gone", gone(number).message);
    }
    if (revision.problem) {
      throw new IpcError(revision.problem.code, revision.problem.message);
    }
  }
  const pair = found?.compared.find(
    (each) =>
      (each.from === from && each.to === to) ||
      (each.from === to && each.to === from),
  );
  if (!pair) throw new IpcError("helm.revision-gone", gone(to).message);
  const sides = pair[part];
  return pair.from === from ? sides : { from: sides.to, to: sides.from };
}

/** `auth.password`, `extra[0]`: where a value stands in the values. */
function pathText(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (text, step) =>
      typeof step === "number"
        ? `${text}[${String(step)}]`
        : text === ""
          ? step
          : `${text}.${step}`,
    "",
  );
}

/** Whether Go's template prints a revealed leaf as Twigo shows it: a string or a boolean, since Helm reads a number as a float and prints null as `<no value>`. */
function printsAsGoDoes(value: string): boolean {
  return value.startsWith('"') || value === "true" || value === "false";
}

/**
 * What a Reveal's plan says, as `crates/twigo-core/src/actions/reveal.rs`
 * words it (`Reveal auth.password of release db (revision 4) in payments from
 * kind-a?`), with a command line only where `helm` prints exactly that part:
 * the person's whole values, and a string or a boolean leaf of them. `value`
 * is what the Reveal will answer.
 */
export function revealWords(
  context: string,
  { namespace, name }: ReleaseRef,
  revision: number,
  part: HelmPart,
  shown: Revision | undefined,
  value: string,
): { question: string; doing: string; commandLine: string | null } {
  const get = (verb: string, rest: string) =>
    `helm get ${verb} ${name} -n ${namespace} --kube-context ${context} --revision ${String(revision)} ${rest}`;
  const what = ((): string => {
    switch (part.kind) {
      case "values":
        return part.path.length === 0
          ? part.defaults
            ? "the chart's defaults"
            : "the values"
          : part.defaults
            ? `the default ${pathText(part.path)}`
            : pathText(part.path);
      case "secret": {
        const secret = shown?.manifest?.secrets.find(
          (each) =>
            each.document === part.document &&
            each.items.join(",") === part.items.join(","),
        );
        return `${part.key} of secret ${secret?.name ?? ""} in the manifest`;
      }
      case "document": {
        const source = shown?.manifest?.unread.find(
          (each) => each.document === part.document,
        )?.source;
        return source === undefined || source === null
          ? `document ${String(part.document + 1)} in the manifest`
          : `the document ${source} in the manifest`;
      }
      case "notes":
        return "the notes";
      case "description":
        return "the description";
    }
  })();
  const commandLine =
    part.kind !== "values" || part.defaults
      ? null
      : part.path.length === 0
        ? get("values", "-o json")
        : printsAsGoDoes(value)
          ? get(
              "all",
              `--template '{{index .Release.Config ${part.path
                .map((step) => JSON.stringify(step))
                .join(" ")}}}'`,
            )
          : null;
  return {
    question: `Reveal ${what} of release ${name} (revision ${String(revision)}) in ${namespace} from ${context}?`,
    doing: `Revealing ${what}`,
    commandLine,
  };
}

/** What a scenario does to an open release, whatever the cluster says. */
export interface ReleaseBinding {
  /** The state its namespace's Secrets are in: a refusal or a wait sends no part, as the core's first batch does. */
  readonly status?: ViewState;
  /** How the editor ends after `ENDS_MS`: the status says why, and what it showed stays. */
  readonly ends?: ViewState;
}

/**
 * An open release of the mock backend: the recorded revisions of the release
 * under its name, the revision asked for or the latest, with each part sent
 * once it is asked for and again for another revision.
 */
export class MockRelease {
  readonly #release: Recorded | undefined;
  readonly #onMessage: (batch: ReleaseBatch) => void;
  readonly #status: ViewState;
  #asked: number | null;
  #parts: ReleaseParts;
  #seq = 0;
  #closed = false;
  #ended = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly ref: ReleaseRef,
    { revision, parts }: Pick<OpenRelease, "revision" | "parts">,
    onMessage: (batch: ReleaseBatch) => void,
    binding: ReleaseBinding = {},
  ) {
    this.#release = recordedRelease(ref);
    this.#asked = revision;
    this.#parts = parts;
    this.#onMessage = onMessage;
    this.#status = binding.status ?? { state: "ready" };
    setTimeout(() => {
      this.#send(parts);
    }, 0);
    const { ends } = binding;
    if (ends) {
      this.#timer = setTimeout(() => {
        this.#end(ends);
      }, ENDS_MS);
    }
  }

  /** The revision the parts are of: the one asked for, else the latest. */
  get shown(): number | null {
    return this.#asked ?? this.#release?.latest.revision ?? null;
  }

  revision(revision: number | null): Revision | undefined {
    return this.#release?.revisions.find(
      (each) => each.revision === (revision ?? this.shown),
    );
  }

  setView({
    revision,
    parts,
  }: Pick<SetReleaseView, "revision" | "parts">): void {
    const moved = revision !== this.#asked;
    const before = this.#parts;
    this.#asked = revision;
    this.#parts = parts;
    const changed: ReleaseParts = moved
      ? parts
      : {
          overview: parts.overview && !before.overview,
          values: parts.values && !before.values,
          manifest: parts.manifest && !before.manifest,
          history: parts.history && !before.history,
        };
    if (Object.values(changed).some(Boolean)) this.#send(changed);
  }

  /** What a Reveal of a part of the shown revision answers; another revision is refused, as the core refuses once the editor moved. */
  reveal(revision: number, part: HelmPart): { value: string; binary: boolean } {
    if (revision !== this.shown) {
      throw new IpcError(
        "action.object-changed",
        `${this.ref.name} shows revision ${String(this.shown)} now, not the ${String(revision)} Twigo asked about, so it revealed nothing`,
      );
    }
    const found = REVEALS[`${this.ref.namespace}/${this.ref.name}`]?.[
      String(revision)
    ]?.find((each) => canonical(each.part) === canonical(part));
    if (!found) {
      throw new IpcError(
        "helm.no-value",
        `revision ${String(revision)} of ${this.ref.name} holds nothing there`,
      );
    }
    return { value: found.value, binary: found.binary };
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
  }

  /** The highest revision recorded below the one shown, as the core reads it from the labels; none where the one shown is not recorded. */
  #previous(): number | null {
    const shown = this.shown;
    if (!this.revision(shown)) return null;
    const below = (this.#release?.revisions ?? [])
      .map((each) => each.revision)
      .filter((each) => shown !== null && each < shown);
    return below.length === 0 ? null : Math.max(...below);
  }

  /** Ends the editor as the core's last batch does: it changes nothing but the state, and no part comes again. */
  #end(ends: ViewState): void {
    if (this.#closed) return;
    this.#ended = true;
    this.#onMessage({
      seq: ++this.#seq,
      status: ends,
      exists: this.#release !== undefined,
      revision: this.shown,
      latest: this.#release?.latest.revision ?? null,
      previous: this.#previous(),
      problem: null,
      overview: null,
      notes: null,
      description: null,
      values: null,
      manifest: null,
      history: null,
    });
  }

  #send(changed: ReleaseParts): void {
    if (this.#closed || this.#ended) return;
    const release = this.#release;
    if (!SHOWS_ROWS.has(this.#status.state)) {
      this.#onMessage({
        seq: ++this.#seq,
        status: this.#status,
        exists: false,
        revision: null,
        latest: null,
        previous: null,
        problem: null,
        overview: null,
        notes: null,
        description: null,
        values: null,
        manifest: null,
        history: null,
      });
      return;
    }
    const shown = this.shown;
    const revision = this.revision(shown);
    const problem =
      release && shown !== null && !revision
        ? wire("helm.revision-gone", gone(shown).message)
        : (revision?.problem ?? null);
    const readable = revision?.problem === null ? revision : undefined;
    this.#onMessage({
      seq: ++this.#seq,
      status: this.#status,
      exists: release !== undefined,
      revision: release === undefined ? null : shown,
      latest: release?.latest.revision ?? null,
      previous: this.#previous(),
      problem,
      overview: changed.overview ? (readable?.overview ?? null) : null,
      notes: changed.overview ? (readable?.notes ?? null) : null,
      description: changed.overview ? (readable?.description ?? null) : null,
      values: changed.values ? (readable?.values ?? null) : null,
      manifest: changed.manifest ? (readable?.manifest ?? null) : null,
      history:
        release && changed.history
          ? [...release.revisions]
              .sort((a, b) => b.revision - a.revision)
              .map((each) => each.line)
          : null,
    });
  }
}
