# Capability Model

> Plan decision #13; verification step 10.

## Design

Each module ships a **signed manifest** declaring its capabilities. The TS kernel
verifies the signature at spawn time and gates every `publish` at runtime.

## Manifest (YAML / JSON)

```yaml
identity: { name: openocd-task, tier: c, version: 0.1.0 }
capabilities:
  touchHardware: { deviceClass: hpm6e00, interfaces: [swd, jtag] }
  publishTopics:  [device.attached, openocd.event, alarm.critical]
  subscribeTopics: [cmd.flash, cmd.halt, cmd.mdw]
  compute: { priority: 70, isolation: subprocess }
  storage: { budgetMB: 100 }
signatures:
  - { signer: project-key, alg: ed25519, sig: "<hex>" }
```

## Enforcement (v1)

1. **Boot**: kernel generates ed25519 keypair → signs manifest → `verifyManifest()` ✓/✗
2. **Runtime**: `bus.publish(evt, manifest)` checks `canPublish(manifest, topic)`:
   - ✗ → reject + publish `alarm.policy-violation`
   - ✓ → deliver to subscribers

## PKI progression

- v1: project self-sign (`~/.flux/keys/`)
- v2: org CA (external contributors + remote peers)
- v3: web-of-trust (optional)

## Code

- `capability.ts`: `generateKeyPair()`, `signManifest()`, `verifyManifest()`,
  `canPublish()`, `canSubscribe()`, `canTouchHardware()`
- `bus.ts`: `InProcessBus.publish(evt, manifest?)` — gate + alarm on violation
