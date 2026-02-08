import type { CDPClient } from "../cdp/client.js";
import type {
  ActionResult, SnapshotResult, ErrorDetail, PageInfo,
  Consequence, SnapshotData,
} from "../types.js";
import { getClient, isCrashed } from "../cdp/client.js";
import { ensureInteractable } from "./interactable.js";
import { waitForStability, createMutationTracker } from "./stability.js";
import { takeSnapshot, snapshotDataToResult, errorSnapshotResult, getPageInfo } from "../state/snapshot.js";
import { diffSnapshots } from "../state/differ.js";
import { markAllStale, resolveRef } from "../state/ref-map.js";

function errorAction(action: string, errors: ErrorDetail[], timingMs: number): ActionResult {
  return {
    version: 1, action, ok: false,
    page: { url: "", title: "", viewport: { width: 0, height: 0 } },
    consequences: [], newInteractiveElements: [],
    errors, warnings: [], timingMs,
  };
}

function cdpError(): ErrorDetail[] {
  if (isCrashed()) return [{ code: "PAGE_CRASHED", message: "Chrome tab crashed" }];
  return [{ code: "CDP_DISCONNECTED", message: "CDP connection lost" }];
}

const FIND_AND_SCROLL_FN = `function(direction, amount) {
  function isScrollable(el) {
    if (!el) return false;
    var style = getComputedStyle(el);
    var overflowY = style ? style.overflowY : "";
    if (overflowY !== "auto" && overflowY !== "scroll") return false;
    return el.scrollHeight > el.clientHeight;
  }

  function findScrollable(el) {
    var cur = el;
    while (cur) {
      if (isScrollable(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  var target = findScrollable(this);
  var fallback = false;
  if (!target) {
    target = document.scrollingElement || document.documentElement || document.body;
    fallback = true;
  }

  var scrollTopBefore = target.scrollTop;
  var scrollHeight = target.scrollHeight;
  var clientHeight = target.clientHeight;

  if (amount === "to-top") {
    target.scrollTop = 0;
  } else if (amount === "to-bottom") {
    var maxScroll = Math.max(0, scrollHeight - clientHeight);
    target.scrollTop = maxScroll;
  } else {
    var delta = amount === "page" ? clientHeight : amount;
    if (direction === "up") delta = -delta;
    target.scrollTop = scrollTopBefore + delta;
  }

  var scrollTopAfter = target.scrollTop;
  return {
    scrollTopBefore: scrollTopBefore,
    scrollTopAfter: scrollTopAfter,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    containerTag: target.tagName || "VIEWPORT",
    fallback: fallback,
  };
}`;

const VIEWPORT_SCROLL_FN = `function(direction, amount) {
  var target = document.scrollingElement || document.documentElement || document.body;
  var scrollTopBefore = target.scrollTop;
  var scrollHeight = target.scrollHeight;
  var clientHeight = target.clientHeight;

  if (amount === "to-top") {
    target.scrollTop = 0;
  } else if (amount === "to-bottom") {
    var maxScroll = Math.max(0, scrollHeight - clientHeight);
    target.scrollTop = maxScroll;
  } else {
    var delta = amount === "page" ? clientHeight : amount;
    if (direction === "up") delta = -delta;
    target.scrollTop = scrollTopBefore + delta;
  }

  var scrollTopAfter = target.scrollTop;
  return {
    scrollTopBefore: scrollTopBefore,
    scrollTopAfter: scrollTopAfter,
    scrollHeight: target.scrollHeight,
    clientHeight: target.clientHeight,
    containerTag: target.tagName || "VIEWPORT",
    fallback: false,
  };
}`;

