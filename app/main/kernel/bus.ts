// Flux kernel — uORB bus abstraction (decision #9 + ADR 0002 hybrid bus).
//
// Carries the same typed messages over two transports:
//   - Node IPC / JSON-RPC   : TS kernel ↔ Python brain (supervised subprocess)
//   - Zenoh native peer     : TS kernel ↔ OpenOCD/remote (peer modules)
// Subscribers don't care which transport delivered an Event.
//
// Capability gating (plan #13 / verification step 10): every publish is checked
// against the publisher's signed manifest. Unauthorized → reject + alarm.

import type { Event, Message } from "./types";
import { canPublish, type CapabilityManifest } from "./capability";

export interface Bus {
  publish(evt: Event, manifest?: CapabilityManifest): Promise<void>;
  subscribe(topic: string, fn: (e: Event) => void): Promise<() => void>;
  send(msg: Message): Promise<void>;
}

/**
 * In-process bus — the kernel's local pub/sub with capability gating.
 */
export class InProcessBus implements Bus {
  private readonly subs = new Map<string, Set<(e: Event) => void>>();
  private readonly routers = new Map<string, (m: Message) => Promise<void>>();
  /** Kernel's own manifest (trusted root for v1 local mode). */
  private kernelManifest: CapabilityManifest | undefined;

  /** Register the kernel's capability manifest (allows kernel to publish any topic). */
  setKernelManifest(m: CapabilityManifest): void {
    this.kernelManifest = m;
  }

  async publish(evt: Event, manifest?: CapabilityManifest): Promise<void> {
    // Capability gate: if a manifest is provided, verify it can publish this topic.
    // The kernel itself (no manifest arg) bypasses the check.
    if (manifest && !canPublish(manifest, evt.topic)) {
      // Emit a policy-violation alarm instead of the original event.
      const alarm: Event = {
        source: "kernel", kind: "error", topic: "alarm.policy-violation",
        data: { source: evt.source, topic: evt.topic, reason: "unauthorized publish" },
        trace_id: evt.trace_id,
      };
      const alarmFns = this.subs.get("alarm.policy-violation");
      if (alarmFns) for (const f of [...alarmFns]) f(alarm);
      return; // reject the original publish
    }
    const fns = this.subs.get(evt.topic);
    if (fns) for (const f of [...fns]) f(evt);
  }

  async subscribe(topic: string, fn: (e: Event) => void): Promise<() => void> {
    let set = this.subs.get(topic);
    if (!set) {
      set = new Set();
      this.subs.set(topic, set);
    }
    set.add(fn);
    return () => {
      this.subs.get(topic)?.delete(fn);
    };
  }

  route(target: string, fn: (m: Message) => Promise<void>): void {
    this.routers.set(target, fn);
  }

  async send(msg: Message): Promise<void> {
    const r = this.routers.get(msg.target);
    if (r) await r(msg);
    else throw new Error(`no route for command target: ${msg.target}`);
  }
}
