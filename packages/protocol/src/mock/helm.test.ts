import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { IpcError } from "../error";
import type {
  HelmPart,
  ListBatch,
  OperationEvent,
  ReleaseBatch,
  ReleaseListQuery,
  ReleaseParts,
} from "../generated";
import { ENDS_MS } from "./edits";
import { revealWords } from "./helm";
import { createMockBackend, type MockScenario } from "./index";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const NOTHING: ReleaseParts = {
  overview: false,
  values: false,
  manifest: false,
  history: false,
};

function query(rest: Partial<ReleaseListQuery> = {}): ReleaseListQuery {
  return {
    space: "prod-eu",
    namespaces: [],
    text: null,
    columns: null,
    sort: null,
    countBy: null,
    groupBy: null,
    values: null,
    ...rest,
  };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(2000);
  return promise;
}

async function list(
  rest: Partial<ReleaseListQuery> = {},
  scenario: MockScenario = "live",
) {
  const backend = createMockBackend(scenario);
  const batches: ListBatch[] = [];
  const id = await settle(
    backend.subscribe("helm_list_subscribe", query(rest), (batch) =>
      batches.push(batch),
    ),
  );
  void backend.invoke("list_set_window", {
    id,
    start: 0,
    end: 50,
    metrics: false,
  });
  for (let step = 0; step < 6; step++) {
    await vi.advanceTimersByTimeAsync(100);
    const latest = batches[batches.length - 1];
    if (latest) void backend.invoke("list_ack", { id, seq: latest.seq });
  }
  const rows = new Map(
    batches.flatMap((batch) => batch.upserts).map((row) => [row.id, row]),
  );
  const columns = batches.flatMap((batch) => batch.columns ?? []).slice(-8);
  const last = batches[batches.length - 1];
  return { backend, batches, rows, columns, last };
}

test("every release is a row of the columns the core sends, Namespace second where there is more than one", async () => {
  const { rows, columns, last } = await list();
  expect(columns.map((column) => column.name)).toEqual([
    "Name",
    "Namespace",
    "Revision",
    "Status",
    "Chart",
    "App Version",
    "Updated",
    "Problem",
  ]);
  expect(last?.total).toBe(6);
  const alpha = rows.get("prod-eu/payments/alpha");
  expect(alpha?.cells).toEqual([
    "alpha",
    "payments",
    2,
    "deployed",
    "demo-0.1.0",
    "1.0.0",
    null,
    null,
  ]);
  expect(alpha?.created).toBe("2026-11-22T20:14:04.369Z");
  expect(rows.get("prod-eu/default/beta")?.cells[3]).toBe("uninstalled");
  expect(rows.get("prod-eu/payments/epsilon")?.cells[3]).toBe("failed");
  expect(rows.get("prod-eu/auth/stuck")?.cells[3]).toBe("pending-upgrade");
});

test("a release whose revision cannot be read is unreadable, which counts as failing, and carries its code", async () => {
  const { rows } = await list();
  expect(rows.get("prod-eu/auth/trunc")?.cells).toEqual([
    "trunc",
    "auth",
    1,
    "unreadable",
    null,
    null,
    null,
    "helm.truncated",
  ]);
});

test("the query view counts, filters and sorts releases as it does any list", async () => {
  const filtered = await list({ text: "alpha", countBy: "Status" });
  expect(filtered.last?.total).toBe(2);
  const counted = await list({ countBy: "Status" });
  expect(
    Object.fromEntries(
      (counted.last?.counts ?? []).map(({ value, count }) => [value, count]),
    ),
  ).toEqual({
    deployed: 2,
    failed: 1,
    unreadable: 1,
    uninstalled: 1,
    "pending-upgrade": 1,
  });
});

