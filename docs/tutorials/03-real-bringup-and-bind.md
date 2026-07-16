# 剧本 03 — 真板调通 + 芯片烙印（六阶段黄金路径）

**视频文件**：`media/03-real-bringup-and-bind.mp4` · **时长**：~3min

## 一句话价值
> 一个按钮，六个阶段：识别→入库→计划→验证→沉淀→烙印。最后一步把资产指纹永久写进真芯片的 Flash——资产和硅片双向绑定，断电不丢。

## 前置准备
- NUCLEO-H743ZI2 接上，已在真实页授权过 USB（🔓授权，输系统密码）
- 装了 openocd；studio 停在「📦 资产 → 调通」子页

## 分镜
| # | 画面 | 操作 | 旁白（中） | 预期 |
|---|---|---|---|---|
| 1 | 调通页一个按钮 | — | "没有下拉、没有输入框——AI 自己判断。板子插着，它就走真板路径。" | 「▶ 开始任务」+ 一行"自动识别已连接的板卡" |
| 2 | ▶ 开始任务 | 点击 | "点开始。" | 底部 🎯自动选定: NUCLEO-H743ZI2 · real |
| 3 | 六盏阶段灯 | 看灯依次亮 | "识别、入库、计划、验证……" | 五盏灯依次转绿，进行中显 ⏳秒表 |
| 4 | 验证阶段 | — | "验证是真读芯片——读到 IDCODE 0x20036450，设备号 0x450，正是 STM32H743。" | verify 灯绿，detail 显 IDCODE |
| 5 | 第六盏「烙印」 | 看它亮 | "第六阶段是烙印——把 DevReady 记录写进真芯片的 Flash。" | bind 灯绿，detail 显 `UID … @ 0x080e0000` |
| 6 | 结果卡 | — | "✓ DevReady。这块物理芯片现在永久记着它是哪个资产的实例，拔电、隔月都不丢。" | ✓ DevReady 卡片 |

## 英文字幕
- "No dropdowns — the AI decides. A board is plugged in, so it goes real."
- "Verify reads the live silicon: IDCODE 0x20036450, device 0x450 — that's an STM32H743."
- "The 6th phase, Bind, writes the DevReady record into the chip's Flash. Asset and silicon, bound for good."

## 可复现验证
```bash
brain/.venv/bin/python -c "
import sys; sys.path.insert(0,'brain'); from flux_brain import chip_bind
print(chip_bind.verify_chip_live('nucleo-h743zi2','skills/boards.json'))"
# 期望 ok=True, idcode 0x20036450, device_id 0x450
```

## 真实数据锚点
- IDCODE `0x20036450`，device_id `0x450`（STM32H743）
- Flash 记录地址 `0x080E0000`（Bank0 末 sector，离固件 896KB，非破坏）
- 记录 = `FLUX` 魔数 + 资产指纹 `8471f459…` + 芯片 UID + `DE7EAD15` 标记