async function injectLayoutShiftObserver(cdp: CDPClient): Promise<boolean> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
        if (typeof PerformanceObserver === "undefined") return false;
        if (window.__bsLayoutShiftObserver && window.__bsLayoutShiftObserver.disconnect) {
          try { window.__bsLayoutShiftObserver.disconnect(); } catch {}
        }
        window.__bsLayoutShifts = [];
        const observer = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          for (const entry of entries) {
            window.__bsLayoutShifts.push({
              value: entry.value || 0,
              hadRecentInput: !!entry.hadRecentInput,
            });
          }
        });
        observer.observe({ type: "layout-shift", buffered: true });
        window.__bsLayoutShiftObserver = observer;
        return true;
      } catch {
        return false;
      }
    })()`,
    returnByValue: true,
  });
  return result.result?.value === true;
}

async function clearLayoutShiftAccumulator(cdp: CDPClient): Promise<void> {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
        if (Array.isArray(window.__bsLayoutShifts)) {
          window.__bsLayoutShifts.length = 0;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    })()`,
    returnByValue: true,
  });
}

async function collectAndDisconnectLayoutShiftObserver(
  cdp: CDPClient,
): Promise<{ cls: number; shiftCount: number } | null> {
  const result = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      try {
        const shifts = Array.isArray(window.__bsLayoutShifts) ? window.__bsLayoutShifts : [];
        let cls = 0;
        let shiftCount = 0;
        for (const entry of shifts) {
          if (!entry.hadRecentInput) {
            cls += entry.value || 0;
            shiftCount++;
          }
        }
        if (window.__bsLayoutShiftObserver && window.__bsLayoutShiftObserver.disconnect) {
          window.__bsLayoutShiftObserver.disconnect();
        }
        delete window.__bsLayoutShiftObserver;
        delete window.__bsLayoutShifts;
        return { ok: true, cls: cls, shiftCount: shiftCount };
      } catch {
        return { ok: false };
      }
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value;
  if (value && value.ok && typeof value.cls === "number") {
    return { cls: value.cls, shiftCount: value.shiftCount || 0 };
  }
  return null;
}

// D10 orchestration for ref-based actions (click, fill)
async function executeWithConsequences(
  actionDesc: string,
  ref: string,
  actionFn: (cdp: CDPClient, objectId: string, x: number, y: number) => Promise<void>,
): Promise<ActionResult> {
  const start = Date.now();
  let cdp: CDPClient;
  try {
    cdp = getClient();
  } catch {
    return errorAction(actionDesc, cdpError(), Date.now() - start);
  }

  // Step 1: ensureInteractable (may scroll)
  const interactable = await ensureInteractable(cdp, ref);
  if ("code" in interactable) {
    return errorAction(actionDesc, [interactable], Date.now() - start);
  }

  const { objectId, x, y, resolvedBy } = interactable;

  // Step 2: pre-snapshot (after scroll)
  let preSnapshot: SnapshotData;
  try {
    preSnapshot = await takeSnapshot(cdp, { keepExistingRefs: true });
  } catch (e: any) {
    return errorAction(actionDesc, [{ code: "ACTION_FAILED", message: `Pre-snapshot failed: ${e.message}` }], Date.now() - start);
  }

  // Step 3: execute action
  const actionStartTime = Date.now() / 1000; // CDP timestamps are in seconds
  try {
    await actionFn(cdp, objectId, x, y);
  } catch (e: any) {
    return errorAction(actionDesc, [{ code: "ACTION_FAILED", message: e.message }], Date.now() - start);
  }

  // Step 4: stability wait
  const stability = await waitForStability(cdp, actionStartTime);

  // Step 5: post-snapshot
  let postSnapshot: SnapshotData;
  try {
    postSnapshot = await takeSnapshot(cdp);
  } catch (e: any) {
    return errorAction(actionDesc, [{ code: "ACTION_FAILED", message: `Post-snapshot failed: ${e.message}` }], Date.now() - start);
  }

  // Step 6: diff
  const consequences = diffSnapshots(preSnapshot, postSnapshot, stability.networkEvents);
  const warnings: string[] = [];
  if (stability.timedOut) {
    warnings.push("STABILITY_TIMEOUT: DOM did not settle within 3000ms");
  }

  return {
    version: 1,
    action: actionDesc,
    ok: true,
    page: postSnapshot.page,
    consequences,
    newInteractiveElements: postSnapshot.elements
      .filter((el) => consequences.some((c) => c.type === "appeared" && c.ref === el.ref))
      .map((el) => el.compactLine),
    errors: [],
    warnings,
    resolvedBy,
    timingMs: Date.now() - start,
  };
}