test("a person who may read one namespace has its releases, the others' left out all the same, and refused alone when chosen: their Secrets", async () => {
  const all = await list({}, "rbacNamespaces");
  expect([...all.rows.keys()].sort()).toEqual([
    "prod-eu/default/alpha",
    "prod-eu/default/beta",
  ]);
  expect(
    all.batches.flatMap((batch) => (batch.parts ? [batch.parts.omitted] : [])),
  ).toContain(11);
  const chosen = await list(
    { namespaces: ["payments", "default", "auth"] },
    "rbacNamespaces",
  );
  expect([...chosen.rows.keys()].sort()).toEqual([
    "prod-eu/default/alpha",
    "prod-eu/default/beta",
  ]);
  expect(
    chosen.batches
      .flatMap((batch) => batch.parts?.unready ?? [])
      .map(({ part, state }) => [part, state]),
  ).toContainEqual([
    { kind: "namespace", name: "auth" },
    { state: "forbidden", verb: "watch", resource: "secrets" },
  ]);
});

async function open(
  revision: number | null,
  parts: ReleaseParts,
  name = "alpha",
  namespace = "payments",
  backend = createMockBackend(),
) {
  const batches: ReleaseBatch[] = [];
  const id = await settle(
    backend.subscribe(
      "helm_release_open",
      { release: { space: "prod-eu", namespace, name }, revision, parts },
      (batch) => batches.push(batch),
    ),
  );
  const set = async (next: number | null, now: ReleaseParts) => {
    const done = backend.invoke("helm_release_set_view", {
      id,
      revision: next,
      parts: now,
    });
    await vi.advanceTimersByTimeAsync(10);
    await done;
  };
  return { backend, batches, id, set };
}

const ALL: ReleaseParts = {
  overview: true,
  values: true,
  manifest: true,
  history: true,
};

test("an open release sends only what its views ask for, of the revision it follows", async () => {
  const { batches, set } = await open(null, {
    ...NOTHING,
    overview: true,
  });
  const [first] = batches;
  expect(first?.revision).toBe(2);
  expect(first?.latest).toBe(2);
  expect(first?.overview?.header.printed[1]).toEqual({
    column: "Revision",
    value: "2",
  });
  expect(first?.values).toBeNull();
  expect(first?.history).toBeNull();
  await set(null, { ...NOTHING, overview: true, values: true });
  expect(batches).toHaveLength(2);
  expect(batches[1]?.values?.user).toContain("<16 bytes>");
  expect(batches[1]?.overview).toBeNull();
});

test("a pinned revision shows its own parts, and history lists every revision newest first", async () => {
  const { batches, set } = await open(null, ALL);
  expect(batches[0]?.history?.map((line) => line.revision)).toEqual([2, 1]);
  await set(1, ALL);
  const pinned = batches[batches.length - 1];
  expect(pinned?.revision).toBe(1);
  expect(pinned?.latest).toBe(2);
  expect(pinned?.values?.user).not.toBe(batches[0]?.values?.user);
});

test("a revision Helm no longer keeps says so, and a release that is gone does not exist", async () => {
  const { batches } = await open(9, ALL);
  expect(batches[0]?.problem?.code).toBe("helm.revision-gone");
  expect(batches[0]?.values).toBeNull();
  expect(batches[0]?.latest).toBe(2);
  expect(batches[0]?.previous).toBeNull();
  const gone = await open(null, ALL, "nothing");
  expect(gone.batches[0]?.exists).toBe(false);
});

test("a release that cannot be read says why and has no parts", async () => {
  const { batches } = await open(null, ALL, "trunc", "auth");
  expect(batches[0]?.problem?.code).toBe("helm.truncated");
  expect(batches[0]?.overview).toBeNull();
  expect(batches[0]?.values).toBeNull();
  expect(batches[0]?.history?.[0]?.problem?.code).toBe("helm.truncated");
});

