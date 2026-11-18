#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { getSession, type Session } from "./api";
import * as history from "./history";
import type { Result } from "./history";
import {
  bufferbloatGrade,
  measureDownload,
  measureLatency,
  measureUpload,
  median,
  startLoadedPinger,
} from "./measure";
import {
  LiveBlock,
  bigText,
  bytesStr,
  c,
  isTTY,
  pad,
  padL,
  restoreCursor,
  spark,
  speed,
  speedStr,
  spinner,
} from "./ui";

const VERSION = "0.1.0";

const HELP = `
  ${c.bold("speed")} ${c.dim(`v${VERSION}`)}  ${c.dim("fast.com in your terminal")}

  ${c.dim("usage")}
    speed                    full test: latency, download, upload
    speedhistory             past results, trend, best hours
    speedlast                most recent result (no new test)
    speedwatch [15m]         test on an interval and log it

  ${c.dim("options")}
    -s, --simple             download only, like the fast.com front page
    -u, --no-upload          skip the upload test
    -t, --time <sec>         max seconds per phase              ${c.dim("(15)")}
    -c, --connections <n>    parallel connections               ${c.dim("(8)")}
    -n, --notify             desktop notification when done
        --json               print JSON instead of the live view
        --waybar             print a Waybar custom-module JSON line
        --stream             JSON lines while testing (for bar widgets)
        --ip                 show your public IP
        --no-save            don't record to history

  ${c.dim("history")}
        --limit <n>          rows to show                       ${c.dim("(20)")}
        --csv                export everything as CSV
        --clear              delete all history

  ${c.dim("watch")}
        --below <mbps>       notify when download drops below this

  ${c.dim(`history → ${history.dbPath}`)}
  ${c.dim("accent → FAST_ACCENT=<ansi sgr>   no color → NO_COLOR=1")}
`;

type Opts = {
  simple: boolean;
  upload: boolean;
  maxMs: number;
  connections: number;
  json: boolean;
  waybar: boolean;
  ip: boolean;
  save: boolean;
  notify: boolean;
  quiet: boolean;
  stream: boolean;
};

// ─── test run ──────────────────────────────────────────────────────────────────

type Phase = "connect" | "latency" | "download" | "upload" | "done";
interface Leg {
  mbps: number;
  series: number[];
  done: boolean;
}
interface State {
  phase: Phase;
  frame: number;
  session?: Session;
  down?: Leg;
  up?: Leg;
  ping?: number;
  jitter?: number;
  loaded?: number;
  bytes: number;
  elapsedMs: number;
  saved: boolean;
}