// D4: Click
export async function click(ref: string): Promise<ActionResult> {
  return executeWithConsequences(`click ${ref}`, ref, async (cdp, _objectId, x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
  });
}

// D4: Fill
export async function fill(ref: string, value: string): Promise<ActionResult> {
  return executeWithConsequences(`fill ${ref} '${value}'`, ref, async (cdp, objectId) => {
    // Check if contentEditable first
    const editableCheck = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { return this.isContentEditable; }",
      returnByValue: true,
    });

    if (editableCheck.result.value) {
      // ContentEditable path
      await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(value) {
          this.focus();
          this.innerText = value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }`,
        arguments: [{ value }],
      });
    } else {
      // Standard input/textarea path
      const result = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(value) {
          this.focus();
          var proto = this.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) {
            desc.set.call(this, value);
          } else {
            this.value = value;
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }`,
        arguments: [{ value }],
        returnByValue: true,
      });

      if (!result.result.value) {
        throw Object.assign(new Error("Fill failed: could not set value"), { code: "FILL_FAILED" });
      }
    }
  });
}

// D4: Navigate
export async function navigate(url: string): Promise<SnapshotResult> {
  const start = Date.now();
  let cdp: CDPClient;
  try {
    cdp = getClient();
  } catch {
    return errorSnapshotResult(cdpError(), Date.now() - start);
  }

  try {
    // Navigate and wait for load
    const loadPromise = new Promise<void>((resolve) => {
      const handler = () => {
        cdp.off("Page.loadEventFired", handler);
        resolve();
      };
      cdp.on("Page.loadEventFired", handler);
    });

    await cdp.send("Page.navigate", { url });
    await Promise.race([
      loadPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Navigation timeout")), 30000)
      ),
    ]);

    // Mark all existing refs as stale
    markAllStale();

    // Take fresh snapshot (no "before" to diff against)
    const data = await takeSnapshot(cdp);
    return snapshotDataToResult(data, Date.now() - start);
  } catch (e: any) {
    return errorSnapshotResult(
      [{ code: "ACTION_FAILED", message: `Navigate failed: ${e.message}` }],
      Date.now() - start,
    );
  }
}

// Key mapping table for D4
const KEY_MAP: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  " ": { key: " ", code: "Space", keyCode: 32 },
  space: { key: " ", code: "Space", keyCode: 32 },
};

function parseKeyCombo(keyStr: string): {
  key: string; code: string; keyCode: number;
  modifiers: number; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean;
} {
  const parts = keyStr.split("+");
  let ctrlKey = false, shiftKey = false, altKey = false, metaKey = false;

  // Last part is the actual key, preceding parts are modifiers
  const mainKey = parts.pop()!;
  for (const mod of parts) {
    switch (mod.toLowerCase()) {
      case "control": case "ctrl": ctrlKey = true; break;
      case "shift": shiftKey = true; break;
      case "alt": altKey = true; break;
      case "meta": case "command": case "cmd": metaKey = true; break;
    }
  }

  const mapped = KEY_MAP[mainKey.toLowerCase()];
  if (mapped) {
    const modifiers = (ctrlKey ? 2 : 0) | (altKey ? 1 : 0) | (shiftKey ? 8 : 0) | (metaKey ? 4 : 0);
    return { ...mapped, modifiers, ctrlKey, shiftKey, altKey, metaKey };
  }

  // Single character
  const char = mainKey.length === 1 ? mainKey : mainKey;
  const upper = char.toUpperCase();
  const charCode = upper.charCodeAt(0);
  let code = `Key${upper}`;
  if (charCode >= 48 && charCode <= 57) code = `Digit${char}`;

  const modifiers = (ctrlKey ? 2 : 0) | (altKey ? 1 : 0) | (shiftKey ? 8 : 0) | (metaKey ? 4 : 0);
  return { key: char, code, keyCode: charCode, modifiers, ctrlKey, shiftKey, altKey, metaKey };
}

