import type { CDPClient } from "../cdp/client.js";
import type { PageInfo, SnapshotData, SnapshotElement, SnapshotResult, ErrorDetail } from "../types.js";
import { assignRef, clearAll } from "./ref-map.js";

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "combobox", "checkbox", "radio",
  "menuitem", "tab", "switch", "slider", "spinbutton", "searchbox",
]);

const DOM_FALLBACK_SELECTOR = [
  "a[href]", "button", "input", "select", "textarea",
  '[role="button"]', '[role="link"]', '[role="textbox"]',
  '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
  '[role="menuitem"]', '[role="tab"]', '[role="switch"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

// JS function injected into the page to compute domPath for a given backendNodeId
const COMPUTE_DOM_PATH_FN = `function() {
  function nthOfType(el) {
    var tag = el.tagName.toLowerCase();
    var siblings = el.parentElement ? el.parentElement.children : [];
    var count = 0;
    for (var i = 0; i < siblings.length; i++) {
      if (siblings[i].tagName.toLowerCase() === tag) {
        count++;
        if (siblings[i] === el) return tag + ':nth-of-type(' + count + ')';
      }
    }
    return tag + ':nth-of-type(1)';
  }

  var parts = [];
  var el = this;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.id) {
      parts.unshift('#' + el.id);
      return parts.join(' > ');
    }
    parts.unshift(nthOfType(el));
    el = el.parentElement;
  }
  if (parts.length > 0) {
    parts.unshift('body');
    return parts.join(' > ');
  }
  return 'body';
}`;

export async function getPageInfo(cdp: CDPClient): Promise<PageInfo> {
  const [titleResult, layoutResult] = await Promise.all([
    cdp.send("Runtime.evaluate", { expression: "document.title" }),
    cdp.send("Page.getLayoutMetrics"),
  ]);
  const urlResult = await cdp.send("Runtime.evaluate", { expression: "location.href" });
  const viewport = layoutResult.visualViewport || layoutResult.layoutViewport;
  return {
    url: urlResult.result.value || "",
    title: titleResult.result.value || "",
    viewport: {
      width: Math.round(viewport.clientWidth || viewport.pageX || 1280),
      height: Math.round(viewport.clientHeight || viewport.pageY || 960),
    },
  };
}

async function computeDomPath(cdp: CDPClient, objectId: string): Promise<string> {
  try {
    const result = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: COMPUTE_DOM_PATH_FN,
      returnByValue: true,
    });
    return result.result.value || "body";
  } catch {
    return "body";
  }
}

function formatCompactLine(
  ref: string,
  role: string,
  name: string,
  properties: Record<string, string>,
): string {
  let line = `${ref} ${role}`;
  if (name) line += ` "${name}"`;

  // Append state indicators
  const states: string[] = [];
  if (properties.focused === "true") states.push("focused");
  if (properties.checked === "true") states.push("checked");
  if (properties.selected === "true") states.push("selected");
  if (properties.expanded === "true") states.push("expanded");
  if (properties.disabled === "true") states.push("disabled");
  if (properties.required === "true") states.push("required");
  if (states.length) line += ` [${states.join(", ")}]`;

  // Append key-value pairs
  if (properties.value && properties.value !== name) {
    line += ` value:"${properties.value}"`;
  }
  return line;
}

function extractAxProperties(node: any): Record<string, string> {
  const props: Record<string, string> = {};
  for (const p of node.properties || []) {
    if (p.value && p.value.value !== undefined) {
      props[p.name] = String(p.value.value);
    }
  }
  return props;
}

async function snapshotFromAxTree(cdp: CDPClient): Promise<{
  elements: SnapshotElement[];
  interactiveCount: number;
}> {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const elements: SnapshotElement[] = [];
  let interactiveCount = 0;

  for (const node of nodes) {
    const role = node.role?.value || "";
    if (!INTERACTIVE_ROLES.has(role)) continue;
    if (node.ignored) continue;

    interactiveCount++;
    const name = node.name?.value || "";
    const backendNodeId = node.backendDOMNodeId;
    if (!backendNodeId) continue;

    const properties = extractAxProperties(node);

    // Compute domPath by resolving the backend node to a JS object
    let domPath = "body";
    try {
      const resolved = await cdp.send("DOM.resolveNode", { backendNodeId });
      if (resolved.object?.objectId) {
        domPath = await computeDomPath(cdp, resolved.object.objectId);
        await cdp.send("Runtime.releaseObject", { objectId: resolved.object.objectId });
      }
    } catch {
      // Keep default domPath
    }

    const ref = assignRef({
      axNodeId: node.nodeId,
      backendNodeId,
      domPath,
    });

    elements.push({
      ref,
      axNodeId: node.nodeId,
      domPath,
      role,
      name,
      compactLine: formatCompactLine(ref, role, name, properties),
      properties,
    });
  }

  return { elements, interactiveCount };
}