function serverSummary(s: Session): string {
  const counts = new Map<string, number>();
  for (const t of s.targets) {
    const k = [t.city, t.country].filter(Boolean).join(" ");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(" · ");
}

function render(st: State, opts: Opts, withHero: boolean): string[] {
  const out: string[] = [""];
  const ICON_W = 2;

  if (withHero) {
    const leg = st.phase === "upload" ? st.up : st.down;
    const label =
      st.phase === "upload" ? "upload speed" : st.phase === "done" ? "your internet speed" : "download speed";
    const sp = leg && leg.mbps > 0 ? speed(leg.mbps) : null;
    const big = bigText(sp ? sp.value : "–");
    const live = st.phase === "download" || st.phase === "upload";
    const paint = live ? c.strong : c.bold;
    out.push(`  ${paint(big[0])}`);
    out.push(`  ${paint(big[1])}   ${c.dim(label)}`);
    out.push(`  ${paint(big[2])}   ${sp ? sp.unit : ""}`);
    out.push("");
  }

  const icon = (active: boolean, done: boolean, glyph: string) =>
    active ? c.accent(spinner(st.frame)) : done ? c.accent(glyph) : c.dim(glyph);
  const leg = (name: string, glyph: string, phase: Phase, l?: Leg) => {
    const active = st.phase === phase;
    const value = l && (l.mbps > 0 || l.done) ? speedStr(l.mbps) : active ? c.dim("…") : c.dim("—");
    const line = l ? (active ? c.accent(spark(l.series)) : c.dim(spark(l.series))) : "";
    return `  ${pad(icon(active, !!l?.done, glyph), ICON_W)}${pad(name, 10)}${padL(l?.done ? c.bold(value) : value, 10)}   ${line}`;
  };

  out.push(leg("download", "↓", "download", st.down));
  if (opts.upload && !opts.simple) out.push(leg("upload", "↑", "upload", st.up));

  if (!opts.simple) {
    const latActive = st.phase === "latency";
    const latDone = st.ping !== undefined && st.phase !== "latency";
    let lat = st.ping !== undefined ? `${Math.round(st.ping)} ms` : latActive ? c.dim("…") : c.dim("—");
    if (latDone) lat = c.bold(lat);
    let tail = "";
    if (st.ping !== undefined && !latActive) tail += c.dim(`idle  ±${Math.round(st.jitter ?? 0)} jitter`);
    if (st.loaded !== undefined) {
      const grade = bufferbloatGrade(st.ping ?? 0, st.loaded);
      tail += c.dim(`  ·  ${Math.round(st.loaded)} ms loaded  ·  bufferbloat `) + c.bold(grade);
    }
    out.push(`  ${pad(icon(latActive, latDone, "◦"), ICON_W)}${pad("latency", 10)}${padL(lat, 10)}   ${tail}`);
  }

  out.push("");
  if (st.session) {
    const s = st.session;
    const where = [`AS${s.asn}`, [s.city, s.country].filter(Boolean).join(", ")];
    if (opts.ip) where.push(s.ip);
    out.push(c.dim(`  ${where.filter(Boolean).join(" · ")}  →  ${serverSummary(s)}`));
  } else {
    out.push(`  ${c.accent(spinner(st.frame))} ${c.dim("finding fast.com servers…")}`);
  }
  if (st.phase === "done") {
    const bits = [`used ${bytesStr(st.bytes)}`, `${(st.elapsedMs / 1000).toFixed(1)}s`];
    if (st.saved) bits.push("saved to history");
    out.push(c.dim(`  ${bits.join(" · ")}`));
  }
  out.push("");
  return out;
}

async function runTest(opts: Opts): Promise<Result> {
  const st: State = { phase: "connect", frame: 0, bytes: 0, elapsedMs: 0, saved: false };
  const live = isTTY && !opts.json && !opts.waybar && !opts.quiet && !opts.stream;
  // --stream: one JSON line per tick, for the bar widget (or anything else) to follow along.
  const emit = () =>
    console.log(
      JSON.stringify({
        event: "progress",
        phase: st.phase,
        downloadMbps: st.down ? round(st.down.mbps) : null,
        uploadMbps: st.up ? round(st.up.mbps) : null,
        latencyMs: st.ping !== undefined ? round(st.ping) : null,
        loadedLatencyMs: st.loaded !== undefined ? round(st.loaded) : null,
      }),
    );
  const streamTicker = opts.stream ? setInterval(emit, 250) : undefined;
  const block = new LiveBlock();
  let ticker: Timer | undefined;
  if (live) {
    block.start();
    ticker = setInterval(() => {
      st.frame++;
      block.draw(render(st, opts, true));
    }, 80);
  }
  const t0 = performance.now();
  const phaseOpts = { connections: opts.connections, minMs: Math.min(6000, opts.maxMs), maxMs: opts.maxMs };

  try {
    const session = await getSession(5);
    st.session = session;
    const nearest = session.targets[0]!;

    if (!opts.simple) {
      st.phase = "latency";
      const lat = await measureLatency(nearest, 10, (ms) => (st.ping = ms));
      st.ping = lat.ms;
      st.jitter = lat.jitter;
    }

    st.phase = "download";
    st.down = { mbps: 0, series: [], done: false };
    const loadedSamples: number[] = [];
    const showLoaded = () => {
      if (loadedSamples.length) st.loaded = median(loadedSamples);
    };
    let pinger = opts.simple ? null : startLoadedPinger(nearest);
    const down = await measureDownload(session.targets, {
      ...phaseOpts,
      onProgress: (p) => Object.assign(st.down!, { mbps: p.mbps, series: p.series }),
    });
    Object.assign(st.down, { mbps: down.mbps, series: down.series, done: true });
    if (pinger) loadedSamples.push(...(await pinger.stop()));
    showLoaded();
    st.bytes += down.bytes;

    let up: Awaited<ReturnType<typeof measureUpload>> | null = null;
    if (opts.upload && !opts.simple) {
      st.phase = "upload";
      st.up = { mbps: 0, series: [], done: false };
      pinger = startLoadedPinger(nearest);
      up = await measureUpload(session.targets, {
        ...phaseOpts,
        connections: Math.max(1, Math.ceil(opts.connections / 2)),
        onProgress: (p) => Object.assign(st.up!, { mbps: p.mbps, series: p.series }),
      });
      Object.assign(st.up, { mbps: up.mbps, series: up.series, done: true });
      loadedSamples.push(...(await pinger.stop()));
      showLoaded();
      st.bytes += up.bytes;
    }

    st.phase = "done";
    st.elapsedMs = performance.now() - t0;
    clearInterval(streamTicker);

    const result: Result = {
      ts: Date.now(),
      down: down.mbps,
      up: up?.mbps ?? null,
      ping: st.ping ?? null,
      pingLoaded: st.loaded ?? null,
      jitter: st.jitter ?? null,
      bytes: st.bytes,
      durationMs: st.elapsedMs,
      ip: session.ip,
      asn: session.asn,
      city: session.city,
      country: session.country,
      servers: session.targets.map((t) => [t.city, t.country].filter(Boolean).join(", ")),
    };
    if (opts.save) {
      try {
        history.save(result);
        st.saved = true;
      } catch {}
    }

    if (live) {
      clearInterval(ticker);
      block.finish(render(st, opts, true));
    } else if (!opts.json && !opts.waybar && !opts.quiet && !opts.stream) {
      console.log(render(st, opts, false).join("\n"));
    }
    return result;
  } catch (e) {
    clearInterval(streamTicker);
    if (live) {
      clearInterval(ticker);
      block.stop();
    }
    throw e;
  }
}

// ─── output formats ────────────────────────────────────────────────────────────

function toJSON(r: Result, opts: Pick<Opts, "ip">) {
  return {
    timestamp: new Date(r.ts).toISOString(),
    downloadMbps: round(r.down),
    uploadMbps: r.up === null ? null : round(r.up),
    latencyMs: r.ping === null ? null : round(r.ping),
    loadedLatencyMs: r.pingLoaded === null ? null : round(r.pingLoaded),
    jitterMs: r.jitter === null ? null : round(r.jitter),
    bufferbloat: r.ping !== null && r.pingLoaded !== null ? bufferbloatGrade(r.ping, r.pingLoaded) : null,
    bytesUsed: r.bytes,
    durationMs: Math.round(r.durationMs),
    client: { ...(opts.ip && r.ip ? { ip: r.ip } : {}), asn: r.asn, city: r.city, country: r.country },
    servers: r.servers,
  };
}
const round = (n: number) => Math.round(n * 100) / 100;

function toWaybar(r: Result | null) {
  if (!r) return { text: "↓ –", tooltip: "no results yet — run `speed`", class: "empty" };
  const s = speed(r.down);
  const text = r.up !== null ? `↓ ${s.value} ↑ ${speed(r.up).value}` : `↓ ${s.value}`;
  const when = new Date(r.ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const lines = [
    `download  ${speedStr(r.down)}`,
    r.up !== null ? `upload    ${speedStr(r.up)}` : null,
    r.ping !== null ? `latency   ${Math.round(r.ping)} ms${r.pingLoaded !== null ? ` / ${Math.round(r.pingLoaded)} ms loaded` : ""}` : null,
    when,
  ].filter(Boolean);
  const cls = r.down < 5 ? "slow" : r.down < 25 ? "ok" : "fast";
  return { text, tooltip: lines.join("\n"), class: cls, alt: cls };
}

function notify(r: Result, urgent = false) {
  const body = [
    `↓ ${speedStr(r.down)}`,
    r.up !== null ? `↑ ${speedStr(r.up)}` : "",
    r.ping !== null ? `${Math.round(r.ping)} ms` : "",
  ]
    .filter(Boolean)
    .join("   ");
  try {
    Bun.spawn(["notify-send", "-a", "speed", ...(urgent ? ["-u", "critical"] : []), urgent ? "Internet is slow" : "Speed test done", body], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {}
}

// ─── history ───────────────────────────────────────────────────────────────────

function showHistory(limit: number) {
  const rows = history.recent(limit);
  const total = history.count();
  if (!rows.length) {
    console.log(`\n  ${c.dim("no tests yet — run")} speed\n`);
    return;
  }
  const downs = rows.map((r) => r.down);
  const avg = downs.reduce((a, b) => a + b, 0) / downs.length;
  const best = Math.max(...downs);
  const worst = Math.min(...downs);

  const out: string[] = [""];
  out.push(
    `  ${c.bold("history")}  ${c.dim(`${rows.length} of ${total}`)}     ${c.dim("avg")} ${speedStr(avg)}   ${c.dim("best")} ${speedStr(best)}   ${c.dim("worst")} ${speedStr(worst)}`,
  );
  out.push("");
  out.push(`  ${c.accent(spark(downs, 48, best))}  ${c.dim("↓ old → new")}`);
  const ups = rows.map((r) => r.up).filter((x): x is number => x !== null);
  if (ups.length > 1) out.push(`  ${c.dim(spark(ups, 48))}  ${c.dim("↑")}`);
  out.push("");
  out.push(
    c.dim(`  ${pad("when", 18)}${padL("down", 11)}${padL("up", 11)}${padL("ping", 8)}${padL("loaded", 9)}   where`),
  );

  let lastDay = "";
  for (const r of [...rows].reverse()) {
    const d = new Date(r.ts);
    const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const when = day === lastDay ? `${" ".repeat(day.length)} ${time}` : `${day} ${time}`;
    lastDay = day;
    const isBest = r.down === best && rows.length > 1;
    const down = isBest ? c.accent(speedStr(r.down)) : speedStr(r.down);
    out.push(
      `  ${pad(c.dim(when), 18)}${padL(down, 11)}${padL(r.up !== null ? speedStr(r.up) : c.dim("—"), 11)}${padL(r.ping !== null ? `${Math.round(r.ping)} ms` : c.dim("—"), 8)}${padL(r.pingLoaded !== null ? `${Math.round(r.pingLoaded)} ms` : c.dim("—"), 9)}   ${c.dim(r.city)}`,
    );
  }

  // Time-of-day profile, once there's enough data to mean something.
  const everything = history.all();
  if (everything.length >= 12) {
    const buckets = Array.from({ length: 8 }, () => [] as number[]);
    for (const r of everything) buckets[Math.floor(new Date(r.ts).getHours() / 3)]!.push(r.down);
    const avgs = buckets.map((b) => (b.length ? b.reduce((x, y) => x + y, 0) / b.length : 0));
    const top = Math.max(...avgs);
    const bestIdx = avgs.indexOf(top);
    out.push("");
    out.push(`  ${c.dim("by time of day")}`);
    out.push(
      "  " +
        avgs
          .map((a, i) => {
            const bar = a ? spark([a], 1, top) : " ";
            return pad(i === bestIdx ? c.accent(bar) : c.dim(bar), 2) + c.dim(String(i * 3).padStart(2, "0")) + "  ";
          })
          .join(""),
    );
    out.push(c.dim(`  fastest around ${String(bestIdx * 3).padStart(2, "0")}:00–${String(bestIdx * 3 + 3).padStart(2, "0")}:00, avg ${speedStr(top)}`));
  }
  out.push("");
  console.log(out.join("\n"));
}

function exportCSV() {
  const esc = (v: unknown) => (v === null || v === undefined ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  console.log("timestamp,download_mbps,upload_mbps,latency_ms,loaded_latency_ms,jitter_ms,bytes,duration_ms,asn,city,country");
  for (const r of history.all())
    console.log(
      [new Date(r.ts).toISOString(), round(r.down), r.up && round(r.up), r.ping && round(r.ping), r.pingLoaded && round(r.pingLoaded), r.jitter && round(r.jitter), r.bytes, r.durationMs, r.asn, r.city, r.country]
        .map(esc)
        .join(","),
    );
}

// ─── watch ─────────────────────────────────────────────────────────────────────

function parseInterval(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new Error(`bad interval "${s}" — try 30s, 15m or 1h`);
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "m").toLowerCase();
  return n * (unit === "s" ? 1000 : unit === "h" ? 3600_000 : 60_000);
}

async function watch(intervalMs: number, opts: Opts, below: number | null) {
  console.log(
    `\n  ${c.bold("watching")} ${c.dim(`every ${intervalMs / 60000 >= 1 ? `${intervalMs / 60000}m` : `${intervalMs / 1000}s`}${below !== null ? `, alert below ${below} Mbps` : ""} · ctrl-c to stop`)}\n`,
  );
  for (;;) {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (isTTY) process.stdout.write(`  ${c.dim(time)}  ${c.dim("testing…")}`);
    try {
      const r = await runTest({ ...opts, quiet: true });
      const slow = below !== null && r.down < below;
      const line = [
        `↓ ${padL(speedStr(r.down), 10)}`,
        r.up !== null ? `↑ ${padL(speedStr(r.up), 10)}` : "",
        r.ping !== null ? c.dim(`${Math.round(r.ping)} ms`) : "",
        slow ? c.accent("● slow") : "",
      ].filter(Boolean).join("   ");
      if (isTTY) process.stdout.write("\r\x1b[2K");
      console.log(`  ${c.dim(time)}  ${line}`);
      if (slow) notify(r, true);
      else if (opts.notify) notify(r);
    } catch (e) {
      if (isTTY) process.stdout.write("\r\x1b[2K");
      console.log(`  ${c.dim(time)}  ${c.dim(`failed: ${(e as Error).message}`)}`);
    }
    await Bun.sleep(intervalMs);
  }
}

// ─── main ──────────────────────────────────────────────────────────────────────

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        simple: { type: "boolean", short: "s" },
        "no-upload": { type: "boolean", short: "u" },
        time: { type: "string", short: "t" },
        connections: { type: "string", short: "c" },
        notify: { type: "boolean", short: "n" },
        json: { type: "boolean" },
        stream: { type: "boolean" },
        waybar: { type: "boolean" },
        ip: { type: "boolean" },
        "no-save": { type: "boolean" },
        limit: { type: "string" },
        csv: { type: "boolean" },
        clear: { type: "boolean" },
        below: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    console.error(`  ${(e as Error).message}\n  run ${c.bold("speed --help")}`);
    process.exit(2);
  }
  const { values: v, positionals } = parsed;
  if (v.help) return void console.log(HELP);
  if (v.version) return void console.log(VERSION);

  const num = (s: string | undefined, def: number, name: string) => {
    if (s === undefined) return def;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number`);
    return n;
  };

  const opts: Opts = {
    simple: !!v.simple,
    upload: !v["no-upload"],
    maxMs: num(v.time, 15, "time") * 1000,
    connections: Math.round(num(v.connections, 8, "connections")),
    json: !!v.json,
    waybar: !!v.waybar,
    ip: !!v.ip,
    save: !v["no-save"],
    notify: !!v.notify,
    quiet: false,
    stream: !!v.stream,
  };

  const [cmd = "run", arg] = positionals;
  switch (cmd) {
    case "run": {
      const r = await runTest(opts);
      if (opts.stream) console.log(JSON.stringify({ event: "result", ...toJSON(r, opts) }));
      if (opts.json) console.log(JSON.stringify(toJSON(r, opts), null, 2));
      if (opts.waybar) console.log(JSON.stringify(toWaybar(r)));
      if (opts.notify) notify(r);
      return;
    }
    case "history":
    case "h":
      if (v.clear) {
        const n = history.count();
        history.clear();
        return void console.log(`  ${c.dim(`deleted ${n} results`)}`);
      }
      if (v.csv) return exportCSV();
      if (opts.json) return void console.log(JSON.stringify(history.recent(num(v.limit, 20, "limit")).map((r) => toJSON(r, opts)), null, 2));
      return showHistory(num(v.limit, 20, "limit"));
    case "last": {
      const r = history.recent(1)[0] ?? null;
      if (opts.waybar) return void console.log(JSON.stringify(toWaybar(r)));
      if (!r) return void console.log(`\n  ${c.dim("no tests yet — run")} speed\n`);
      if (opts.json) return void console.log(JSON.stringify(toJSON(r, opts), null, 2));
      const ago = Math.round((Date.now() - r.ts) / 60000);
      const agoStr = ago < 1 ? "just now" : ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
      return void console.log(
        `  ↓ ${c.bold(speedStr(r.down))}${r.up !== null ? `   ↑ ${c.bold(speedStr(r.up))}` : ""}${r.ping !== null ? `   ${Math.round(r.ping)} ms` : ""}   ${c.dim(agoStr)}`,
      );
    }
    case "watch":
    case "w":
      return watch(parseInterval(arg ?? "15m"), opts, v.below !== undefined ? num(v.below, 0, "below") : null);
    case "help":
      return void console.log(HELP);
    default:
      console.error(`  unknown command "${cmd}" — run ${c.bold("speed --help")}`);
      process.exit(2);
  }
}

process.on("SIGINT", () => {
  restoreCursor();
  process.stdout.write("\n");
  process.exit(130);
});

main().catch((e) => {
  restoreCursor();
  const msg = (e as Error).message || String(e);
  if (process.argv.includes("--stream")) {
    console.log(JSON.stringify({ event: "error", message: msg }));
    process.exit(1);
  }
  const offline = /unable to connect|ENOTFOUND|ECONNREFUSED|fetch failed|timed out|network/i.test(msg);
  console.error(`\n  ${c.accent("✕")} ${offline ? "can't reach fast.com — are you online?" : msg}\n`);
  process.exit(1);
});
