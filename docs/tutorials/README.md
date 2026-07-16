# FluxWorkbench — 视频教程 / Video Tutorials

studio 典型功能的分镜剧本 + 录制清单。每个 `.md` 是一份可照着一镜到底录制的脚本；录好的视频（mp4/gif）放在同目录 `media/` 下，按剧本里的文件名命名。

Scripts for the studio's typical features. Each `.md` is a shot-by-shot script you can record in one take; drop the recorded mp4/gif into `media/` using the filename each script specifies.

## 教程清单 / Tutorials

| # | 功能 Feature | 剧本 Script | 时长 | 视频 |
|---|---|---|---|---|
| 01 | **PCB → BSP**：贴 GitHub 链接，从设计文件自动提取板级支持包 + 交互连接图 | [01-pcb-to-bsp.md](01-pcb-to-bsp.md) | ~2min | `media/01-pcb-to-bsp.mp4` |
| 02 | **设备上机**：插上任意 MCU 开发板，自动识别→建档→入库 | [02-device-onboard.md](02-device-onboard.md) | ~2min | `media/02-device-onboard.mp4` |
| 03 | **真板调通 + 芯片烙印**：六阶段黄金路径，读芯片→写 DevReady 记录进 Flash | [03-real-bringup-and-bind.md](03-real-bringup-and-bind.md) | ~3min | `media/03-real-bringup-and-bind.mp4` |
| 04 | **DevReady 资产**：自描述、自包含的 `.flux` 活档案（引脚/RTOS/记忆/官方资料） | [04-devready-asset.md](04-devready-asset.md) | ~2min | `media/04-devready-asset.mp4` |
| 05 | **小Flux 向导**：对话即操作，AI 分类意图→高亮控件带你走完流程 | [05-desk-pet-guided.md](05-desk-pet-guided.md) | ~2min | `media/05-desk-pet-guided.mp4` |
| 06 | **跨平台一键安装**：Windows/macOS/Linux 装完即用，内嵌运行时 | [06-install.md](06-install.md) | ~1min | `media/06-install.mp4` |

## 录制约定 / Recording conventions

见 [RECORDING.md](RECORDING.md)：分辨率、录制工具、命名、放置位置、如何嵌入 README。

See [RECORDING.md](RECORDING.md) for resolution, tools, naming, placement, and how to embed in the README.

## 一句话演示脚本（每个功能的 TL;DR）

- **PCB→BSP**：`资产 → 🧩 PCB 导入 → 贴 github.com/cfrpg/Vigilator → 提取 BSP`
- **设备上机**：`真实 → 检测 → ⚡一键上机`
- **真板调通**：`资产 → 调通 → ▶ 开始任务`（插着真板时自动走 real + 烙印）
- **DevReady**：`右栏资产卡片 → .flux 文件页`
- **小Flux**：右下角桌宠输入 `我有个项目 <url> 要做 BSP`
