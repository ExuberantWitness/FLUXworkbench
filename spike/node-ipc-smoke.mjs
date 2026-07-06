import { spawn } from "node:child_process";
const PY = process.env.FLUX_PY || "python3";
const proc = spawn(PY, ["spike/node-ipc-smoke.py"], { stdio: ["pipe","pipe","pipe"] });
let buf = ""; let gotPong = false;
const write = (f) => proc.stdin.write(JSON.stringify(f) + "\n");
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const f = JSON.parse(line);
    console.log("  JS recv:", f.t, f.topic ?? f.target);
    if (f.t === "pub" && f.topic === "pong") { gotPong = true; console.log("  PONG received ✅"); }
  }
});
proc.stderr.on("data", b => console.error("  [py stderr]", b.toString().trim()));
setTimeout(() => {
  write({ t: "sub", topic: "pong" });                              // JS subs pong
  write({ t: "pub", topic: "ping", source: "js", kind: "execute", data: { n: 1 }, trace_id: "t1" });  // JS pubs ping
}, 400);
setTimeout(() => {
  console.log(gotPong ? "SMOKE OK ✅  (JS ↔ Python uORB over Node IPC)" : "SMOKE FAIL ❌");
  proc.kill(); process.exit(gotPong ? 0 : 1);
}, 1500);