async function snapshotFromDomFallback(cdp: CDPClient): Promise<SnapshotElement[]> {
  // Query interactive elements directly from the DOM
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: DOM_FALLBACK_SELECTOR,
  });

  const elements: SnapshotElement[] = [];

  for (const nodeId of nodeIds) {
    try {
      const described = await cdp.send("DOM.describeNode", { nodeId });
      const backendNodeId = described.node.backendNodeId;
      const tagName = described.node.nodeName?.toLowerCase() || "unknown";

      // Determine role from tag
      let role = "button";
      if (tagName === "a") role = "link";
      else if (tagName === "input") {
        const typeAttr = (described.node.attributes || []);
        const typeIdx = typeAttr.indexOf("type");
        const inputType = typeIdx >= 0 ? typeAttr[typeIdx + 1] : "text";
        if (inputType === "checkbox") role = "checkbox";
        else if (inputType === "radio") role = "radio";
        else role = "textbox";
      } else if (tagName === "textarea") role = "textbox";
      else if (tagName === "select") role = "combobox";

      // Get name from attributes or text content
      const resolved = await cdp.send("DOM.resolveNode", { backendNodeId });
      let name = "";
      let domPath = "body";
      if (resolved.object?.objectId) {
        const nameResult = await cdp.send("Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: `function() {
            return this.getAttribute('aria-label')
              || this.getAttribute('placeholder')
              || this.getAttribute('title')
              || this.innerText?.slice(0, 50)
              || '';
          }`,
          returnByValue: true,
        });
        name = nameResult.result.value || "";
        domPath = await computeDomPath(cdp, resolved.object.objectId);
        await cdp.send("Runtime.releaseObject", { objectId: resolved.object.objectId });
      }

      // Get AX node ID if possible
      let axNodeId = "";
      try {
        const axResult = await cdp.send("Accessibility.getPartialAXTree", {
          backendNodeId,
          fetchRelatives: false,
        });
        if (axResult.nodes?.[0]) axNodeId = axResult.nodes[0].nodeId;
      } catch { /* no AX data */ }

      const ref = assignRef({ axNodeId, backendNodeId, domPath });
      const properties: Record<string, string> = {};
      const compactLine = formatCompactLine(ref, role, name, properties);

      elements.push({ ref, axNodeId, domPath, role, name, compactLine, properties });
    } catch {
      // Skip elements that can't be described
    }
  }

  return elements;
}

/**
 * Take a full snapshot of the current page.
 * Returns SnapshotData for internal use (diffing) or SnapshotResult for tool response.
 */
export async function takeSnapshot(
  cdp: CDPClient,
  opts?: { keepExistingRefs?: boolean },
): Promise<SnapshotData> {
  if (!opts?.keepExistingRefs) {
    clearAll();
  }

  let { elements, interactiveCount } = await snapshotFromAxTree(cdp);

  // D6: AX fallback check
  if (interactiveCount === 0) {
    const childCountResult = await cdp.send("Runtime.evaluate", {
      expression: "document.body ? document.body.childElementCount : 0",
      returnByValue: true,
    });
    const childCount = childCountResult.result.value || 0;
    if (childCount > 0) {
      console.error("[browser-stream] AX fallback activated: 0 interactive AX nodes but DOM has content");
      elements = await snapshotFromDomFallback(cdp);
    }
  }

  const page = await getPageInfo(cdp);
  return { elements, page };
}

export function snapshotDataToResult(
  data: SnapshotData,
  timingMs: number,
): SnapshotResult {
  return {
    version: 1,
    ok: true,
    page: data.page,
    elements: data.elements.map((e) => e.compactLine),
    errors: [],
    timingMs,
  };
}

export function errorSnapshotResult(
  errors: ErrorDetail[],
  timingMs: number,
): SnapshotResult {
  return {
    version: 1,
    ok: false,
    page: { url: "", title: "", viewport: { width: 0, height: 0 } },
    elements: [],
    errors,
    timingMs,
  };
}
