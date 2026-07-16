# 剧本 01 — PCB → BSP（从设计文件提取板级支持包）

![PCB to BSP demo](media/01-pcb-to-bsp.gif)

> ↑ 真实界面自动化录制（Playwright 驱动 Electron）：贴 `github.com/cfrpg/Vigilator` → 提取 BSP → 交互连接图。点 MLX90640，只有 PA5/PA6（I2C）高亮。

**视频文件**：`media/01-pcb-to-bsp.gif`（自动生成）· **时长**：~8s · **界面语言**：录 zh + en 各一版

## 一句话价值 / Hook

> 一块自定义板、没有厂商件、没有 SVD——只要它有设计文件，贴个 GitHub 链接，studio 就能自动认出 MCU、所有引脚、外设，还画出「哪个引脚连了哪个器件」的交互图。

## 前置准备 / Setup

- studio 已启动（`pnpm dev`），停在「📦 资产」页
- 断网也能录后半段（clone 需要网）；或提前 `git clone https://github.com/cfrpg/Vigilator ~/.flux/projects/Vigilator` 预热缓存
- 演示对象：**Vigilator**（PIR + MLX90640 热成像人体检测器，STM32L031F6Px，Altium 工程）

## 分镜 / Storyboard

| # | 画面 | 操作 | 旁白（中） | 预期结果 |
|---|---|---|---|---|
| 1 | 资产页三个子 tab | 点「🧩 PCB 导入」 | "自定义板没有厂商件，怎么建 BSP？看这个。" | 进入 PCB 导入页，顶部说明文字 |
| 2 | URL 输入框 | 粘贴 `https://github.com/cfrpg/Vigilator` | "这是一个开源的 PIR 热成像项目，我直接贴它的 GitHub 链接。" | URL 填入输入框 |
| 3 | 「⚙ 提取 BSP」按钮 | 点击 | "点提取——它会先克隆项目，再解析设计文件。" | 按钮转 …，底部终端出现 `⬇ cloning …` |
| 4 | 结果卡片出现 | （等 5-10s） | "MCU 认出来了：STM32L031F6Px，Cortex-M0+，15 个引脚，外设 ADC/RTC/TIM2/USART2。" | 绿色 ✓ 卡片：MCU + 架构 + 引脚数 + 外设 + 板载器件 |
| 5 | **交互连接图** | 鼠标悬停/点击 MLX90640 器件框 | "关键是这张图——点热成像传感器 MLX90640。" | 只高亮 MLX90640 连的引脚 PA5/PA6（I2C），其余变暗 |
| 6 | 图上点 PA9 引脚 | 点击 | "反过来点某个引脚，看它连到哪。PA9 是串口，连到 CH343P USB 转串口。" | 高亮 PA9→CH343P |
| 7 | 明细表 | 下滑到连接表 | "图下面是完整明细表，每个引脚的功能、连接的器件，一目了然。" | 表格：GPIO / 功能 / 连接到 |
| 8 | 收尾 | — | "整个过程零命令行、零编造——全是从 .ioc 和网表真解析出来的。这块板的 DevReady 资产已经生成，接下来就能开发固件。" | — |

## 关键台词（英文字幕版）

- "A custom board with no vendor part — just paste its GitHub URL."
- "It cloned the repo, parsed the design files, and identified the MCU: STM32L031F6Px."
- "Click the thermal camera — it highlights exactly which pins it's wired to: PA5/PA6 on I2C."
- "Everything is parsed from the real `.ioc` and netlist — nothing is invented."

## 可复现验证（录制前自测通过）

```bash
cd /home/exuber/CODE/FLUXworkbench
git clone --depth 1 https://github.com/cfrpg/Vigilator ~/.flux/projects/Vigilator
brain/.venv/bin/python -c "
import sys; sys.path.insert(0,'brain')
from flux_brain import pcb_ingest, os
out = pcb_ingest.ingest_design(os.path.expanduser('~/.flux/projects/Vigilator'), 'skills/boards.json')
print(out['mcu'], out['pin_count'], 'pins', out['board_devices'])"
# 期望：STM32L031F6Px 15 pins ['…','U5=MLX90640','U6=CH343P',…]
```

## 真实数据锚点（旁白别念错）

- MCU：**STM32L031F6Px**（Cortex-M0+）
- 引脚：15；外设：ADC / RTC / TIM2 / USART2
- MLX90640 热成像 → I2C（PA5=SCL, PA6=SDA）
- CH343P USB-串口 → USART2（PA9=TX, PA10=RX）
- PIR 人体传感器 → PA0 唤醒
