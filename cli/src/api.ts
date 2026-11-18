import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The token fast.com ships in its app bundle. We scrape a fresh one and cache it,
// falling back to this one if scraping fails.
const FALLBACK_TOKEN = "YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm";
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "fast-cli");
const tokenFile = join(cacheDir, "token");

export interface Target {
  /** Original `/speedtest?…` URL; build requests with rangeUrl(). */
  url: string;
  city: string;
  country: string;
}

export interface Session {
  ip: string;
  asn: string;
  city: string;
  country: string;
  targets: Target[];
}

async function scrapeToken(): Promise<string> {
  const headers = { "user-agent": UA };
  const html = await (await fetch("https://fast.com/", { headers, signal: AbortSignal.timeout(8000) })).text();
  const script = html.match(/app-[a-z0-9]+\.js/)?.[0];
  if (!script) throw new Error("app script not found");
  const js = await (await fetch(`https://fast.com/${script}`, { headers, signal: AbortSignal.timeout(8000) })).text();
  const token = js.match(/token:"([A-Za-z0-9]+)"/)?.[1];
  if (!token) throw new Error("token not found");
  return token;
}

async function getToken(refresh: boolean): Promise<string> {
  const file = Bun.file(tokenFile);
  if (!refresh && (await file.exists()) && Date.now() - file.lastModified < TOKEN_TTL_MS) {
    const cached = (await file.text()).trim();
    if (cached) return cached;
  }
  try {
    const token = await scrapeToken();
    await mkdir(cacheDir, { recursive: true });
    await Bun.write(tokenFile, token);
    return token;
  } catch {
    return FALLBACK_TOKEN;
  }
}

export async function getSession(urlCount = 5): Promise<Session> {
  let lastStatus = 0;
  for (const refresh of [false, true]) {
    const token = await getToken(refresh);
    const res = await fetch(
      `https://api.fast.com/netflix/speedtest/v2?https=true&token=${token}&urlCount=${urlCount}`,
      { headers: { "user-agent": UA }, signal: AbortSignal.timeout(10000) },
    );
    if (res.ok) {
      const d = (await res.json()) as any;
      const targets: Target[] = (d.targets ?? []).map((t: any) => ({
        url: String(t.url),
        city: t.location?.city ?? "",
        country: t.location?.country ?? "",
      }));
      if (!targets.length) throw new Error("fast.com returned no test servers");
      return {
        ip: d.client?.ip ?? "",
        asn: d.client?.asn ?? "",
        city: d.client?.location?.city ?? "",
        country: d.client?.location?.country ?? "",
        targets,
      };
    }
    lastStatus = res.status;
  }
  throw new Error(`fast.com API returned HTTP ${lastStatus}`);
}

/** `/speedtest?…` → `/speedtest/range/0-<bytes>?…` (the range goes in the path, before the query). */
export const rangeUrl = (t: Target, bytes: number) => t.url.replace("/speedtest", `/speedtest/range/0-${bytes}`);
