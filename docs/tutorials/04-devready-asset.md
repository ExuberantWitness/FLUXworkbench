# 剧本 04 — DevReady 资产（自描述、自包含的 .flux 活档案）

![demo](media/04-devready-asset.gif)

> ↑ DevReady 资产详情：序列号 + 六个页签（引脚/RTOS/记忆/离线资料/.flux）


**视频文件**：`media/04-devready-asset.mp4` · **时长**：~2min

## 一句话价值
> 每块调通的板子沉淀成一个 `.flux` 文件——BODY（结构/引脚/内存图）+ MIND（RTOS/工具链/踩坑记忆/官方资料）+ JOURNAL（生命记录）。任何人/agent 拿到它，从"这是什么"到"怎么编译"到"哪会踩坑"全知道。

## 前置准备
- 已有至少一个 devready 资产（跑过剧本 02/03，或 PCB 导入）
- studio 任意页，右栏资产面板可见

## 分镜
| # | 画面 | 操作 | 旁白（中） | 预期 |
|---|---|---|---|---|
| 1 | 右栏 DevReady 资产列表 | 点一张 devready 卡片 | "点开一个 DevReady 资产。" | 弹出资产详情弹窗 |
| 2 | 详情页多个 tab | 依次点 引脚分布 | "BODY：引脚分布、内存映射、启动模式、可用 RTOS。" | 引脚网格 + 内存区 + RTOS 行 |
| 3 | 「记忆·历史」页 | 点 | "MIND：这块板的调试记忆——libtool 缺 sudo 怎么装、jimtcl 子模块、udev 授权……都是真踩过的坑。" | 教训列表（curated + triage 溯源） |
| 4 | 「离线资料」页 | 点 | "官方资料随资产走——断网也能查 README/参考手册。" | references URL 列表 |
| 5 | 「.flux 文件」页 | 点 → copy path | "整个资产是一个 .flux 文件，可导出、可 copy path、可搬到另一台机器。" | 显示 `~/.flux/devready/<board>.flux` + 复制按钮 |
| 6 | 收尾 | — | "born in reality, perpetually real——资产不只是数据库记录，是和真芯片绑定的活档案。" | — |

## 英文字幕
- "Each brought-up board becomes a `.flux` file: BODY, MIND, JOURNAL."
- "MIND carries this board's real debugging memory — the exact traps, with fixes."
- "Official docs travel with the asset — queryable offline."

## 可复现验证
```bash
brain/.venv/bin/python -c "
import sys,json; sys.path.insert(0,'brain'); from flux_brain import asset_store
d=asset_store.get_asset('devready-hpm6e00evk'); c=d['characterization']
print('RTOS:',[r['name'] for r in c['mind']['rtos']['available']])
print('memory lessons:',len(c['mind']['memory']),'| refs:',len(c['mind']['references']))"
```
