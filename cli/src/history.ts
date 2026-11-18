import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Result {
  ts: number;
  down: number;
  up: number | null;
  ping: number | null;
  pingLoaded: number | null;
  jitter: number | null;
  bytes: number;
  durationMs: number;
  ip: string;
  asn: string;
  city: string;
  country: string;
  servers: string[];
}

const dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "fast-cli");
export const dbPath = join(dir, "history.db");

let db: Database | null = null;
function open(): Database {
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS tests (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    down REAL NOT NULL,
    up REAL,
    ping REAL,
    ping_loaded REAL,
    jitter REAL,
    bytes INTEGER,
    duration_ms INTEGER,
    asn TEXT,
    city TEXT,
    country TEXT,
    servers TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS tests_ts ON tests(ts)");
  return db;
}

export function save(r: Result) {
  open()
    .query(
      `INSERT INTO tests (ts, down, up, ping, ping_loaded, jitter, bytes, duration_ms, asn, city, country, servers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.ts, r.down, r.up, r.ping, r.pingLoaded, r.jitter, r.bytes, Math.round(r.durationMs),
      r.asn, r.city, r.country, JSON.stringify(r.servers),
    );
}

const fromRow = (row: any): Result => ({
  ts: row.ts,
  down: row.down,
  up: row.up,
  ping: row.ping,
  pingLoaded: row.ping_loaded,
  jitter: row.jitter,
  bytes: row.bytes ?? 0,
  durationMs: row.duration_ms ?? 0,
  ip: "",
  asn: row.asn ?? "",
  city: row.city ?? "",
  country: row.country ?? "",
  servers: JSON.parse(row.servers || "[]"),
});

/** Most recent `limit` results, oldest first. */
export function recent(limit: number): Result[] {
  return open()
    .query("SELECT * FROM (SELECT * FROM tests ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC")
    .all(limit)
    .map(fromRow);
}

export function all(): Result[] {
  return open().query("SELECT * FROM tests ORDER BY ts ASC").all().map(fromRow);
}

export function count(): number {
  return (open().query("SELECT COUNT(*) AS n FROM tests").get() as any).n;
}

export function clear() {
  open().run("DELETE FROM tests");
}
