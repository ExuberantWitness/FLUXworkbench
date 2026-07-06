import { spawn } from "node:child_process";

// —— InProcessBus（与 bus.ts 同构）——
class Bus {
  constructor(){ this.subs = new Map(); this.routers = new Map(); }
  async pub(e){ for (const f of [...(this.subs.get(e.topic)??[])]) f(e); }
  async sub(topic, fn){ (this.subs.get(topic)??this.subs.set(topic,new Set()).get(topic)).add(fn); }
  route(target, fn){ this.routers.set(target, fn); }
  async send(msg){ const r=this.routers.get(msg.target); if(r) await r(msg); else throw new Error("no route "+msg.target); }
}
// —— Scheduler（与 scheduler.ts 同构）——
class Scheduler {
  constructor(){ this.ready=[]; this.satisfied=new Set(); }
  enqueue(t){ const st={...t,state:"ready",enqueuedAt:Date.now()}; this.ready.push(st);
    this.ready.sort((a,b)=>b.runtime.priority-a.runtime.priority); return st; }
  satisfy(k){ this.satisfied.add(k); }
  pick(){ for(const t of this.ready){ if(t.state==="ready" && t.deps.every(d=>this.satisfied.has(d))){ t.state="running"; return t; } } return undefined; }
}
// —— NodeIpcTransport（与 node-ipc.ts 同构）——
class Ipc {
  constructor(bus){ this.bus=bus; this.buf=""; }
  start(cmd,args){ this.proc=spawn(cmd,args,{stdio:["pipe","pipe","pipe"]});
    this.proc.stdout.setEncoding("utf8"); this.proc.stdout.on("data",c=>this.onChunk(c));
    this.proc.stderr.on("data",b=>console.error("  [py]",b.toString().trim())); }
  write(f){ this.proc.stdin.write(JSON.stringify(f)+"\n"); }
  pub(e){ this.write({t:"pub",...e}); }
  onChunk(c){ this.buf+=c; let i; while((i=this.buf.indexOf("\n"))>=0){ const line=this.buf.slice(0,i).trim(); this.buf=this.buf.slice(i+1); if(line) this.onFrame(line); } }
  onFrame(line){ const f=JSON.parse(line); if(f.t==="pub") this.bus.pub({source:f.source,kind:f.kind,topic:f.topic,data:f.data||{},trace_id:f.trace_id||""}); else if(f.t==="sub"){} }
}

const bus = new Bus();
const sched = new Scheduler();
const ipc = new Ipc(bus);
ipc.start(process.env.FLUX_PY, ["spike/node-ipc-smoke.py"]);

let gotPong=false;
await bus.sub("pong", (e)=>{ console.log("  kernel recv pong:", JSON.stringify(e.data)); gotPong=true; });
await bus.sub("brain.ready", ()=>{ console.log("  brain.ready → 调度器开始派发"); runLoop(); });
// IPC: tell brain we want pong + we'll send ping
setTimeout(()=>{ ipc.write({t:"sub",topic:"pong"}); }, 200);

function runLoop(){
  // 派发一个 p30 Task；其执行 = 通过 bus 触发 brain 的 ping（经 IPC pub）
  sched.enqueue({identity:{name:"probe"},trigger:"parent",flow:{mode:"leaf"},runtime:{priority:30},deps:[],run:()=>{
    console.log("  Task[probe] 执行 → 发 ping"); ipc.pub({source:"kernel",kind:"execute",topic:"ping",data:{n:42},trace_id:"t1"});
  }});
  const t=sched.pick();
  if(t){ t.run(); }
}
setTimeout(()=>{ console.log(gotPong ? "KERNEL BOOT OK ✅  (scheduler→bus→IPC→brain→pong 全链)" : "FAIL ❌"); process.exit(gotPong?0:1); }, 1500);