// D4: Press key
export async function pressKey(keyStr: string): Promise<ActionResult> {
  const start = Date.now();
  let cdp: CDPClient;
  try {
    cdp = getClient();
  } catch {
    return errorAction(`press_key "${keyStr}"`, cdpError(), Date.now() - start);
  }

  // Pre-snapshot
  let preSnapshot: SnapshotData;
  try {
    preSnapshot = await takeSnapshot(cdp, { keepExistingRefs: true });
  } catch (e: any) {
    return errorAction(`press_key "${keyStr}"`, [{ code: "ACTION_FAILED", message: `Pre-snapshot failed: ${e.message}` }], Date.now() - start);
  }

  const parsed = parseKeyCombo(keyStr);
  const actionStartTime = Date.now() / 1000;

  try {
    // keyDown
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.keyCode,
      nativeVirtualKeyCode: parsed.keyCode,
      modifiers: parsed.modifiers,
    });

    // For printable characters, also send char event
    if (parsed.key.length === 1 && !parsed.ctrlKey && !parsed.altKey && !parsed.metaKey) {
      await cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        text: parsed.key,
        key: parsed.key,
        code: parsed.code,
        modifiers: parsed.modifiers,
      });
    }

    // keyUp
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: parsed.key,
      code: parsed.code,
      windowsVirtualKeyCode: parsed.keyCode,
      nativeVirtualKeyCode: parsed.keyCode,
      modifiers: parsed.modifiers,
    });
  } catch (e: any) {
    return errorAction(`press_key "${keyStr}"`, [{ code: "ACTION_FAILED", message: e.message }], Date.now() - start);
  }

  // Stability wait
  const stability = await waitForStability(cdp, actionStartTime);

  // Post-snapshot
  let postSnapshot: SnapshotData;
  try {
    postSnapshot = await takeSnapshot(cdp);
  } catch (e: any) {
    return errorAction(`press_key "${keyStr}"`, [{ code: "ACTION_FAILED", message: `Post-snapshot failed: ${e.message}` }], Date.now() - start);
  }

  const consequences = diffSnapshots(preSnapshot, postSnapshot, stability.networkEvents);
  const warnings: string[] = [];
  if (stability.timedOut) {
    warnings.push("STABILITY_TIMEOUT: DOM did not settle within 3000ms");
  }

  return {
    version: 1,
    action: `press_key "${keyStr}"`,
    ok: true,
    page: postSnapshot.page,
    consequences,
    newInteractiveElements: postSnapshot.elements
      .filter((el) => consequences.some((c) => c.type === "appeared" && c.ref === el.ref))
      .map((el) => el.compactLine),
    errors: [],
    warnings,
    timingMs: Date.now() - start,
  };
}

type ScrollAmount = "page" | "to-top" | "to-bottom" | number;

