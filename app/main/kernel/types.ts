// Flux kernel — core types.
//
// `Task` is the unified primitive: the four application primitives
// (subagent / loop / devready / simulation) are Task specializations; `workflow`
// is a Task with flow.mode = "graph". See docs/architecture.md.
//
// `Message` / `Event` (uORB) are ported from v0 flux-runtime/primitives.py
// (trace_id → lineage; Event.kind preserved).

// ── Priority bands — RTOS "硬件不等人" (priority axis) ───────────────────────
export enum Priority {
  Alarm = 90, // over-current, probe-loss, policy-violation
  Device = 70, // device attach/detach, RT control loops
  Hil = 50, // hardware-in-the-loop / digital twin
  Build = 30, // cross-compile
  Agent = 30, // agent reasoning
  Asset = 30, // devready asset commit
  Background = 10, // indexing, telemetry
}

// ── Flow axis ────────────────────────────────────────────────────────────────
export type FlowMode = "leaf" | "sequential" | "parallel" | "loop" | "graph" | "delegate";

// ── Time axis (trigger). All collapse to "a uORB message arrived on a topic". ─
export type Trigger = "parent" | "cron" | "event" | "webhook" | "manual" | "irq";

// ── Compute isolation (per-Task; v1 = in-process | subprocess only) ──────────
export type Isolation = "in-process" | "subprocess" | "worktree" | "vm" | "remote-net";

// ── uORB Message (command) — ported from v0 primitives.Message ──────────────
export interface Message {
  target: string; // command topic, e.g. "cmd.flash"
  op: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  trace_id: string; // lineage
}

// ── uORB Event — ported from v0 primitives.Event ────────────────────────────
export type EventKind =
  | "propose" | "predict" | "execute" | "measure" | "attribute" | "log" | "error";

export interface Event {
  source: string; // module name
  kind: EventKind;
  topic: string; // event topic, e.g. "device.attached"
  data: Record<string, unknown>;
  trace_id: string;
}

// ── Capability (signed manifest) — decision #13 ─────────────────────────────
export interface Capability {
  touchHardware?: { deviceClass: string; interfaces: string[] };
  publishTopics?: string[];
  subscribeTopics?: string[];
  compute?: { priority: Priority; isolation: Isolation; affinity?: string };
  storage?: { budgetMB: number };
  callMcp?: string[];
}

export interface CapabilityManifest {
  identity: { name: string; tier: "ts" | "c" | "python"; version: string };
  capabilities: Capability;
  signatures: Array<{ signer: string; alg: "ed25519"; sig: string }>;
}

// ── Task — the unified primitive (3-axis × 2-resource schedulable unit) ──────
export interface Task {
  identity: { name: string; description: string };
  trigger: Trigger;
  flow: { mode: FlowMode; children?: string[] };
  runtime: {
    priority: Priority;
    isolation: Isolation;
    affinity?: string;
    ipc: "topic" | "tool-call";
    sessionRef?: string;
    maxTurns?: number;
    depthCap?: number;
  };
  lifecycle?: { before?: string; after?: string };
  deps: string[]; // task names or topics that must be done/seen first
  manifestRef: string; // path/key to the signed CapabilityManifest
}

export type TaskState = "pending" | "ready" | "running" | "blocked" | "done" | "failed";

// ── Policy gate (loop autonomy, decision #25 / pain-point ⑤) ─────────────────
export type PolicyDecision = "allow" | "approve" | "deny";

export interface PolicyGate {
  // Returns "approve" for sensitive ops (erase/high-voltage/external-send),
  // "deny" to block, "allow" otherwise. v1 skeleton: simple rules map.
  check(op: string, ctx: Record<string, unknown>): PolicyDecision;
}
