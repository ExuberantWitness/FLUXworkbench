// Flux kernel — capability auth (decision #13). v1: project self-sign (ed25519).
//
// Uses node:crypto ed25519 (no external deps). Per-install keypair in ~/.flux/keys/.
// Sign the canonical JSON of (manifest minus signatures); verify on load + at each
// sensitive op. Public key distributed with releases (v2 org CA path).

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { CapabilityManifest } from "./types";

const SIGN_ALG = "ed25519";

/** Generate an ed25519 keypair (per-install; store in ~/.flux/keys/). */
export function generateKeyPair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync(SIGN_ALG);
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Canonical bytes of a manifest (drop `signatures`, stable key order). */
export function canonicalBytes(m: CapabilityManifest): Buffer {
  const { signatures: _drop, ...rest } = m;
  void _drop;
  return Buffer.from(JSON.stringify(sortKeys(rest)), "utf8");
}

function sortKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(sortKeys) as unknown as T;
  if (v && typeof v === "object") {
    return Object.keys(v as object).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = sortKeys((v as Record<string, unknown>)[k]);
      return acc;
    }, {}) as unknown as T;
  }
  return v;
}

/** Sign a manifest (mutates: appends a signature). Returns the signature hex. */
export function signManifest(m: CapabilityManifest, privatePem: string): string {
  const data = canonicalBytes(m);
  const sk = createPrivateKey(privatePem);
  const sig = sign(null, data, sk);
  const sigHex = sig.toString("hex");
  m.signatures = [{ signer: "project-key", alg: SIGN_ALG, sig: sigHex }];
  return sigHex;
}

/** Verify a manifest's first signature against a public key. */
export function verifyManifest(m: CapabilityManifest, publicPem: string): boolean {
  const sigEntry = m.signatures?.[0];
  if (!sigEntry || sigEntry.alg !== SIGN_ALG) return false;
  try {
    const data = canonicalBytes(m);
    const pk = createPublicKey(publicPem);
    return verify(null, data, pk, Buffer.from(sigEntry.sig, "hex"));
  } catch {
    return false;
  }
}

const WILDCARD = "*";

export function canPublish(m: CapabilityManifest, topic: string): boolean {
  const pubs = m.capabilities.publishTopics ?? [];
  return pubs.includes(topic) || pubs.includes(WILDCARD);
}

export function canSubscribe(m: CapabilityManifest, topic: string): boolean {
  const subs = m.capabilities.subscribeTopics ?? [];
  return subs.includes(topic) || subs.includes(WILDCARD);
}

export function canTouchHardware(m: CapabilityManifest): boolean {
  return Boolean(m.capabilities.touchHardware);
}

/** Parse a JSON manifest (YAML via js-yaml later). */
export function parseManifest(text: string): CapabilityManifest {
  return JSON.parse(text) as CapabilityManifest;
}
