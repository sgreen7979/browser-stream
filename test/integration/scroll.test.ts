import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Server } from "node:http";
import type { ActionResult } from "../../src/types.js";

import { connect, disconnect, getClient } from "../../src/cdp/client.js";
import { navigate, scroll } from "../../src/actions/engine.js";
import { resetCounter } from "../../src/state/ref-map.js";

let server: Server;
let baseUrl: string;

const fixturePath = resolve(import.meta.dirname, "../fixtures/scroll.html");
const fixtureHtml = readFileSync(fixturePath, "utf-8");

function findRef(elements: string[], needle: string): string {
  const line = elements.find((l) => l.includes(needle));
  expect(line).toBeDefined();
  return line!.split(" ")[0];
}

async function evalJson<T>(expression: string): Promise<T> {
  const cdp = getClient();
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  return result.result.value as T;
}

beforeAll(async () => {
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

  resetCounter();
  await connect();
}, 30000);

afterAll(async () => {
  await disconnect();
  server.close();
}, 15000);

describe("browser_scroll", () => {
  it("scrolls viewport down and returns consequences", async () => {
    await navigate(baseUrl);
    const result: ActionResult = await scroll({ direction: "down" });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const appeared = result.consequences.some(
      (c) => c.type === "appeared" && c.desc.includes("Lazy Appears"),
    );
    expect(appeared).toBe(true);
  });

  it("scrolls a container by ref without moving the viewport", async () => {
    const nav = await navigate(baseUrl);
    const ref = findRef(nav.elements, "Scroll Item 1");

    const before = await evalJson<{ y: number; top: number }>(
      "(() => ({ y: window.scrollY, top: document.getElementById('scroll-box').scrollTop }))()",
    );

    const result = await scroll({ ref, direction: "down" });
    expect(result.ok).toBe(true);

    const after = await evalJson<{ y: number; top: number }>(
      "(() => ({ y: window.scrollY, top: document.getElementById('scroll-box').scrollTop }))()",
    );

    expect(after.top).toBeGreaterThan(before.top);
    expect(after.y).toBe(before.y);
  });

  it("respects to-bottom and emits boundary warning when already at bottom", async () => {
    const nav = await navigate(baseUrl);
    const ref = findRef(nav.elements, "Scroll Item 1");

    const first = await scroll({ ref, direction: "down", amount: "to-bottom" });
    expect(first.ok).toBe(true);

    const second = await scroll({ ref, direction: "up", amount: "to-bottom" });
    expect(second.ok).toBe(true);
    expect(second.warnings).toContain("SCROLL_AT_BOUNDARY: Already at bottom");
  });

  it("respects to-top and emits boundary warning when already at top", async () => {
    const nav = await navigate(baseUrl);
    const ref = findRef(nav.elements, "Scroll Item 1");

    const result = await scroll({ ref, direction: "down", amount: "to-top" });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("SCROLL_AT_BOUNDARY: Already at top");
  });

  it("reports DOM churn when a container re-renders on scroll", async () => {
    const nav = await navigate(baseUrl);
    const ref = findRef(nav.elements, "Churn Item 1");

    const result = await scroll({ ref, direction: "down" });
    expect(result.ok).toBe(true);

    const churn = result.consequences.find((c) => c.type === "dom-churn");
    expect(churn).toBeDefined();
    expect(churn!.churnCount).toBeGreaterThan(0);
  });

  it("reports layout shift when scroll triggers resize", async () => {
    await navigate(baseUrl);

    const result = await scroll({ direction: "down" });
    expect(result.ok).toBe(true);

    const shift = result.consequences.find((c) => c.type === "layout-shift");
    expect(shift).toBeDefined();
    expect(shift!.cls).toBeGreaterThan(0);
  });

  it("emits boundary warning for non-scrollable containers", async () => {
    const nav = await navigate(baseUrl);
    const ref = findRef(nav.elements, "No Scroll Button");

    await evalJson<boolean>(
      "(() => {\n" +
        "  const spacer = document.getElementById('viewport-spacer');\n" +
        "  spacer.style.height = '0px';\n" +
        "  document.documentElement.style.overflow = 'hidden';\n" +
        "  document.body.style.overflow = 'hidden';\n" +
        "  window.scrollTo(0, 0);\n" +
        "  return true;\n" +
        "})()",
    );

    const result = await scroll({ ref, direction: "down" });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.startsWith("SCROLL_AT_BOUNDARY:"))).toBe(true);
  });

  it("returns NO_SUCH_REF for invalid ref", async () => {
    await navigate(baseUrl);

    const result = await scroll({ ref: "@e9999", direction: "down" });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("NO_SUCH_REF");
  });

  it("scrolls viewport when no ref is provided", async () => {
    await navigate(baseUrl);
    const before = await evalJson<{ y: number }>("(() => ({ y: window.scrollY }))()");

    const result = await scroll({ direction: "down" });
    expect(result.ok).toBe(true);

    const after = await evalJson<{ y: number }>("(() => ({ y: window.scrollY }))()");
    expect(after.y).toBeGreaterThan(before.y);
  });
});
