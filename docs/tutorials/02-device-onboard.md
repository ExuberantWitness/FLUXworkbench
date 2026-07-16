# 剧本 02 — 设备上机（插上任意 MCU，自动识别→建档→入库）

**视频文件**：`media/02-device-onboard.mp4` · **时长**：~2min

## 一句话价值
> 插上一块从没配置过的开发板，studio 自动认出探针、读出序列号、找到芯片、拉取寄存器手册、建立档案——你只点一个按钮。

## 前置准备
- 一块真实开发板（本剧本用 **NUCLEO-H743ZI2**，板载 ST-Link/V3）用 USB 接上
- studio 已启动，停在「🔌 真实」页
- 已装 openocd（`sudo apt install openocd`）

## 分镜
| # | 画面 | 操作 | 旁白（中） | 预期 |
|---|---|---|---|---|
| 1 | 真实页「真实设备」栏 | 点 ↻检测 | "插上板子，点检测。" | 列出 NUCLEO-H743ZI2，绿点=已插入 |
| 2 | 设备行 | 指出 vid:pid + 芯片 | "它认出了 ST-Link/V3，芯片是 STM32H743ZI。" | 显示 `0483:374e · STM32H743ZI` |
| 3 | ⚡一键上机 按钮 | 点击 | "点一键上机——自动建档、拉 SVD、把探针序列号写进资产。" | 按钮转 ⚡…，随后绿字结果 |
| 4 | 结果提示 | — | "上机完成：STM32H743ZI，2955 个寄存器入库，序列号已烙进 DevReady 资产。" | `✓ 已上机: STM32H743ZI · 2955 regs · SN 0042…` |
| 5 | 切右栏资产 | 看资产列表 | "右边资产库里，这块板的 devready 资产已经生成。" | 出现 devready-nucleo-h743zi2 |

## 英文字幕
- "Plug in a board that's never been configured — click Scan."
- "It found the ST-Link/V3 probe and the STM32H743ZI chip."
- "One-click onboard: builds the profile, fetches the register map, stamps the serial into a DevReady asset."

## 可复现验证
```bash
lsusb | grep 0483   # 期望 0483:374e (STLINK-V3)
# studio 内点检测→一键上机；或 headless:
FLUX_HOME=/tmp/onbtest brain/.venv/bin/python -c "
import sys; sys.path.insert(0,'brain'); from flux_brain import onboard
print(onboard.onboard('skills/boards.json', board='nucleo-h743zi2')['steps'])"
```

## 真实数据锚点
- 探针：ST-Link/V3，USB `0483:374e`，SN `004600293438510C34313939`
- 芯片：STM32H743ZI；SVD 入库 128 外设 / 2955 寄存器
