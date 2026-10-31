"use strict";

const { invoke, Channel } = window.__TAURI__.core;

const INVOKE_CASES = [
  { label: "1 KB", bytes: 1024, calls: 2000 },
  { label: "64 KB", bytes: 64 * 1024, calls: 500 },
];
const WARM_UP_CALLS = 100;
const BLOCK = 50;

// Unpaced cases send the next batch as soon as the previous one is
// acknowledged; paced cases flush every 50 ms, as 3.5 does.
const CHANNEL_CASES = [
  {
    label: "2 KB, unpaced",
    streams: 1,
    bytes: 2 * 1024,
    batches: 1000,
    intervalMs: 0,
  },
  {
    label: "64 KB, unpaced",
    streams: 1,
    bytes: 64 * 1024,
    batches: 300,
    intervalMs: 0,
  },
  {
    label: "1 MB, unpaced",
    streams: 1,
    bytes: 1024 * 1024,
    batches: 30,
    intervalMs: 0,
  },
  {
    label: "20 × 4 KB every 50 ms",
    streams: 20,
    bytes: 4 * 1024,
    batches: 100,
    intervalMs: 50,
  },
  {
    label: "5 × 64 KB every 50 ms",
    streams: 5,
    bytes: 64 * 1024,
    batches: 100,
    intervalMs: 50,
  },
];

const FRAME_REPORT_TIMEOUT_MS = 10_000;
// Lets requests the probe frame sent without waiting for an answer land in Rust
// before the probe counts are read.
const SETTLE_MS = 1000;

function status(text) {
  document.getElementById("status").textContent = text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  const mean = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return {
    n: sorted.length,
    mean,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
  };
}

function clockResolutionMs() {
  let smallest = Infinity;
  for (let i = 0; i < 1000; i++) {
    const start = performance.now();
    let next = performance.now();
    while (next === start) next = performance.now();
    smallest = Math.min(smallest, next - start);
  }
  return smallest;
}

async function measureInvoke({ label, bytes, calls }) {
  status(`invoke ${label}`);
  const data = "x".repeat(bytes);
  for (let i = 0; i < WARM_UP_CALLS; i++) await invoke("echo", { data });

  const perCall = [];
  const perBlock = [];
  const start = performance.now();
  let blockStart = start;
  for (let i = 1; i <= calls; i++) {
    const callStart = performance.now();
    const echoed = await invoke("echo", { data });
    const end = performance.now();
    if (echoed.length !== bytes)
      throw new Error(`echo returned ${echoed.length} bytes, not ${bytes}`);
    perCall.push(end - callStart);
    if (i % BLOCK === 0) {
      perBlock.push((end - blockStart) / BLOCK);
      blockStart = end;
    }
  }
  return {
    label,
    bytes,
    calls,
    totalMs: performance.now() - start,
    perCallMs: summary(perCall),
    blockMeanMs: summary(perBlock),
  };
}

let nextStream = 0;

function runStream(bytes, batches, intervalMs) {
  const id = nextStream++;
  const channel = new Channel((batch) => {
    invoke("ack", { stream: id, seq: batch.seq }).catch(fail);
  });
  return invoke("stream", { id, bytes, batches, intervalMs, channel });
}

async function measureChannel({ label, streams, bytes, batches, intervalMs }) {
  status(`channel ${label}`);
  const results = await Promise.all(
    Array.from({ length: streams }, () =>
      runStream(bytes, batches, intervalMs),
    ),
  );
  const elapsedMs = Math.max(...results.map((r) => r.elapsedMs));
  const sent = results.reduce((sum, r) => sum + r.batches, 0);
  const sentBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  return {
    label,
    streams,
    bytes,
    intervalMs,
    batches: sent,
    elapsedMs,
    batchesPerSecond: sent / (elapsedMs / 1000),
    megabytesPerSecond: sentBytes / (1024 * 1024) / (elapsedMs / 1000),
    sendToAckMs: summary(results.flatMap((r) => r.sendToAckMs)),
  };
}

async function measureCost() {
  const invokes = [];
  for (const c of INVOKE_CASES) invokes.push(await measureInvoke(c));
  const channels = [];
  for (const c of CHANNEL_CASES) channels.push(await measureChannel(c));
  return { invokes, channels };
}

function runFrame(src, sandbox) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", sandbox);
    frame.src = src;
    const timer = setTimeout(() => {
      reject(
        new Error(`${src} sent no report within ${FRAME_REPORT_TIMEOUT_MS} ms`),
      );
    }, FRAME_REPORT_TIMEOUT_MS);
    window.addEventListener("message", function onReport(event) {
      if (
        event.source !== frame.contentWindow ||
        event.data?.type !== "twigo-probe-report"
      )
        return;
      window.removeEventListener("message", onReport);
      clearTimeout(timer);
      resolve({
        src,
        sandbox,
        origin: event.origin,
        attempts: event.data.attempts,
      });
    });
    document.body.append(frame);
  });
}

async function probeFrames() {
  status("frames");
  const control = await runFrame(
    "control.html",
    "allow-scripts allow-same-origin",
  );
  const probe = await runFrame("twigo-ext://probe/probe.html", "allow-scripts");
  await sleep(SETTLE_MS);
  await invoke("probe", { source: "main" });
  return { control, probe };
}

function fail(error) {
  invoke("fail", { message: `${error}\n${error?.stack ?? ""}` });
}

async function main() {
  const mode = await invoke("mode");
  const results = {
    mode,
    pattern: window.__TAURI_INTERNALS__.__TAURI_PATTERN__.pattern,
    userAgent: navigator.userAgent,
    clockResolutionMs: clockResolutionMs(),
  };
  if (mode !== "frames") results.cost = await measureCost();
  if (mode !== "cost") results.frames = await probeFrames();
  status("done");
  await invoke("report", { results });
}

main().catch(fail);
