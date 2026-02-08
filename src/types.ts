// D1: Ref format - /^@e\d+$/
// Counter never resets within a session. Freed refs are never reused.

// D2: Node Identity
export interface NodeIdentity {
  axNodeId: string;
  backendNodeId: number;
  domPath: string;
  stale: boolean;
}

// D7: Error codes
export type ErrorCode =
  | "REF_STALE"
  | "NO_SUCH_REF"
  | "NOT_INTERACTABLE"
  | "STABILITY_TIMEOUT"
  | "CDP_DISCONNECTED"
  | "PAGE_CRASHED"
  | "ACTION_FAILED"
  | "SCRIPT_ERROR"
  | "FILL_FAILED"
  | "WAIT_TIMEOUT";

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
}

// D8: Response schemas
export interface PageInfo {
  url: string;
  title: string;
  viewport: { width: number; height: number };
}

export interface Consequence {
  type: "appeared" | "disappeared" | "changed" | "network" | "dom-churn" | "layout-shift";
  ref?: string;
  desc: string;
  churnCount?: number;
  cls?: number;
  shiftCount?: number;
}

export interface ActionResult {
  version: 1;
  action: string;
  ok: boolean;
  page: PageInfo;
  consequences: Consequence[];
  newInteractiveElements: string[];
  errors: ErrorDetail[];
  warnings: string[];
  resolvedBy?: "backendNodeId" | "domPath";
  timingMs: number;
}

export interface ScriptResult extends ActionResult {
  result?: unknown;
}

export interface SnapshotResult {
  version: 1;
  ok: boolean;
  page: PageInfo;
  elements: string[];
  errors: ErrorDetail[];
  timingMs: number;
}

// Internal types for snapshot diffing
export interface SnapshotElement {
  ref: string;
  axNodeId: string;
  domPath: string;
  role: string;
  name: string;
  compactLine: string;
  properties: Record<string, string>;
}

export interface SnapshotData {
  elements: SnapshotElement[];
  page: PageInfo;
}

// Network event tracking for consequences
export interface NetworkEvent {
  requestId: string;
  method: string;
  url: string;
  timestamp: number;
  status?: number;
  durationMs?: number;
}

export interface MutationRecord {
  insertions: number;
  removals: number;
  churnCount: number;
}

// D3: ensureInteractable result
export interface InteractableResult {
  objectId: string;
  x: number;
  y: number;
}

// Stability wait result
export interface StabilityResult {
  timedOut: boolean;
  networkEvents: NetworkEvent[];
  mutations?: MutationRecord;
}
