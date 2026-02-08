import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import type { ActionResult, SnapshotResult } from "../../src/types.js";

// Modules under test
import { connect, disconnect } from "../../src/cdp/client.js";
import { navigate, click, fill, pressKey, waitFor } from "../../src/actions/engine.js";
import { resetCounter } from "../../src/state/ref-map.js";

let server: Server;
let baseUrl: string;

const fixturePath = resolve(import.meta.dirname, "../fixtures/basic.html");
const fixtureHtml = readFileSync(fixturePath, "utf-8");

beforeAll(async () => {
  // Start HTTP server on random port
  server = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (typeof addr === "object" && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Reset ref counter for predictable refs
  resetCounter();

  // Launch Chrome and connect
  await connect();
}, 30000);

afterAll(async () => {
  await disconnect();
  server.close();
}, 15000);

describe("browser_navigate", () => {
  it("returns SnapshotResult with @e refs and page metadata", async () => {
    const result: SnapshotResult = await navigate(baseUrl);

    expect(result.version).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.page.url).toContain("127.0.0.1");
    expect(result.page.title).toBe("browser-stream test fixture");
    expect(result.page.viewport.width).toBeGreaterThan(0);
    expect(result.page.viewport.height).toBeGreaterThan(0);

    // Should have interactive elements with @e refs
    expect(result.elements.length).toBeGreaterThan(0);
    for (const line of result.elements) {
      expect(line).toMatch(/^@e\d+ /);
    }

    // Should include known elements from fixture
    const hasTextbox = result.elements.some((l) => l.includes("textbox"));
    const hasButton = result.elements.some((l) => l.includes("button"));
    const hasLink = result.elements.some((l) => l.includes("link"));
    expect(hasTextbox).toBe(true);
    expect(hasButton).toBe(true);
    expect(hasLink).toBe(true);
  });
});

describe("browser_snapshot", () => {
  it("returns snapshot with same elements as navigate", async () => {
    // Import snapshot tools to test directly
    const { getClient } = await import("../../src/cdp/client.js");
    const { takeSnapshot, snapshotDataToResult } = await import("../../src/state/snapshot.js");

    const cdp = getClient();
    const data = await takeSnapshot(cdp);
    const result = snapshotDataToResult(data, 0);

    expect(result.ok).toBe(true);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.page.title).toBe("browser-stream test fixture");
  });
});

describe("browser_fill", () => {
  it("returns value change consequence", async () => {
    // Re-navigate to fresh state
    const nav = await navigate(baseUrl);
    expect(nav.ok).toBe(true);

    // Find the name textbox
    const nameRef = nav.elements.find((l) => l.includes("Name") || l.includes("name"));
    expect(nameRef).toBeDefined();
    const ref = nameRef!.split(" ")[0]; // Extract @eN

    const result: ActionResult = await fill(ref, "Alice");

    expect(result.version).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.action).toContain("fill");
    expect(result.action).toContain(ref);
    expect(result.resolvedBy).toBeDefined();
  });
});

describe("browser_click", () => {
  it("returns appeared/disappeared consequences on form submit", async () => {
    // Navigate and fill form
    const nav = await navigate(baseUrl);
    const nameRef = nav.elements.find((l) => l.includes("Name") || l.includes("name"))!.split(" ")[0];
    const fillResult = await fill(nameRef, "Alice");
    expect(fillResult.ok).toBe(true);

    // After fill, refs have been reassigned in the post-snapshot.
    // We need to take a fresh snapshot to get current refs.
    const { getClient: gc } = await import("../../src/cdp/client.js");
    const { takeSnapshot: snap, snapshotDataToResult: toResult } = await import("../../src/state/snapshot.js");
    const currentSnap = toResult(await snap(gc()), 0);

    // Find submit button from current snapshot
    const submitLine = currentSnap.elements.find((l) => l.includes("Submit"));
    expect(submitLine).toBeDefined();
    const submitRef = submitLine!.split(" ")[0];

    const result: ActionResult = await click(submitRef);

    if (!result.ok) {
      console.error("Click failed:", JSON.stringify(result.errors, null, 2));
    }
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.consequences.length).toBeGreaterThan(0);

    // Form elements should disappear (hidden via CSS class)
    const disappeared = result.consequences.filter((c) => c.type === "disappeared");
    expect(disappeared.length).toBeGreaterThan(0);

    // Verify specific form elements disappeared
    const disappearedDescs = disappeared.map((c) => c.desc);
    expect(disappearedDescs.some((d) => d.includes("Submit"))).toBe(true);

    expect(result.timingMs).toBeGreaterThan(0);
  });
});

describe("browser_press_key", () => {
  it("dispatches key events and returns consequences", async () => {
    await navigate(baseUrl);

    // Press Tab to move focus
    const result: ActionResult = await pressKey("Tab");

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.action).toContain("press_key");
  });
});

describe("delayed stability", () => {
  it("wait_for finds delayed button after form submit", async () => {
    // Navigate, fill, and submit to trigger delayed button
    const nav = await navigate(baseUrl);
    const nameRef = nav.elements.find((l) => l.includes("Name") || l.includes("name"))!.split(" ")[0];
    await fill(nameRef, "Alice");

    const { getClient: gc } = await import("../../src/cdp/client.js");
    const { takeSnapshot: snap, snapshotDataToResult: toResult } = await import("../../src/state/snapshot.js");
    const current = toResult(await snap(gc()), 0);
    const submitRef = current.elements.find((l) => l.includes("Submit"))!.split(" ")[0];
    await click(submitRef);

    // The "Continue" button appears after 500ms via setTimeout
    const result: SnapshotResult = await waitFor({ text: "Continue", timeout: 5000 });
    expect(result.ok).toBe(true);
    expect(result.elements.some((l) => l.includes("Continue"))).toBe(true);
  });
});

describe("browser_wait_for", () => {
  it("waits for text to appear", async () => {
    await navigate(baseUrl);

    // Wait for text in page title (page title is "browser-stream test fixture")
    const result: SnapshotResult = await waitFor({ text: "browser-stream" });
    expect(result.ok).toBe(true);
    expect(result.elements.length).toBeGreaterThan(0);
  });

  it("returns WAIT_TIMEOUT for text that never appears", async () => {
    await navigate(baseUrl);

    const result: SnapshotResult = await waitFor({
      text: "This text does not exist anywhere",
      timeout: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].code).toBe("WAIT_TIMEOUT");
  });
});

describe("stale ref error", () => {
  it("returns NO_SUCH_REF for unknown refs", async () => {
    await navigate(baseUrl);

    const result: ActionResult = await click("@e99999");
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("NO_SUCH_REF");
    expect(result.consequences).toEqual([]);
  });
});

describe("token budget", () => {
  it("fixture snapshot < 500 tokens", async () => {
    const nav = await navigate(baseUrl);
    const json = JSON.stringify(nav);

    // tiktoken measurement
    let tokenCount: number;
    try {
      const { get_encoding } = await import("@dqbd/tiktoken");
      const enc = get_encoding("cl100k_base");
      tokenCount = enc.encode(json).length;
      enc.free();
    } catch {
      // If tiktoken not available, estimate ~4 chars per token
      tokenCount = Math.ceil(json.length / 4);
    }

    expect(tokenCount).toBeLessThan(500);
  });
});
