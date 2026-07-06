import { spawn } from "node:child_process";

class Bus {  // 与 bus.ts 同构
  constructor(){ this.subs = new Map(); }
  async pub(e){ for (const f of [...(this.subs.get(e.topic) ?? [])]) f(e); }
  async sub(topic, fn){ (this.subs.get(topic) ?? this.subs.set(topic, new Set()).get(topic)).add(fn); }
}
const CMDS = {
  "cmd.flash": (a) => `flash write_image erase ${a[0] ?? ""}`,
  "cmd.halt":  () => "halt",
  "cmd.mdw":   (a) => `mdw ${a[0] ?? 0} ${a[1] ?? 1}`,
};
class OpenOcdAgent {  // 与 openocd.ts 同构
  constructor(bus, name="openocd"){ this.bus=bus; this.name=name; this.pending=[]; this.buf=""; }
  async start(cliPath, host="127.0.0.1", port=6666){
    this.proc = spawn(cliPath, [host, String(port)], { stdio: ["pipe","pipe","pipe"] });
    this.proc.stdout.setEncoding("utf8"); this.proc.stdout.on("data", c => this.onOut(c));
    this.proc.stderr.on("data", b => console.error("  [mock stderr]", b.toString().trim()));
    for (const t of Object.keys(CMDS)) await this.bus.sub(t, e => this.onCmd(e));
    await this.bus.pub({source:this.name,kind:"execute",topic:"device.attached",data:{device:"hpm6e00-0"},trace_id:""});
  }
  onOut(c){ this.buf+=c; let i; while((i=this.buf.indexOf("\n"))>=0){ const line=this.buf.slice(0,i).trim(); this.buf=this.buf.slice(i+1); if(!line)continue; const r=this.pending.shift(); if(r) r(line); } }
  async onCmd(e){ const args = e.data?.args ?? []; const tcl = CMDS[e.topic]?.(args); if(!tcl) return;
    const reply = await this.send(tcl);
    await this.bus.pub({source:this.name,kind:"execute",topic:"openocd.event",data:{cmd:e.topic,tcl,reply},trace_id:e.trace_id}); }
  send(tcl){ return new Promise(r => { this.pending.push(r); this.proc.stdin.write(tcl+"\n"); }); }
}

const bus = new Bus();
const agent = new OpenOcdAgent(bus);
const events = [];
await bus.sub("openocd.event", e => { console.log("  recv openocd.event:", JSON.stringify(e.data)); events.push(e); });
await bus.sub("device.attached", e => console.log("  recv device.attached:", JSON.stringify(e.data)));

await agent.start("python3", ["spike/mock-openocd-cli.py"]);
await new Promise(r => setTimeout(r, 200));
console.log("→ 发 cmd.halt");
await bus.pub({source:"test",kind:"execute",topic:"cmd.halt",data:{args:[]},trace_id:"t1"});
console.log("→ 发 cmd.flash (firmware.elf)");
await bus.pub({source:"test",kind:"execute",topic:"cmd.flash",data:{args:["firmware.elf"]},trace_id:"t2"});
console.log("→ 发 cmd.mdw 0x08000000 2");
await bus.pub({source:"test",kind:"execute",topic:"cmd.mdw",data:{args:["0x08000000",2]},trace_id:"t3"});

setTimeout(() => {
  const ok = events.length === 3 && events.every(e => e.data.reply && !e.data.reply.startsWith("?unknown"));
  console.log(events.length === 3 ? "\nOPENOCD AGENT OK ✅  (3 cmds → 3 openocd.event 回复)" : `\nFAIL ❌  got ${events.length} events`);
  agent.proc.kill(); process.exit(ok ? 0 : 1);
}, 800);
