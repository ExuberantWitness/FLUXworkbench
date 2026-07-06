// Flux kernel — uORB bus abstraction (decision #9 + ADR 0002 hybrid bus).
//
// Carries the same typed messages over two transports:
//   - Node IPC / JSON-RPC   : TS kernel ↔ Python brain (supervised subprocess)
//   - Zenoh native peer     : TS kernel ↔ OpenOCD/remote (peer modules)
// Subscribers don't care which transport delivered an Event.

import type { Event, Message } from "./types";

export interface Bus {
  publish(evt: Event): Promise<void>;
  subscribe(topic: string, fn: (e: Event) => void): Promise<() => void>;
  /** Send a command Message to its target module (routed by target topic). */
  send(msg: Message): Promise<void>;
}

/**
 * In-process bus — the kernel's local pub/sub. The cross-process transports
 * (Node IPC to Python, Zenoh to peers) feed Events into this bus via
 * `publish`, and consume command Messages via `send`. v1 skeleton: in-process
 * only; transports wired in build-task #3 step 2.
 */
export class InProcessBus implements Bus {
  private readonly subs = new Map<string, Set<(e: Event) => void>>();
  private readonly routers = new Map<string, (m: Message) => Promise<void>>();

  async publish(evt: Event): Promise<void> {
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

  /** Register a transport router for a command-target prefix (e.g. "cmd.flash" → Zenoh-to-OpenOCD). */
  route(target: string, fn: (m: Message) => Promise<void>): void {
    this.routers.set(target, fn);
  }

  async send(msg: Message): Promise<void> {
    const r = this.routers.get(msg.target);
    if (r) await r(msg);
    else throw new Error(`no route for command target: ${msg.target}`);
  }
}
