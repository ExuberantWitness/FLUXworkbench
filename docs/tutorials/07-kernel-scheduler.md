# 剧本 07 — 内核调度器（RTOS 优先级抢占，不是另一个 VSCode）

![kernel scheduler demo](media/07-kernel-scheduler.gif)

> ↑ 真实界面自动化录制（Playwright 驱动 Electron）：五条优先级带的**实时占用**——低优先级软件任务在跑，硬件告警一响，Device 带插队先跑、所有低带任务瞬间冻结，告警解除后恢复排队。全部读的是内核每次入队/出队/暂停/恢复真发出的 `scheduler.state`，不是预录动画。

**视频文件**：`media/07-kernel-scheduler.gif`（自动生成）· **时长**：~6s · **界面语言**：zh（en 同版）

## 一句话价值 / Hook

> VSCode 把命令按点击顺序 FIFO 跑完，没有优先级概念。Flux Workbench 的内核不同：每个任务在一条 RTOS 式优先级队列里占槽位，**硬件告警（探针失联/过流）会抢占所有低于 Device 带的软件任务**。这不是 UI 皮肤——是调度机制本身就和编辑器不一样。「硬件不等人。」

## 前置准备 / Setup

- studio 已启动（`pnpm dev` 或打好的包），任意页均可（右栏「内核调度器」常驻；总览弹窗里也有完整版带演示按钮）
- 无需真板、无需联网——演示任务是真实占用调度队列的空转任务，走的是 `callTool` 同一条 acquire→排队→抢占→释放路径
- 优先级带（`app/main/kernel/types.ts`）：Alarm 90 · Device 70 · HIL 50 · Agent/Build/Asset 30 · Background 10；`maxConcurrent = 2`

## 分镜 / Storyboard

| # | 画面 | 旁白（中） | 预期结果（真实调度状态） |
|---|---|---|---|
| 1 | 五条带全空，槽位 0/2 | "这是内核调度器。五条优先级带，最多两个槽位在飞。" | 空闲态，底部对照文案 |
| 2 | 点「运行抢占演示」/ ⚡ 内核调度演示 | "我丢一批任务进去：在环仿真、agent 推理、构建、资产、后台遥测。" | `hil.step`(50)+`agent.reason`(30) 飞（绿），`build.compile`/`asset.commit`(30)、`index.telemetry`/`corpus.flush`(10) 排队（⏳） |
| 3 | 队列建起来 | "只有两个槽位，高优先级先飞，低的排队——这就是优先级调度，不是 FIFO。" | 50/30 带在飞，30/10 带候着 |
| 4 | **⚡ 探针失联 probe-loss** 横幅+红标 | "现在硬件告警——调试探针被拔了。" | 顶部「⚡ 抢占线 70」红标；Alarm 带亮红闪烁 |
| 5 | **Device 带插队 + 低带冻结** | "看：Device 带的 `device.attach`、`rt.control-loop` 插队先跑；Agent/构建/资产、后台**全部冻结变红**——硬件优先。" | 70 带两个橙色任务在飞；30/10 带 ❄ 红虚线「冻结·硬件优先」 |
| 6 | 告警解除 | "告警一解除，冻结的队列继续排。" | 抢占线消失，30 带 `build.compile`/`asset.commit` 恢复飞 |
| 7 | 收尾 | "同样一批任务，VSCode 只会按点击顺序跑完。内核调度机制不同，才配叫机器人开发的操作系统。" | 回到排队/空闲 |

## 关键台词（英文字幕版）

- "This is the kernel scheduler — five priority bands, two slots flying at most."
- "High priority flies first, the rest queue. That's priority scheduling, not FIFO."
- "A hardware alarm fires — the debug probe was pulled."
- "The Device band jumps the queue; every software task below it freezes. Hardware first."
- "VSCode would just run these in click order. Different kernel — that's the point."

## 可复现验证（录制前自测通过）

调度器每次状态变化都发 `scheduler.state`。录制脚本收全程快照并**断言**抢占真的发生（Device(70) 在飞时有低带任务被冻结在队列里）：

```bash
cd /home/exuber/CODE/FLUXworkbench
env -u ELECTRON_RUN_AS_NODE pnpm --filter @fluxworkbench/app build
env -u ELECTRON_RUN_AS_NODE node scripts/record-demos.mjs scheduler
# 期望日志：preemption observed = true
# 真实时间线（探针实测）：
#   t=0      floor=0  fly=[50,30]  queued=[30,30,10,10]   ← 优先级排队
#   t=1600   floor=70 fly=[50,30]  queued=[70,70,30,30,10,10] ← 告警，Device 入队，低带冻结
#   t=2200   floor=70 fly=[70,70]  queued=[30,30,10,10]   ← Device 插队先跑
#   t=6000   floor=0  fly=[30,30]  queued=[10,10]         ← 解除，恢复
```

## 真实数据锚点（旁白别念错）

- 优先级带：**Alarm 90 / Device 70 / HIL 50 / Agent·Build·Asset 30 / Background 10**，并发上限 **2**
- 抢占线：`alarm.critical` → `MCPOrchestrator.pauseBelow(70)`；`alarm.cleared` → `resume()`
- 演示任务是真实占用队列的空转任务（`runDemoTask`），与真实 `callTool` 走同一条调度路径
- 可视化数据源：内核发布的 `scheduler.state`（inflight/queued/pauseFloor），非事件直方图、非预录动画

## 这跟 VSCode 到底哪不一样

| | VSCode | Flux Workbench |
|---|---|---|
| 任务模型 | 命令 = 一次性回调 | 任务 = 调度器里的 `Task`，带优先级/隔离/依赖 |
| 排序 | 按触发顺序（FIFO/事件循环） | 优先级带 + 有界并发 + 依赖门控 |
| 硬件事件 | 和普通命令同级 | Alarm/Device 带**抢占**软件任务（"硬件不等人"） |
| 可观测 | 无调度状态 | `scheduler.state` 实时可视化 + 落 JSONL 可重放 |
