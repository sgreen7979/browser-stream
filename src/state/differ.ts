import type { Consequence, NetworkEvent, SnapshotData, SnapshotElement } from "../types.js";

interface MatchResult {
  matched: Map<string, { pre: SnapshotElement; post: SnapshotElement }>;
  appeared: SnapshotElement[];
  disappeared: SnapshotElement[];
  domPathFallbacks: number;
}

function matchElements(pre: SnapshotData, post: SnapshotData): MatchResult {
  const matched = new Map<string, { pre: SnapshotElement; post: SnapshotElement }>();
  const preByAxId = new Map<string, SnapshotElement>();
  const preByPath = new Map<string, SnapshotElement>();
  const postByAxId = new Map<string, SnapshotElement>();
  const postByPath = new Map<string, SnapshotElement>();

  for (const el of pre.elements) {
    if (el.axNodeId) preByAxId.set(el.axNodeId, el);
    preByPath.set(el.domPath, el);
  }
  for (const el of post.elements) {
    if (el.axNodeId) postByAxId.set(el.axNodeId, el);
    postByPath.set(el.domPath, el);
  }

  const matchedPreRefs = new Set<string>();
  const matchedPostRefs = new Set<string>();
  let domPathFallbacks = 0;

  // Phase 1: Match by axNodeId
  for (const [axId, postEl] of postByAxId) {
    const preEl = preByAxId.get(axId);
    if (preEl) {
      matched.set(postEl.ref, { pre: preEl, post: postEl });
      matchedPreRefs.add(preEl.ref);
      matchedPostRefs.add(postEl.ref);
    }
  }

  // Phase 2: Unmatched post elements - try domPath
  for (const postEl of post.elements) {
    if (matchedPostRefs.has(postEl.ref)) continue;
    const preEl = preByPath.get(postEl.domPath);
    if (preEl && !matchedPreRefs.has(preEl.ref)) {
      matched.set(postEl.ref, { pre: preEl, post: postEl });
      matchedPreRefs.add(preEl.ref);
      matchedPostRefs.add(postEl.ref);
      domPathFallbacks++;
    }
  }

  const appeared = post.elements.filter((el) => !matchedPostRefs.has(el.ref));
  const disappeared = pre.elements.filter((el) => !matchedPreRefs.has(el.ref));

  return { matched, appeared, disappeared, domPathFallbacks };
}

function describeChange(pre: SnapshotElement, post: SnapshotElement): string | null {
  const changes: string[] = [];
  if (pre.name !== post.name) {
    changes.push(`name: "${pre.name}" -> "${post.name}"`);
  }
  if (pre.role !== post.role) {
    changes.push(`role: ${pre.role} -> ${post.role}`);
  }
  // Compare properties
  const allKeys = new Set([...Object.keys(pre.properties), ...Object.keys(post.properties)]);
  for (const key of allKeys) {
    if (pre.properties[key] !== post.properties[key]) {
      changes.push(`${key}: "${pre.properties[key] || ""}" -> "${post.properties[key] || ""}"`);
    }
  }
  return changes.length > 0 ? changes.join(", ") : null;
}

export function diffSnapshots(
  pre: SnapshotData,
  post: SnapshotData,
  networkEvents: NetworkEvent[],
): Consequence[] {
  const { matched, appeared, disappeared, domPathFallbacks } = matchElements(pre, post);
  const consequences: Consequence[] = [];

  if (domPathFallbacks > 0) {
    console.error(`[browser-stream] ${domPathFallbacks} element(s) matched by domPath fallback`);
  }

  // Appeared elements
  for (const el of appeared) {
    consequences.push({
      type: "appeared",
      ref: el.ref,
      desc: `${el.role} "${el.name}" appeared`,
    });
  }

  // Disappeared elements
  for (const el of disappeared) {
    consequences.push({
      type: "disappeared",
      ref: el.ref,
      desc: `${el.role} "${el.name}" disappeared`,
    });
  }

  // Changed elements
  for (const [ref, { pre, post }] of matched) {
    const change = describeChange(pre, post);
    if (change) {
      consequences.push({
        type: "changed",
        ref,
        desc: change,
      });
    }
  }

  // Network events
  for (const evt of networkEvents) {
    const urlPath = (() => {
      try {
        return new URL(evt.url).pathname;
      } catch {
        return evt.url;
      }
    })();
    consequences.push({
      type: "network",
      desc: `${evt.method} ${urlPath} -> ${evt.status || "pending"} (${evt.durationMs || 0}ms)`,
    });
  }

  return consequences;
}