export async function scroll(opts: {
  ref?: string;
  direction: "up" | "down";
  amount?: ScrollAmount;
}): Promise<ActionResult> {
  const start = Date.now();
  const amount: ScrollAmount = opts.amount ?? "page";
  const actionDesc = `scroll ${opts.ref || "viewport"} ${opts.direction} ${amount}`;

  let cdp: CDPClient;
  try {
    cdp = getClient();
  } catch {
    return errorAction(actionDesc, cdpError(), Date.now() - start);
  }

  let objectId: string | null = null;
  let resolvedBy: "backendNodeId" | "domPath" | undefined;

  if (opts.ref) {
    const resolved = await resolveRef(cdp, opts.ref);
    if ("code" in resolved) {
      return errorAction(actionDesc, [resolved], Date.now() - start);
    }
    resolvedBy = resolved.resolvedBy;
    try {
      const result = await cdp.send("DOM.resolveNode", { backendNodeId: resolved.backendNodeId });
      objectId = result.object.objectId;
    } catch {
      return errorAction(
        actionDesc,
        [{ code: "NOT_INTERACTABLE", message: `Could not resolve ${opts.ref} to JS object` }],
        Date.now() - start,
      );
    }
  }

  let preSnapshot: SnapshotData;
  try {
    preSnapshot = await takeSnapshot(cdp, { keepExistingRefs: true });
  } catch (e: any) {
    return errorAction(
      actionDesc,
      [{ code: "ACTION_FAILED", message: `Pre-snapshot failed: ${e.message}` }],
      Date.now() - start,
    );
  }

  const resolvedIntent = amount === "to-top" ? "up" : amount === "to-bottom" ? "down" : opts.direction;
  let layoutShiftEnabled = false;
  try {
    layoutShiftEnabled = await injectLayoutShiftObserver(cdp);
  } catch {
    layoutShiftEnabled = false;
  }

  // Expand the full DOM tree so the DOM domain tracks all nodes.
  // Without this, DOM.childNodeRemoved/Inserted events only fire for nodes
  // previously "discovered" by the domain (e.g., via DOM.getDocument or querySelectorAll).
  // Dynamically created nodes (React components, virtualized lists) would be invisible.
  try {
    await cdp.send("DOM.getDocument", { depth: -1 });
  } catch {
    // Best-effort — churn detection degrades gracefully
  }

  // Start mutation tracker BEFORE scroll to catch synchronous DOM mutations
  // (e.g., React re-renders triggered by scroll events fire during scrollTop assignment)
  const mutationTracker = createMutationTracker(cdp);

  let scrollResult: {
    scrollTopBefore: number;
    scrollTopAfter: number;
    scrollHeight: number;
    clientHeight: number;
    containerTag: string;
    fallback: boolean;
  } | null = null;
  let stability: { timedOut: boolean; networkEvents: any[] } | null = null;
  let layoutShiftData: { cls: number; shiftCount: number } | null = null;
  let actionError: ErrorDetail[] | null = null;

  try {
    if (layoutShiftEnabled) await clearLayoutShiftAccumulator(cdp);
    const actionStartTime = Date.now() / 1000;

    if (objectId) {
      const result = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FIND_AND_SCROLL_FN,
        arguments: [{ value: opts.direction }, { value: amount }],
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error("Scroll failed: exception in page context");
      }
      scrollResult = result.result?.value || null;
    } else {
      const expression = `(${VIEWPORT_SCROLL_FN})(${JSON.stringify(opts.direction)}, ${JSON.stringify(amount)})`;
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error("Scroll failed: exception in page context");
      }
      scrollResult = result.result?.value || null;
    }

    if (!scrollResult) {
      throw new Error("Scroll failed: no result");
    }

    stability = await waitForStability(cdp, actionStartTime);
  } catch (e: any) {
    actionError = [{ code: "ACTION_FAILED", message: e.message }];
  } finally {
    if (layoutShiftEnabled) {
      try {
        layoutShiftData = await collectAndDisconnectLayoutShiftObserver(cdp);
      } catch {
        layoutShiftData = null;
      }
    }
  }

  // Stop mutation tracker after stability wait (captures all mutations including synchronous ones)
  const mutations = mutationTracker.stop();

  if (actionError) {
    return errorAction(actionDesc, actionError, Date.now() - start);
  }

  let postSnapshot: SnapshotData;
  try {
    postSnapshot = await takeSnapshot(cdp);
  } catch (e: any) {
    return errorAction(
      actionDesc,
      [{ code: "ACTION_FAILED", message: `Post-snapshot failed: ${e.message}` }],
      Date.now() - start,
    );
  }

  const consequences = diffSnapshots(preSnapshot, postSnapshot, stability?.networkEvents || []);
  if (mutations.churnCount > 0) {
    consequences.push({
      type: "dom-churn",
      desc: `DOM churn detected: ${mutations.churnCount} remove/re-add pairs`,
      churnCount: mutations.churnCount,
    });
  }
  if (layoutShiftData && layoutShiftData.cls > 0) {
    consequences.push({
      type: "layout-shift",
      desc: `Layout shift: cls=${layoutShiftData.cls} (${layoutShiftData.shiftCount} shifts)`,
      cls: layoutShiftData.cls,
      shiftCount: layoutShiftData.shiftCount,
    });
  }

  const warnings: string[] = [];
  if (scrollResult && scrollResult.scrollTopBefore === scrollResult.scrollTopAfter) {
    if (resolvedIntent === "up") warnings.push("SCROLL_AT_BOUNDARY: Already at top");
    else warnings.push("SCROLL_AT_BOUNDARY: Already at bottom");
  }
  if (scrollResult?.fallback && opts.ref) {
    warnings.push(`SCROLL_FALLBACK: No scrollable ancestor found for ${opts.ref}, scrolling viewport instead`);
  }
  if (stability?.timedOut) {
    warnings.push("STABILITY_TIMEOUT: DOM did not settle within 3000ms");
  }

  return {
    version: 1,
    action: actionDesc,
    ok: true,
    page: postSnapshot.page,
    consequences,
    newInteractiveElements: postSnapshot.elements
      .filter((el) => consequences.some((c) => c.type === "appeared" && c.ref === el.ref))
      .map((el) => el.compactLine),
    errors: [],
    warnings,
    resolvedBy,
    timingMs: Date.now() - start,
  };
}

