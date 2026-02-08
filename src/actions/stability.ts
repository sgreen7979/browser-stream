import type { CDPClient } from "../cdp/client.js";
import type { NetworkEvent, StabilityResult, MutationRecord } from "../types.js";

/**
 * Standalone mutation tracker that can be started before an action
 * to capture synchronous DOM mutations (e.g., scroll-triggered re-renders).
 * Counts per-parent insertions/removals to detect churn (remove+re-add pairs).
 */
export function createMutationTracker(cdp: CDPClient) {
  const parentRemovals = new Map<number, number>();
  const parentInsertions = new Map<number, number>();

  const onInserted = (params: any) => {
    const parentId = params.parentNodeId;
    parentInsertions.set(parentId, (parentInsertions.get(parentId) || 0) + 1);
  };
  const onRemoved = (params: any) => {
    const parentId = params.parentNodeId;
    parentRemovals.set(parentId, (parentRemovals.get(parentId) || 0) + 1);
  };

  cdp.on("DOM.childNodeInserted", onInserted);
  cdp.on("DOM.childNodeRemoved", onRemoved);

  return {
    stop(): MutationRecord {
      cdp.off("DOM.childNodeInserted", onInserted);
      cdp.off("DOM.childNodeRemoved", onRemoved);

      let insertions = 0;
      let removals = 0;
      let churnCount = 0;

      for (const count of parentInsertions.values()) insertions += count;
      for (const count of parentRemovals.values()) removals += count;

      const parents = new Set([...parentInsertions.keys(), ...parentRemovals.keys()]);
      for (const parentId of parents) {
        churnCount += Math.min(
          parentInsertions.get(parentId) || 0,
          parentRemovals.get(parentId) || 0,
        );
      }

      return { insertions, removals, churnCount };
    },
  };
}

const DEBOUNCE_MS = 200;
const HARD_CAP_MS = 3000;

/**
 * D5: Wait for DOM to settle after an action.
 * Tracks structural DOM mutations and Fetch/XHR network activity.
 * Returns when 200ms of silence or 3s hard cap.
 */
export interface StabilityOptions {
  trackMutations?: boolean;
}

export async function waitForStability(
  cdp: CDPClient,
  actionStartTime: number,
  options?: StabilityOptions,
): Promise<StabilityResult> {
  return new Promise((resolve) => {
    let pendingNetwork = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let hardCapTimer: ReturnType<typeof setTimeout> | null = null;
    const networkEvents: NetworkEvent[] = [];
    const pendingRequests = new Map<string, { method: string; url: string; timestamp: number }>();
    const trackMutations = options?.trackMutations === true;
    const parentRemovals = new Map<number, number>();
    const parentInsertions = new Map<number, number>();

    function resetDebounce() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkSettle, DEBOUNCE_MS);
    }

    function checkSettle() {
      if (pendingNetwork <= 0) {
        cleanup(false);
      } else {
        // Still have pending network, wait more
        resetDebounce();
      }
    }

    function cleanup(timedOut: boolean) {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (hardCapTimer) clearTimeout(hardCapTimer);
      cdp.off("DOM.childNodeInserted", onChildNodeInserted);
      cdp.off("DOM.childNodeRemoved", onChildNodeRemoved);
      cdp.off("Network.requestWillBeSent", onRequestSent);
      cdp.off("Network.loadingFinished", onRequestDone);
      cdp.off("Network.loadingFailed", onRequestDone);
      const mutations = trackMutations ? buildMutationRecord() : undefined;
      resolve({ timedOut, networkEvents, mutations });
    }

    function buildMutationRecord(): MutationRecord {
      let insertions = 0;
      let removals = 0;
      let churnCount = 0;

      for (const count of parentInsertions.values()) {
        insertions += count;
      }
      for (const count of parentRemovals.values()) {
        removals += count;
      }

      const parents = new Set<number>([
        ...parentInsertions.keys(),
        ...parentRemovals.keys(),
      ]);
      for (const parentId of parents) {
        const ins = parentInsertions.get(parentId) || 0;
        const rem = parentRemovals.get(parentId) || 0;
        churnCount += Math.min(ins, rem);
      }

      return { insertions, removals, churnCount };
    }

    function onChildNodeInserted(params: any) {
      if (trackMutations) {
        const parentId = params.parentNodeId;
        parentInsertions.set(parentId, (parentInsertions.get(parentId) || 0) + 1);
      }
      resetDebounce();
    }

    function onChildNodeRemoved(params: any) {
      if (trackMutations) {
        const parentId = params.parentNodeId;
        parentRemovals.set(parentId, (parentRemovals.get(parentId) || 0) + 1);
      }
      resetDebounce();
    }

    function onRequestSent(params: any) {
      // Only track Fetch/XHR
      const type = params.type || params.resourceType || "";
      if (type !== "Fetch" && type !== "XHR") return;

      // Only track requests that started after the action
      if (params.timestamp && params.timestamp < actionStartTime) return;

      pendingNetwork++;
      pendingRequests.set(params.requestId, {
        method: params.request?.method || "GET",
        url: params.request?.url || "",
        timestamp: Date.now(),
      });
      resetDebounce();
    }

    function onRequestDone(params: any) {
      const pending = pendingRequests.get(params.requestId);
      if (!pending) return;

      pendingNetwork = Math.max(0, pendingNetwork - 1);
      pendingRequests.delete(params.requestId);

      networkEvents.push({
        requestId: params.requestId,
        method: pending.method,
        url: pending.url,
        timestamp: pending.timestamp,
        status: params.response?.status,
        durationMs: Date.now() - pending.timestamp,
      });
      resetDebounce();
    }

    // Subscribe to events
    cdp.on("DOM.childNodeInserted", onChildNodeInserted);
    cdp.on("DOM.childNodeRemoved", onChildNodeRemoved);
    cdp.on("Network.requestWillBeSent", onRequestSent);
    cdp.on("Network.loadingFinished", onRequestDone);
    cdp.on("Network.loadingFailed", onRequestDone);

    // Start debounce immediately
    resetDebounce();

    // Hard cap
    hardCapTimer = setTimeout(() => cleanup(true), HARD_CAP_MS);
  });
}
