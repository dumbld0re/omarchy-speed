import { UA, rangeUrl, type Target } from "./api";

const SAMPLE_MS = 200;
const DOWNLOAD_BYTES = 25 * 1024 * 1024; // fast.com's max payload
const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const MAX_FAILS = 6;

export interface Progress {
  mbps: number;
  elapsedMs: number;
  series: number[];
}

export interface Throughput {
  mbps: number;
  bytes: number;
  durationMs: number;
  series: number[];
}

export interface RunOpts {
  connections: number;
  minMs: number;
  maxMs: number;
  /** Samples in the rolling rate window (200ms each). */
  window?: number;
  onProgress?: (p: Progress) => void;
}

interface WorkerCtx {
  add(n: number): void;
  stopped(): boolean;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Runs `connections` workers that report bytes moved, samples the total every 200ms,
 * and stops once the 1s rolling rate has been stable for 2s (after minMs) or at maxMs.
 */
async function runThroughput(
  opts: RunOpts,
  worker: (ctx: WorkerCtx, index: number) => Promise<void>,
  abort: () => void,
): Promise<Throughput> {
  let bytes = 0;
  let stopped = false;
  const ctx: WorkerCtx = { add: (n) => void (bytes += n), stopped: () => stopped };
  const t0 = performance.now();
  const samples = [{ t: 0, b: 0 }];
  const rates: number[] = [];
  let alive = opts.connections;

  const pool = Array.from({ length: opts.connections }, (_, i) =>
    worker(ctx, i)
      .catch(() => {})
      .finally(() => void alive--),
  );

  await new Promise<void>((resolve) => {
    const iv = setInterval(() => {
      const t = performance.now() - t0;
      samples.push({ t, b: bytes });
      const prev = samples[Math.max(0, samples.length - 1 - (opts.window ?? 5))]!;
      const rate = ((bytes - prev.b) * 8) / ((t - prev.t) / 1000) / 1e6;
      rates.push(rate);
      opts.onProgress?.({ mbps: rate, elapsedMs: t, series: rates });

      const recent = rates.slice(-10);
      const m = mean(recent);
      const stable = recent.length === 10 && m > 0 && (Math.max(...recent) - Math.min(...recent)) / m < 0.06;
      if ((t >= opts.minMs && stable) || t >= opts.maxMs || alive === 0) {
        clearInterval(iv);
        resolve();
      }
    }, SAMPLE_MS);
  });

  stopped = true;
  abort();
  await Promise.race([Promise.allSettled(pool), Bun.sleep(1000)]);

  if (bytes === 0) throw new Error("no data could be transferred");

  // Ignore the TCP ramp-up: measure from max(1.5s, 30% of the run) to the end.
  const end = samples.at(-1)!;
  const warmT = Math.max(1500, end.t * 0.3);
  const w = samples.find((s) => s.t >= warmT) ?? samples[0]!;
  const mbps = end.t > w.t && end.b > w.b ? ((end.b - w.b) * 8) / ((end.t - w.t) / 1000) / 1e6 : (rates.at(-1) ?? 0);
  return { mbps, bytes, durationMs: end.t, series: rates };
}

export function measureDownload(targets: Target[], opts: RunOpts): Promise<Throughput> {
  const ctrl = new AbortController();
  return runThroughput(
    opts,
    async (ctx, i) => {
      const url = rangeUrl(targets[i % targets.length]!, DOWNLOAD_BYTES);
      let fails = 0;
      while (!ctx.stopped()) {
        try {
          const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA } });
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          for await (const chunk of res.body) {
            ctx.add(chunk.byteLength);
            if (ctx.stopped()) break;
          }
        } catch {
          if (ctx.stopped() || ++fails >= MAX_FAILS) return;
          await Bun.sleep(250);
        }
      }
    },
    () => ctrl.abort(),
  );
}

export function measureUpload(targets: Target[], opts: RunOpts): Promise<Throughput> {
  const ctrl = new AbortController();
  const payload = new Uint8Array(UPLOAD_MAX_BYTES);
  return runThroughput(
    { window: 10, ...opts },
    async (ctx, i) => {
      // Bytes only count once the server has acknowledged the whole body. Counting at
      // write time overstates upload massively, because the kernel's send buffer
      // swallows megabytes instantly. Request size adapts so each takes about 1s.
      const target = targets[i % targets.length]!;
      let size = 256 * 1024;
      let lastMs = 2500;
      let fails = 0;
      while (!ctx.stopped()) {
        const t = performance.now();
        try {
          // Netflix's servers occasionally swallow a body and never answer, so give each
          // request a deadline and retry instead of letting one stall the connection.
          const deadline = Math.max(4000, lastMs * 4);
          const res = await fetch(rangeUrl(target, size), {
            method: "POST",
            body: payload.subarray(0, size),
            headers: { "content-type": "application/octet-stream", "user-agent": UA },
            signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(deadline)]),
          });
          await res.arrayBuffer();
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (ctx.stopped()) return;
          ctx.add(size);
          fails = 0;
          lastMs = performance.now() - t;
          if (lastMs < 1000) size = Math.min(size * 2, UPLOAD_MAX_BYTES);
        } catch {
          if (ctx.stopped() || ++fails >= MAX_FAILS) return;
          await Bun.sleep(250);
        }
      }
    },
    () => ctrl.abort(),
  );
}

async function ping(target: Target): Promise<number> {
  const t = performance.now();
  const res = await fetch(rangeUrl(target, 0), {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(5000),
  });
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return performance.now() - t;
}

export interface Latency {
  ms: number;
  jitter: number;
  samples: number[];
}

/** Idle round-trip time: one warm-up request (TLS handshake), then `count` timed ones. */
export async function measureLatency(target: Target, count = 10, onSample?: (ms: number) => void): Promise<Latency> {
  await ping(target).catch(() => {});
  const xs: number[] = [];
  for (let i = 0; i < count; i++) {
    try {
      const ms = await ping(target);
      xs.push(ms);
      onSample?.(median(xs));
    } catch {}
  }
  return summarize(xs);
}

function summarize(xs: number[]): Latency {
  const jitter = xs.length > 1 ? mean(xs.slice(1).map((x, i) => Math.abs(x - xs[i]!))) : 0;
  return { ms: median(xs), jitter, samples: xs };
}

/** Pings repeatedly while a throughput test runs, to measure latency under load. */
export function startLoadedPinger(target: Target, onSample?: (ms: number) => void) {
  let running = true;
  const xs: number[] = [];
  const loop = (async () => {
    await Bun.sleep(800); // let the link saturate first
    while (running) {
      try {
        const ms = await ping(target);
        if (running) {
          xs.push(ms);
          onSample?.(median(xs));
        }
      } catch {}
      await Bun.sleep(200);
    }
  })();
  return {
    async stop(): Promise<number[]> {
      running = false;
      await Promise.race([loop, Bun.sleep(500)]);
      return xs;
    },
  };
}

/** Bufferbloat grade from how much latency grows under load (Waveform-style bands). */
export function bufferbloatGrade(unloaded: number, loaded: number): string {
  const d = loaded - unloaded;
  if (d < 5) return "A+";
  if (d < 30) return "A";
  if (d < 60) return "B";
  if (d < 200) return "C";
  if (d < 400) return "D";
  return "F";
}
