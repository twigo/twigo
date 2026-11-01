import type { ListBatch } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import type { ListProbe, Probe } from "./probe";

const PODS = "k8s-list://prod-eu/v1/pods";
const SCROLL_SECONDS = 5;
const SCROLL_PX_PER_SECOND = 4000;
const SORTS = ["Name", "Status", "Restarts", "Age", "Namespace"].flatMap(
  (column) => [column, column],
);
const CHANGE_SECONDS = 60;
const WAIT_MS = 5000;
const PAINT_TIMEOUT_MS = 1000;

/** What `twigo-bench report` reads as webview.json. */
export interface Results {
  backend: string;
  rows: number;
  changesPerSecond: number;
  refreshMs: number;
  firstPaint: { batchToPaintMs: number };
  scroll: {
    seconds: number;
    pxPerSecond: number;
    frameMs: number[];
    blankFrames: number;
  };
  sort: { column: string; descending: boolean; ms: number }[];
  changes: {
    seconds: number;
    ms: number[];
    offscreen: number;
    superseded: number;
    timedOut: number;
  };
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Called within a frame's callbacks: resolves once that frame is rendered. */
function rendered(): Promise<number> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      resolve(performance.now());
    };
    channel.port2.postMessage(null);
  });
}

/** Checks `ready` on every frame, and resolves when the first frame where it holds is rendered. */
async function paintedWhen(ready: () => boolean, what: string) {
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    await frame();
    if (ready()) return rendered();
    if (performance.now() > deadline) throw new Error(`no ${what}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function grid(): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="grid"]'),
  ].find((g) => g.getAttribute("aria-label")?.toLowerCase() === "pods");
  if (!found) throw new Error("the pod list is not on screen");
  return found;
}

function headers(table: HTMLElement): HTMLButtonElement[] {
  return [
    ...table.querySelectorAll<HTMLButtonElement>(
      '[aria-rowindex="1"] button[role="columnheader"]',
    ),
  ];
}

function header(table: HTMLElement, column: string): HTMLButtonElement {
  const found = headers(table).find((h) => h.textContent === column);
  if (!found) throw new Error(`no ${column} header`);
  return found;
}

function rowAt(table: HTMLElement, index: number): HTMLElement | null {
  return table.querySelector(`[role="row"][aria-rowindex="${index + 2}"]`);
}

function cellText(row: HTMLElement, position: number): string | undefined {
  return (
    row.querySelectorAll(':scope > [role="gridcell"]')[position]?.textContent ??
    undefined
  );
}

function onScreen(table: HTMLElement, row: HTMLElement): boolean {
  const top =
    table.querySelector('[aria-rowindex="1"]')?.getBoundingClientRect()
      .bottom ?? table.getBoundingClientRect().top;
  const { top: rowTop, bottom } = row.getBoundingClientRect();
  return bottom > top && rowTop < table.getBoundingClientRect().bottom;
}

/** Whether a row on screen still shows skeletons, its data not yet in. */
function blank(table: HTMLElement): boolean {
  return [
    ...table.querySelectorAll<HTMLElement>(
      '[role="row"]:not([aria-rowindex="1"])',
    ),
  ].some((row) => onScreen(table, row) && cellText(row, 0) === undefined);
}

function nextBatch(
  list: ListProbe,
  matches: (batch: ListBatch) => boolean,
): Promise<number> {
  return new Promise((resolve) => {
    const stop = list.listen((at, batch) => {
      if (matches(batch)) {
        stop();
        resolve(at);
      }
    });
  });
}

async function open(workbench: Workbench, probe: Probe) {
  const opened = probe.next();
  const deadline = performance.now() + WAIT_MS;
  for (;;) {
    try {
      workbench.editors.open(PODS);
      break;
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await frame();
    }
  }
  const list = await opened;
  const batchAt = await nextBatch(list, (batch) => batch.upserts.length > 0);
  const paintedAt = await paintedWhen(() => {
    const row = rowAt(grid(), 0);
    return row !== null && cellText(row, 0) !== undefined;
  }, "first rows");
  return { list, batchToPaintMs: paintedAt - batchAt };
}

async function refresh(): Promise<number> {
  const stamps: number[] = [];
  for (let i = 0; i < 61; i++) stamps.push(await frame());
  const intervals = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)] ?? 0;
}

async function scroll(): Promise<Results["scroll"]> {
  const table = grid();
  const frameMs: number[] = [];
  let blankFrames = 0;
  const first = await frame();
  let last = first;
  for (;;) {
    const at = await frame();
    frameMs.push(at - last);
    last = at;
    if (blank(table)) blankFrames++;
    const elapsed = (at - first) / 1000;
    if (elapsed >= SCROLL_SECONDS) break;
    table.scrollTop = elapsed * SCROLL_PX_PER_SECOND;
  }
  return {
    seconds: SCROLL_SECONDS,
    pxPerSecond: SCROLL_PX_PER_SECOND,
    frameMs,
    blankFrames,
  };
}

async function top(): Promise<void> {
  const table = grid();
  table.scrollTop = 0;
  await paintedWhen(() => {
    const row = rowAt(table, 0);
    return (
      row !== null && onScreen(table, row) && cellText(row, 0) !== undefined
    );
  }, "rows at the top");
}

async function sorts(probe: Probe): Promise<Results["sort"]> {
  await top();
  const samples: Results["sort"] = [];
  for (const column of SORTS) {
    await sleep(300);
    const table = grid();
    const button = header(table, column);
    const opened = probe.next();
    const clicked = performance.now();
    button.click();
    const list = await opened;
    let expected = "";
    await nextBatch(list, (batch) => {
      const id = batch.window?.start === 0 ? batch.window.ids[0] : undefined;
      if (id === undefined) return false;
      const name = list.columns.findIndex((c) => c.name === "Name");
      expected = String(list.cells(id)?.[name] ?? "");
      return true;
    });
    const painted = await paintedWhen(() => {
      const row = rowAt(table, 0);
      return row !== null && cellText(row, 0) === expected;
    }, `rows sorted by ${column}`);
    samples.push({
      column,
      descending: button.getAttribute("aria-sort") === "descending",
      ms: painted - clicked,
    });
  }
  return samples;
}

async function changes(
  list: ListProbe,
  steady: () => Promise<void>,
): Promise<Results["changes"]> {
  const table = grid();
  const positions = new Map(
    headers(table).map((h, i) => [h.textContent, i] as const),
  );
  const pending = new Map<
    string,
    { at: number; id: string; position: number; text: string }
  >();
  const result: Results["changes"] = {
    seconds: CHANGE_SECONDS,
    ms: [],
    offscreen: 0,
    superseded: 0,
    timedOut: 0,
  };
  const stop = list.listen((at, _, changed) => {
    for (const { id, column, text } of changed) {
      const position = positions.get(column);
      if (position === undefined) continue;
      const key = `${id}\u0000${column}`;
      if (pending.has(key)) result.superseded++;
      pending.set(key, { at, id, position, text });
    }
  });
  await steady();
  const end = performance.now() + CHANGE_SECONDS * 1000;
  while (performance.now() < end) {
    const now = await frame();
    const shown: number[] = [];
    for (const [key, change] of pending) {
      const index = list.indexOf(change.id);
      const row = index < 0 ? null : rowAt(table, index);
      if (!row || !onScreen(table, row)) {
        result.offscreen++;
        pending.delete(key);
      } else if (cellText(row, change.position) === change.text) {
        shown.push(change.at);
        pending.delete(key);
      } else if (now - change.at > PAINT_TIMEOUT_MS) {
        result.timedOut++;
        pending.delete(key);
      }
    }
    if (shown.length > 0) {
      const painted = await rendered();
      for (const at of shown) result.ms.push(painted - at);
    }
  }
  stop();
  return result;
}

/**
 * Opens the pod list, then scrolls it, sorts it and watches it change,
 * timing each in the webview (ARCHITECTURE 3.8). `steady` runs once the
 * list is open under churn, for the harness to sample memory.
 */
export async function drive(
  workbench: Workbench,
  probe: Probe,
  {
    backend,
    changesPerSecond,
    steady,
  }: { backend: string; changesPerSecond: number; steady: () => Promise<void> },
): Promise<Results> {
  const first = await open(workbench, probe);
  await sleep(1000);
  const refreshMs = await refresh();
  const scrolled = await scroll();
  const sorted = await sorts(probe);
  const list = probe.lists[probe.lists.length - 1] ?? first.list;
  await top();
  const changed = await changes(list, steady);
  return {
    backend,
    rows: list.total,
    changesPerSecond,
    refreshMs,
    firstPaint: { batchToPaintMs: first.batchToPaintMs },
    scroll: scrolled,
    sort: sorted,
    changes: changed,
  };
}
