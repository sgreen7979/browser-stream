import { createRequire } from "node:module";
import type { ErrorCode } from "../types.js";

const require = createRequire(import.meta.url);
const CDP = require("chrome-remote-interface");
const chromeLauncher = require("chrome-launcher");

export interface CDPClient {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  on: (event: string, cb: (params: any) => void) => void;
  off: (event: string, cb: (params: any) => void) => void;
  close: () => Promise<void>;
}

interface LaunchedChrome {
  port: number;
  kill: () => Promise<void>;
}

let chrome: LaunchedChrome | null = null;
let client: CDPClient | null = null;
let crashed = false;

export function isCrashed(): boolean {
  return crashed;
}

export function isConnected(): boolean {
  return client !== null && !crashed;
}

export async function connect(cdpUrl?: string): Promise<CDPClient> {
  if (client) return client;

  let port: number;

  if (cdpUrl) {
    // Parse port from CDP URL like ws://127.0.0.1:9222/...
    const url = new URL(cdpUrl);
    port = parseInt(url.port, 10);
  } else {
    // Launch Chrome with visible window
    const launched = await chromeLauncher.launch({
      chromeFlags: [
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,960",
      ],
    });
    chrome = launched;
    port = launched.port;
  }

  const raw = await CDP({ port });

  // Wrap CRI client into our CDPClient interface
  client = {
    send: (method: string, params?: Record<string, unknown>) => {
      const [domain, command] = method.split(".");
      return raw[domain][command](params || {});
    },
    on: (event: string, cb: (params: any) => void) => {
      raw.on(event, cb);
    },
    off: (event: string, cb: (params: any) => void) => {
      raw.off(event, cb);
    },
    close: async () => {
      await raw.close();
      client = null;
    },
  };

  // Enable required domains
  await Promise.all([
    client.send("Page.enable"),
    client.send("DOM.enable"),
    client.send("Runtime.enable"),
    client.send("Accessibility.enable"),
    client.send("Network.enable"),
    client.send("Inspector.enable"),
  ]);

  // Crash detection
  client.on("Inspector.targetCrashed", () => {
    crashed = true;
  });

  return client;
}

export async function disconnect(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
    client = null;
  }
  if (chrome) {
    await chrome.kill();
    chrome = null;
  }
  crashed = false;
}

export function getClient(): CDPClient {
  if (!client || crashed) {
    const code: ErrorCode = crashed ? "PAGE_CRASHED" : "CDP_DISCONNECTED";
    throw Object.assign(new Error(`CDP ${code}`), { code });
  }
  return client;
}
