# 剧本 05 — 小Flux 向导（对话即操作，AI 带你走完流程）

![demo](media/05-desk-pet-guided.gif)

> ↑ 小 Flux 桌宠助手：只读、快捷入口、对话引导


**视频文件**：`media/05-desk-pet-guided.mp4` · **时长**：~2min

## 一句话价值
> 不知道功能在哪？对右下角的小Flux 说一句大白话，它分类你的意图，然后一步步高亮该点的控件带你走——不代替你操作，教你操作。

## 前置准备
- studio 已启动；小Flux（右下角 🤖）可见
- LLM 已配置（deepseek flash，用于意图分类）

## 分镜
| # | 画面 | 操作 | 旁白（中） | 预期 |
|---|---|---|---|---|
| 1 | 右下角桌宠 | 点开小Flux | "不知道怎么做 BSP？问它。" | 对话窗打开 |
| 2 | 输入框 | 输入"我有个项目 https://github.com/cfrpg/Vigilator 要做 BSP" | "我把项目链接和目标直接告诉它。" | 消息发出 |
| 3 | 小Flux 回应 | — | "它听懂了，开始引导——注意界面上的高亮。" | 冒泡"我来引导你：从 PCB 项目制作 BSP" |
| 4 | 「资产」tab 高亮 | 按提示点 | "第一步，它高亮了资产页，我点它。" | 资产 tab 脉冲高亮 → 点击后切换 |
| 5 | 「PCB 导入」子页高亮 | 按提示点 | "第二步，PCB 导入子页。" | sub-pcb 高亮 → 点击 |
| 6 | URL 框 + 提取按钮高亮 | 贴 URL → 点提取 | "第三步贴链接，第四步提取——它全程只高亮，我自己点。" | 依次高亮，跑出 BSP |
| 7 | 收尾 | — | "AI 排定流程、高亮引导、人来确认——三方协作，不是黑箱代操作。" | — |

## 英文字幕
- "Don't know where a feature is? Just tell the pet in plain words."
- "It classified my intent and starts guiding — watch the highlights."
- "It only highlights; you click. AI plans, you confirm."

## 真实机制锚点
- 分类走 `guide_match`（light 层，deepseek-flash）
- 引导流注册表：`app/renderer/src/guides.ts`（pcb-bsp / onboard / bringup / …）
- 事件驱动步进：观察 centerTab / assetsSub / 总线事件 / 控件点击
