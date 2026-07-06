import { spawn } from "node:child_process";
class Bus { constructor(){this.subs=new Map();}
  async pub(e){ for(const f of [...(this.subs.get(e.topic)??[])]) f(e); }
  async sub(t,fn){ (this.subs.get(t)??this.subs.set(t,new Set()).get(t)).add(fn); } }
class Scheduler { constructor(){this.q=[];this.sat=new Set();}
  enqueue(t){const st={...t,enqueuedAt:Date.now()};this.q.push(st);this.q.sort((a,b)=>b.runtime.priority-a.runtime.priority);return st;}
  satisfy(k){this.sat.add(k);} pick(){for(const t of this.q){if(t.deps.every(d=>this.sat.has(d))){return t;}}return undefined;} }
// brain transport + sub→forward bridge
class Ipc { constructor(bus){this.bus=bus;this.buf="";}
  start(cmd,args){this.proc=spawn(cmd,args,{stdio:["pipe","pipe","pipe"]});this.proc.stdout.setEncoding("utf8");this.proc.stdout.on("data",c=>this.onChunk(c));this.proc.stderr.on("data",b=>console.error("  [brain]",b.toString().trim()))}
  write(f){this.proc.stdin.write(JSON.stringify(f)+"\n");}
  onChunk(c){this.buf+=c;let i;while((i=this.buf.indexOf("\n"))>=0){const l=this.buf.slice(0,i).trim();this.buf=this.buf.slice(i+1);if(l)this.onFrame(l);}}
  async onFrame(l){const f=JSON.parse(l);
    if(f.t==="pub"){await this.bus.pub({source:f.source,kind:f.kind,topic:f.topic,data:f.data||{},trace_id:f.trace_id||""});}
    else if(f.t==="sub"){await this.bus.sub(f.topic,e=>this.write({t:"pub",topic:e.topic,source:e.source,kind:e.kind,data:e.data,trace_id:e.trace_id}));} } }
// OpenOCD agent (mock)
const CMDS={"cmd.flash":(a)=>`flash write_image erase ${a[0]??""}`,"cmd.halt":()=>"halt"};
class Ocd { constructor(bus){this.bus=bus;this.pending=[];this.buf="";}
  start(cli,args=[]){this.proc=spawn(cli,args,{stdio:["pipe","pipe","pipe"]});this.proc.stdout.setEncoding("utf8");this.proc.stdout.on("data",c=>this.onOut(c));}
  onOut(c){this.buf+=c;let i;while((i=this.buf.indexOf("\n"))>=0){const l=this.buf.slice(0,i).trim();this.buf=this.buf.slice(i+1);if(l){const r=this.pending.shift();if(r)r(l);}}}
  async onCmd(e){const tcl=CMDS[e.topic]?.(e.data?.args??[]);if(!tcl)return;const reply=await this.send(tcl);
    await this.bus.pub({source:"openocd",kind:"execute",topic:"openocd.event",data:{cmd:e.topic,tcl,reply},trace_id:e.trace_id});}
  send(tcl){return new Promise(r=>{this.pending.push(r);this.proc.stdin.write(tcl+"\n");});} }

const bus=new Bus(), sched=new Scheduler();
const ipc=new Ipc(bus);
ipc.start(process.env.FLUX_PY, ["spike/vertical-brain.py"]);
const ocd=new Ocd(bus);
ocd.start("python3", ["spike/mock-openocd-cli.py"]);
for(const t of Object.keys(CMDS)) await bus.sub(t, e=>ocd.onCmd(e));

let assetCommitted=false;
await bus.sub("asset.committed", e=>{ console.log("  ✅ asset.committed:",JSON.stringify(e.data)); assetCommitted=true; });
await bus.sub("brain.ready", async ()=>{ console.log("  brain.ready → 调度器派发 bringup Task");
  sched.enqueue({identity:{name:"bringup"},runtime:{priority:30},deps:[],trigger:"parent",flow:{mode:"leaf"}});
  const t=sched.pick();
  console.log("  Task["+t.identity.name+"] 执行 → 发 cmd.flash");
  await bus.pub({source:"kernel",kind:"execute",topic:"cmd.flash",data:{args:["firmware.elf"]},trace_id:"vertical-1"});
});

setTimeout(()=>{ console.log(assetCommitted ? "\nVERTICAL DRY-RUN OK ✅  (scheduler→cmd.flash→OpenOCD(mock)→openocd.event→brain→asset.committed 全链)" : "\nFAIL ❌");
  try{ipc.proc.kill();ocd.proc.kill();}catch{} process.exit(assetCommitted?0:1); }, 1200);
