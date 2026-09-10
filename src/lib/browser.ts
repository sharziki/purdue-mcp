import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, platform, userInfo } from "node:os";

/**
 * Finding and driving a Chrome the user already has.
 *
 * Nothing here downloads a browser — `puppeteer-core` is the launcher only, so
 * the package stays a few megabytes. Firefox cannot be used: it does not speak
 * the DevTools protocol.
 */

const BIN_NAMES: Record<string, string[]> = {
  linux: [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
  ],
  darwin: [],
  win32: [],
};

const KNOWN_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    `${homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ],
};

/**
 * Sandboxed wrappers, tried only when nothing else exists. A flatpak Chrome
 * starts inside its own sandbox and does not reliably hand the launcher a
 * debug channel back: on this machine it worked once and then hung, which is
 * worse than not working. Real binaries first, always.
 */
const SANDBOXED = [
  "/var/lib/flatpak/exports/bin/com.google.Chrome",
  `${homedir()}/.local/share/flatpak/exports/bin/com.google.Chrome`,
  "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
  "/snap/bin/chromium",
];

const isSandboxed = (path: string) => /flatpak|snap/.test(path);

/** Whatever puppeteer downloaded for some other project on this machine. */
function puppeteerCache(): string[] {
  const root = join(homedir(), ".cache", "puppeteer", "chrome");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .flatMap((dir) =>
        ["chrome-linux64/chrome", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-win64/chrome.exe"].map(
          (rel) => join(root, dir, rel),
        ),
      );
  } catch {
    return [];
  }
}

function onPath(name: string): string | null {
  const exts = platform() === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/** The first Chrome-family binary on this machine, or null. */
export function findChrome(): string | null {
  const explicit = process.env.PURDUE_MCP_CHROME || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const os = platform();
  for (const name of BIN_NAMES[os] ?? []) {
    const hit = onPath(name);
    if (hit) return hit;
  }
  for (const path of [...(KNOWN_PATHS[os] ?? []), ...puppeteerCache(), ...SANDBOXED]) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

export class NoBrowserError extends Error {
  constructor() {
    super(
      "No Chrome, Chromium, Edge or Brave found. Install one, or set PURDUE_MCP_CHROME " +
        "to the binary. Firefox cannot be used — it does not speak the DevTools protocol.",
    );
  }
}

/**
 * Load `pageUrl` in a throwaway profile, wait for `ready` to match the title,
 * then run `fetch(apiPath)` from inside that page and return the parsed JSON.
 *
 * The fetch has to happen in-page: whatever the challenge issued to get the
 * document is what makes the API call succeed, and it never leaves the browser.
 */
export async function fetchInPage<T>(
  pageUrl: string,
  apiPath: string,
  opts: { ready?: RegExp; timeoutMs?: number; onStatus?: (msg: string) => void } = {},
): Promise<T> {
  const executablePath = findChrome();
  if (!executablePath) throw new NoBrowserError();

  const timeout = opts.timeoutMs ?? 45_000;
  const say = opts.onStatus ?? (() => {});
  say(`browser: ${executablePath}`);

  const { launch } = await import("puppeteer-core");
  const browser = await launch({
    executablePath,
    headless: true,
    timeout: 30_000,
    // Root has no usable sandbox (containers, CI); a desktop user does.
    args: [
      "--disable-gpu",
      "--disable-dev-shm-usage",
      ...(userInfo().uid === 0 ? ["--no-sandbox"] : []),
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout });

    if (opts.ready) {
      const pattern = opts.ready;
      await page
        .waitForFunction((re: string) => new RegExp(re).test(document.title), { timeout: 30_000 }, pattern.source)
        .catch(() => {});
      const title = await page.title();
      if (!pattern.test(title)) {
        throw new Error(
          `the page never finished loading (title: "${title}"). If it says "Security Checkpoint", ` +
            "this network's IP is being challenged — try a different connection.",
        );
      }
    }

    const res = await page.evaluate(async (path: string) => {
      const r = await fetch(path, { headers: { Accept: "application/json" } });
      return { status: r.status, body: await r.text() };
    }, apiPath);

    if (res.status !== 200) throw new Error(`upstream ${res.status}: ${res.body.slice(0, 200)}`);
    return JSON.parse(res.body) as T;
  } catch (e) {
    const err = e as Error;
    if (isSandboxed(executablePath) && /timeout|timed out|target closed/i.test(err.message)) {
      throw new Error(
        `${executablePath} is a sandboxed (flatpak/snap) browser and did not respond — those ` +
          "hand automation an unreliable debug channel. Install a normal Chrome or Chromium, " +
          "or set PURDUE_MCP_CHROME to one.",
      );
    }
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}
