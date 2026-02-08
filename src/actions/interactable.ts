import type { CDPClient } from "../cdp/client.js";
import type { InteractableResult, ErrorCode } from "../types.js";
import { resolveRef } from "../state/ref-map.js";

/**
 * D3: Ensure an element is interactable and return its center coordinates.
 * Sequence: resolve ref -> resolveNode -> getBoxModel -> viewport check -> scroll -> re-check -> center.
 */
export async function ensureInteractable(
  cdp: CDPClient,
  ref: string,
): Promise<
  | (InteractableResult & { resolvedBy: "backendNodeId" | "domPath" })
  | { code: ErrorCode; message: string }
> {
  // Step 1: Resolve ref to backendNodeId
  const resolved = await resolveRef(cdp, ref);
  if ("code" in resolved) return resolved;

  const { backendNodeId, resolvedBy } = resolved;

  // Step 2: Get objectId
  let objectId: string;
  try {
    const result = await cdp.send("DOM.resolveNode", { backendNodeId });
    objectId = result.object.objectId;
  } catch {
    return { code: "NOT_INTERACTABLE", message: `Could not resolve ${ref} to JS object` };
  }

  // Step 3: Get box model
  let boxModel: any;
  try {
    boxModel = await cdp.send("DOM.getBoxModel", { backendNodeId });
  } catch {
    return { code: "NOT_INTERACTABLE", message: `No box model for ${ref} (hidden or zero-size)` };
  }

  // Step 4: Check if center is within viewport
  const content = boxModel.model.content;
  let cx = (content[0] + content[4]) / 2;
  let cy = (content[1] + content[5]) / 2;

  const layout = await cdp.send("Page.getLayoutMetrics");
  const vp = layout.visualViewport;
  const vpWidth = vp.clientWidth;
  const vpHeight = vp.clientHeight;

  if (cx < 0 || cx > vpWidth || cy < 0 || cy > vpHeight) {
    // Scroll into view
    await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { this.scrollIntoViewIfNeeded(); }",
    });

    // Step 5: Re-fetch box model
    try {
      boxModel = await cdp.send("DOM.getBoxModel", { backendNodeId });
    } catch {
      return { code: "NOT_INTERACTABLE", message: `No box model for ${ref} after scroll` };
    }

    const newContent = boxModel.model.content;
    cx = (newContent[0] + newContent[4]) / 2;
    cy = (newContent[1] + newContent[5]) / 2;
  }

  return { objectId, x: cx, y: cy, resolvedBy };
}
