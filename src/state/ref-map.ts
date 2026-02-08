import type { CDPClient } from "../cdp/client.js";
import type { NodeIdentity, ErrorCode } from "../types.js";

let counter = 0;
const refs = new Map<string, NodeIdentity>();

export function assignRef(identity: Omit<NodeIdentity, "stale">): string {
  counter++;
  const ref = `@e${counter}`;
  refs.set(ref, { ...identity, stale: false });
  return ref;
}

export function getIdentity(ref: string): NodeIdentity | undefined {
  return refs.get(ref);
}

export function markAllStale(): void {
  for (const identity of refs.values()) {
    identity.stale = true;
  }
}

export function clearAll(): void {
  refs.clear();
  // Counter intentionally NOT reset per D1
}

export function freeRef(ref: string): void {
  refs.delete(ref);
}

export function currentCounter(): number {
  return counter;
}

export function resetCounter(): void {
  counter = 0;
  refs.clear();
}

export interface ResolvedRef {
  backendNodeId: number;
  resolvedBy: "backendNodeId" | "domPath";
}

/**
 * Resolve a ref to a backendNodeId per D2 resolution order:
 * 1. Try DOM.resolveNode({ backendNodeId })
 * 2. Fall back to domPath CSS selector
 * 3. Return REF_STALE error
 */
export async function resolveRef(
  cdp: CDPClient,
  ref: string,
): Promise<ResolvedRef | { code: ErrorCode; message: string }> {
  const identity = refs.get(ref);
  if (!identity) {
    return { code: "NO_SUCH_REF", message: `Ref ${ref} not in registry` };
  }

  // Step 1: Try backendNodeId
  try {
    await cdp.send("DOM.resolveNode", {
      backendNodeId: identity.backendNodeId,
    });
    return { backendNodeId: identity.backendNodeId, resolvedBy: "backendNodeId" };
  } catch {
    // backendNodeId failed, try domPath
  }

  // Step 2: Try domPath
  try {
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: identity.domPath,
    });
    if (!nodeId) {
      return { code: "REF_STALE", message: `Ref ${ref}: domPath selector returned no match` };
    }
    const described = await cdp.send("DOM.describeNode", { nodeId });
    const newBackendNodeId = described.node.backendNodeId;

    // Refresh identity: update backendNodeId, re-fetch axNodeId
    identity.backendNodeId = newBackendNodeId;
    try {
      const axResult = await cdp.send("Accessibility.getPartialAXTree", {
        backendNodeId: newBackendNodeId,
        fetchRelatives: false,
      });
      if (axResult.nodes && axResult.nodes.length > 0) {
        identity.axNodeId = axResult.nodes[0].nodeId;
      }
    } catch {
      // AX refresh failed, keep old axNodeId
    }
    identity.stale = false;

    return { backendNodeId: newBackendNodeId, resolvedBy: "domPath" };
  } catch {
    return { code: "REF_STALE", message: `Ref ${ref}: both backendNodeId and domPath failed` };
  }
}