test("an open release follows its namespace's scenario: a refused one sends no part and says why, and objectPanicked ends the editor after what it showed", async () => {
  const refused = await open(
    null,
    ALL,
    "alpha",
    "payments",
    createMockBackend("rbacNamespaces"),
  );
  expect(refused.batches).toHaveLength(1);
  expect(refused.batches[0]).toMatchObject({
    status: { state: "forbidden", verb: "list", resource: "secrets" },
    exists: false,
    revision: null,
    latest: null,
    problem: null,
    overview: null,
    values: null,
    history: null,
  });
  const allowed = await open(
    null,
    ALL,
    "alpha",
    "default",
    createMockBackend("rbacNamespaces"),
  );
  expect(allowed.batches[0]).toMatchObject({
    status: { state: "ready" },
    exists: true,
    revision: 1,
  });

  const panicking = await open(
    null,
    ALL,
    "alpha",
    "payments",
    createMockBackend("objectPanicked"),
  );
  expect(panicking.batches).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(ENDS_MS);
  const last = panicking.batches[panicking.batches.length - 1];
  expect(last).toMatchObject({
    status: { state: "error", error: { code: "internal.panic" } },
    exists: true,
    revision: 2,
    latest: 2,
    problem: null,
    overview: null,
    values: null,
    manifest: null,
    history: null,
  });
  await panicking.set(1, ALL);
  expect(panicking.batches[panicking.batches.length - 1]).toBe(last);
});

test("a comparison marks a masked value that changed on both sides, whichever way round it is asked", async () => {
  const backend = createMockBackend();
  const release = { space: "prod-eu", namespace: "payments", name: "alpha" };
  const forward = backend.invoke("helm_compare", {
    release,
    from: 1,
    to: 2,
    part: "values",
  });
  const backward = backend.invoke("helm_compare", {
    release,
    from: 2,
    to: 1,
    part: "values",
  });
  await vi.advanceTimersByTimeAsync(10);
  const a = await forward;
  const b = await backward;
  expect(a.from).toContain("<16 bytes, changed>");
  expect(a.to).toContain("<16 bytes, changed>");
  expect({ from: b.to, to: b.from }).toEqual(a);
});

test("a comparison of a revision that cannot be read, or is not kept, is refused with the code of why", async () => {
  const backend = createMockBackend();
  const compared = (name: string, namespace: string, to: number) => {
    const done = backend.invoke("helm_compare", {
      release: { space: "prod-eu", namespace, name },
      from: 1,
      to,
      part: "manifest",
    });
    const caught = done.then(
      () => undefined,
      (error: unknown) => error,
    );
    void vi.advanceTimersByTimeAsync(10);
    return caught;
  };
  expect(await compared("alpha", "payments", 7)).toMatchObject({
    code: "helm.revision-gone",
  });
  expect(await compared("trunc", "auth", 1)).toMatchObject({
    code: "helm.truncated",
  });
});

async function plan(
  backend: ReturnType<typeof createMockBackend>,
  release: number,
  revision: number,
  part: HelmPart,
) {
  const planned = backend
    .invoke("command_plan", { action: "revealHelm", release, revision, part })
    .then(
      (plan) => ({ plan }),
      (error: unknown) => ({ error }),
    );
  await vi.advanceTimersByTimeAsync(10);
  const answer = await planned;
  if ("error" in answer) throw answer.error;
  return answer.plan;
}

const user = (path: (string | number)[]): HelmPart => ({
  kind: "values",
  defaults: false,
  path,
});

