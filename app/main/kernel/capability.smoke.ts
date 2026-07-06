// capability PKI smoke — generate keypair, sign a manifest, verify (pass + tamper-fail).
// JS-runnable (mirrors capability.ts); TS canonical lives in capability.ts.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const ALG = "ed25519";
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((a, k) => { a[k] = sortKeys(v[k]); return a; }, {});
  }
  return v;
}
function canonical(m) { const { signatures, ...rest } = m; return Buffer.from(JSON.stringify(sortKeys(rest)), "utf8"); }
function signManifest(m, privatePem) {
  const sig = sign(null, canonical(m), createPrivateKey(privatePem)).toString("hex");
  m.signatures = [{ signer: "project-key", alg: ALG, sig }];
  return sig;
}
function verifyManifest(m, publicPem) {
  const s = m.signatures?.[0]; if (!s || s.alg !== ALG) return false;
  try { return verify(null, canonical(m), createPublicKey(publicPem), Buffer.from(s.sig, "hex")); }
  catch { return false; }
}

const { privateKey, publicKey } = generateKeyPairSync(ALG);
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const manifest = {
  identity: { name: "openocd-task", tier: "c", version: "0.1.0" },
  capabilities: { touchHardware: { deviceClass: "hpm6e00", interfaces: ["swd", "jtag"] },
                  publishTopics: ["device.attached"], subscribeTopics: ["cmd.flash"] },
  signatures: [],
};
signManifest(manifest, privatePem);

const okGood = verifyManifest(manifest, publicPem);
console.log("verify untampered:", okGood ? "✅" : "❌");

// tamper: change a topic, signature must fail
const tampered = JSON.parse(JSON.stringify(manifest));
tampered.capabilities.publishTopics = ["alarm.critical"];  // not what was signed
const okTampered = verifyManifest(tampered, publicPem);
console.log("verify tampered (expect FAIL):", okTampered ? "❌ (passed — BAD)" : "✅ (rejected)");

// wrong key
const other = generateKeyPairSync(ALG).publicKey.export({ type: "spki", format: "pem" }).toString();
const okWrongKey = verifyManifest(manifest, other);
console.log("verify wrong key (expect FAIL):", okWrongKey ? "❌ (passed — BAD)" : "✅ (rejected)");

console.log(okGood && !okTampered && !okWrongKey ? "\nCAPABILITY PKI OK ✅" : "\nFAIL ❌");
