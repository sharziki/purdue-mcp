const UA =
  "purdue-mcp/0.1 (+https://github.com/sharziki/purdue-mcp) open-source MCP server";

type CacheEntry = { at: number; value: unknown };
const cache = new Map<string, CacheEntry>();

export class UpstreamError extends Error {
  constructor(
    public url: string,
    public status: number,
    public body: string,
  ) {
    super(`upstream ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

/**
 * GET JSON with a short TTL cache. Every upstream here is public and
 * unauthenticated; the cache exists to be a polite client, not for correctness.
 */
export async function getJSON<T = any>(
  url: string,
  opts: { ttlMs?: number; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const ttl = opts.ttlMs ?? 60_000;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": UA, ...opts.headers },
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(url, res.status, text);
    let value: T;
    try {
      value = JSON.parse(text) as T;
    } catch {
      throw new UpstreamError(url, res.status, `non-JSON response: ${text.slice(0, 200)}`);
    }
    cache.set(url, { at: Date.now(), value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") p.append(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Strip HTML tags and collapse whitespace — most upstreams return HTML blobs. */
export function stripHtml(s: string | null | undefined, max = 600): string {
  if (!s) return "";
  const out = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out.length > max ? out.slice(0, max) + "…" : out;
}