test("a Reveal says what the core's plan says and shows a command only where helm prints exactly that part", async () => {
  const { backend, id } = await open(null, ALL);
  const whole = await plan(backend, id, 2, user([]));
  expect(whole).toMatchObject({
    question:
      "Reveal the values of release alpha (revision 2) in payments from prod-eu?",
    confirm: "Reveal",
    consequences: [
      "It shows until you hide it, close the release or show another revision.",
    ],
    doing: "Revealing the values",
    commandLine:
      "helm get values alpha -n payments --kube-context prod-eu --revision 2 -o json",
  });
  const leaf = await plan(backend, id, 2, user(["database", "password"]));
  expect(leaf.question).toBe(
    "Reveal database.password of release alpha (revision 2) in payments from prod-eu?",
  );
  expect(leaf.doing).toBe("Revealing database.password");
  expect(leaf.commandLine).toBe(
    'helm get all alpha -n payments --kube-context prod-eu --revision 2 --template \'{{index .Release.Config "database" "password"}}\'',
  );
  expect(
    (await plan(backend, id, 2, user(["database"]))).commandLine,
  ).toBeNull();
  const defaults = await plan(backend, id, 2, {
    kind: "values",
    defaults: true,
    path: [],
  });
  expect(defaults.question).toBe(
    "Reveal the chart's defaults of release alpha (revision 2) in payments from prod-eu?",
  );
  expect(defaults.commandLine).toBeNull();
  const defaulted = await plan(backend, id, 2, {
    kind: "values",
    defaults: true,
    path: ["image", "tag"],
  });
  expect(defaulted.question).toBe(
    "Reveal the default image.tag of release alpha (revision 2) in payments from prod-eu?",
  );
  expect(defaulted.commandLine).toBeNull();
  const secret = await plan(backend, id, 2, {
    kind: "secret",
    document: 0,
    items: [],
    key: "password",
  });
  expect(secret.question).toBe(
    "Reveal password of secret alpha-db in the manifest of release alpha (revision 2) in payments from prod-eu?",
  );
  expect(secret.doing).toBe(
    "Revealing password of secret alpha-db in the manifest",
  );
  expect(secret.commandLine).toBeNull();
  const manifest = await plan(backend, id, 2, { kind: "manifest" });
  expect(manifest).toMatchObject({
    question:
      "Reveal all of the manifest's Secrets of release alpha (revision 2) in payments from prod-eu?",
    consequences: [
      "It shows until you hide it, close the release or show another revision.",
    ],
    doing: "Revealing all of the manifest's Secrets",
    commandLine:
      "helm get manifest alpha -n payments --kube-context prod-eu --revision 2",
  });
  const notes = await plan(backend, id, 2, { kind: "notes" });
  expect(notes.question).toBe(
    "Reveal the notes of release alpha (revision 2) in payments from prod-eu?",
  );
  expect(notes.commandLine).toBeNull();
});

test("a Reveal prints a command for a string or a boolean leaf of the values and for no other, since helm's template prints a number or null otherwise than Twigo shows it", () => {
  const release = { space: "prod-eu", namespace: "payments", name: "alpha" };
  const line = (path: (string | number)[], value: string) =>
    revealWords("prod-eu", release, 1, user(path), undefined, value)
      .commandLine;
  expect(line(["extra", 0], '"one"')).toBe(
    "helm get all alpha -n payments --kube-context prod-eu --revision 1 --template '{{index .Release.Config \"extra\" 0}}'",
  );
  expect(line(["tls"], "true")).toContain("--template");
  expect(line(["replicaCount"], "2")).toBeNull();
  expect(line(["removeMe"], "null")).toBeNull();
  expect(
    revealWords(
      "prod-eu",
      release,
      1,
      { kind: "document", document: 3 },
      undefined,
      "",
    ).question,
  ).toBe(
    "Reveal document 4 in the manifest of release alpha (revision 1) in payments from prod-eu?",
  );
});

test("a Reveal answers the value it names, and is refused once the editor shows another revision", async () => {
  const { backend, id, set } = await open(null, ALL);
  const part = user(["database", "password"]);
  const planned = await plan(backend, id, 2, part);
  const events: OperationEvent[] = [];
  await settle(
    backend.subscribe(
      "command_execute",
      { plan: planned.id, typed: null },
      (event) => events.push(event),
    ),
  );
  expect(events).toContainEqual({
    state: "revealed",
    value: '"user-password-r2"',
    binary: false,
  });
  await set(1, ALL);
  const error = await plan(backend, id, 2, part).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(IpcError);
  expect(error).toMatchObject({ code: "action.object-changed" });
  expect(
    await plan(backend, id, 1, user(["no", "such"])).catch(
      (caught: unknown) => caught,
    ),
  ).toMatchObject({ code: "helm.no-value" });
});

test("a list of releases is a list as to the scenarios: a pinned state and a panic reach it", async () => {
  const pinned = await list({}, "forbidden");
  expect(pinned.last?.status).toMatchObject({
    state: "forbidden",
    resource: "secrets",
  });
  const panicked = await list({}, "listPanicked");
  expect(panicked.last?.status).toMatchObject({ state: "error" });
});