// browser_wait_for
export async function waitFor(opts: {
  text?: string;
  ref?: string;
  timeout?: number;
}): Promise<SnapshotResult> {
  const start = Date.now();
  const timeout = opts.timeout || 10000;
  const pollInterval = 500;

  let cdp: CDPClient;
  try {
    cdp = getClient();
  } catch {
    return errorSnapshotResult(cdpError(), Date.now() - start);
  }

  while (Date.now() - start < timeout) {
    try {
      const data = await takeSnapshot(cdp);

      let textSatisfied = true;
      let refSatisfied = true;

      // Text condition: case-insensitive substring match
      if (opts.text) {
        const needle = opts.text.toLowerCase();
        textSatisfied = false;
        // Check page title
        if (data.page.title.toLowerCase().includes(needle)) {
          textSatisfied = true;
        }
        // Check element names and values
        if (!textSatisfied) {
          for (const el of data.elements) {
            if (el.name.toLowerCase().includes(needle)) {
              textSatisfied = true;
              break;
            }
            if (el.properties.value?.toLowerCase().includes(needle)) {
              textSatisfied = true;
              break;
            }
          }
        }
      }

      // Ref condition: ref resolves AND has box model (non-mutating check, NO scroll)
      if (opts.ref) {
        refSatisfied = false;
        const resolved = await import("../state/ref-map.js").then((m) => m.resolveRef(cdp, opts.ref!));
        if (!("code" in resolved)) {
          try {
            await cdp.send("DOM.getBoxModel", { backendNodeId: resolved.backendNodeId });
            refSatisfied = true;
          } catch {
            // No box model = not satisfying condition
          }
        }
      }

      if (textSatisfied && refSatisfied) {
        return snapshotDataToResult(data, Date.now() - start);
      }
    } catch {
      // Snapshot failed, retry
    }

    await new Promise((r) => setTimeout(r, pollInterval));
  }

  return {
    version: 1,
    ok: false,
    page: { url: "", title: "", viewport: { width: 0, height: 0 } },
    elements: [],
    errors: [{ code: "WAIT_TIMEOUT", message: `Condition not met within ${timeout}ms` }],
    timingMs: Date.now() - start,
  };
}
