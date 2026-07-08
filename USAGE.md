# Flux Workbench — 用户使用手册

## 这是什么

Flux Workbench 是机器人开发领域的 Claude Code：一个 VSCode 风格的一站式硬件开发 studio。
- 本地 MiniCPM-V 4.1 AI agent 做原理图理解、板级特性化、驱动生成
- OpenOCD 真板调试烧录（HPM6E00 等 RISC-V MCU）
- devready 资产飞轮（每次开发产出可复用资产）
- 外设代码生成器（替代 CubeMX GUI）

## 前置条件（一次性安装）

### 1. 系统要求
- Ubuntu 22.04+ (Linux)
- NVIDIA GPU ≥ 8GB 显存（跑 MiniCPM-V 4.1）
- Python 3.12+, Node.js 22+, pnpm 9+

### 2. GPU 驱动 + CUDA Toolkit
```bash
# NVIDIA 驱动
sudo apt install nvidia-driver-535  # 或更新
sudo reboot
nvidia-smi  # 验证

# CUDA Toolkit 13.0（vLLM/flashinfer 需要 nvcc）
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update && sudo apt install -y cuda-toolkit-13-0
export CUDA_HOME=/usr/local/cuda-13.0 PATH=$CUDA_HOME/bin:$PATH LD_LIBRARY_PATH=$CUDA_HOME/lib64:$LD_LIBRARY_PATH
```

### 3. vLLM + MiniCPM-V 模型
```bash
# 建 venv + 装 vLLM
python3.12 -m venv model-server/.venv
model-server/.venv/bin/pip install vllm modelscope

# 下模型（从 ModelScope，国内快）
model-server/.venv/bin/python -c "
from modelscope import snapshot_download
print(snapshot_download('OpenBMB/MiniCPM-V-4.6'))
"
```

### 4. Python brain 环境
```bash
cd FLUXworkbench
python3 -m venv brain/.venv
brain/.venv/bin/pip install ollama httpx Pillow
```

### 5. HPM SDK + RISC-V 工具链（仅 HPM6E00 开发需要）
```bash
# RISC-V GCC
wget https://github.com/hpmicro/riscv-gnu-toolchain/releases/download/2023.10.18/rv32imac_zicsr_zifencei_multilib_b_ext-linux.tar.gz
sudo tar xzf rv32imac_*.tar.gz -C /opt/riscv --strip-components=1
export PATH=/opt/riscv/bin:$PATH

# HPM SDK
git clone https://github.com/hpmicro/hpm_sdk.git ~/hpm_sdk

# HPMicro OpenOCD（带 hpm_xpi flash 驱动）
git clone https://github.com/hpmicro/riscv-openocd.git /tmp/hpm-openocd
cd /tmp/hpm-openocd && ./bootstrap && ./configure --enable-ftdi && make -j4
```

### 6. Node 依赖
```bash
cd FLUXworkbench
pnpm install  # 注意用 pnpm 不是 npm
```

## 启动

### 一键启动（推荐）
```bash
cd FLUXworkbench
./start.sh
```
这会自动：启动 vLLM（MiniCPM-V）→ 构建 studio → 启动 Electron 窗口。

### 手动启动
```bash
# 终端 1：启动 vLLM
model-server/.venv/bin/vllm serve <model_path> --port 8000 --enforce-eager --gpu-memory-utilization 0.7

# 终端 2：启动 studio（mock OpenOCD，无需硬件）
env -u ELECTRON_RUN_AS_NODE pnpm --filter @fluxworkbench/app dev -- --disable-gpu --no-sandbox

# 终端 2（连真板）：
env -u ELECTRON_RUN_AS_NODE FLUX_OPENOCD_REAL=1 \
  FLUX_OPENOCD_BIN=/tmp/hpm-openocd/src/openocd \
  HPM_SDK_BASE=~/hpm_sdk \
  pnpm --filter @fluxworkbench/app dev -- --disable-gpu --no-sandbox
```

## 使用

### 界面
- **左侧栏**：kernel peer 状态（brain/openocd 在线灯）+ workflow DAG + 资产计数
- **中间**：Monaco 代码编辑器（写/改固件 C / Python / YAML）
- **底部面板**（两个 tab）：
  - **uORB events**：实时事件流（device.attached → workflow → flash → characterize → asset.committed → alarm）
  - **agent chat**：与 MiniCPM-V 4.1 对话（输入问题，回车发送）
- **状态栏**：设备状态（REAL/mock）+ brain 状态 + 告警 + 资产计数

### 典型流程
1. **启动** → studio 自动跑 board-bringup workflow
2. **事件流**里看到完整 vertical：device.attached → flash → characterize（MiniCPM-V）→ asset.committed
3. **agent chat** 里可以问 MiniCPM-V 任何问题（芯片特性、驱动写法、电路理解）
4. **Monaco 编辑器** 里写/改代码
5. **飞轮**：每次 characterize 的结果自动存入 `~/.flux/assets.db`（FTS5 可搜索）

### 原理图→netlist（独立使用）
```bash
PYTHONPATH=brain brain/.venv/bin/python -c "
from flux_brain.llm_vllm import schematic_to_netlist
import json; print(json.dumps(schematic_to_netlist('your_schematic.png'), indent=2))
"
```

### HPM6E00 交叉编译
```bash
export PATH=/opt/riscv/bin:$PATH GNURISCV_TOOLCHAIN_PATH=/opt/riscv HPM_SDK_BASE=~/hpm_sdk
brain/.venv/bin/python -c "
from flux_brain.build_hpm import build; print(build('~/hpm_sdk/samples/hello_world'))
"
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `FLUX_OPENOCD_REAL` | 0 | 1=连真板, 0=mock |
| `FLUX_OPENOCD_BIN` | /tmp/hpm-openocd/src/openocd | HPM OpenOCD 路径 |
| `HPM_SDK_BASE` | /home/exuber/hpm_sdk | HPM SDK 路径 |
| `FLUX_MODEL_PATH` | ~/.cache/modelscope/.../MiniCPM-V-4.6 | 模型路径 |
| `FLUX_VISION_MODEL` | (auto from :8000) | vLLM served model ID |

## 分发给其他用户

### 目前状态
当前是**开发原型**。发给最终用户前需要：

1. **electron-builder 打包**（产出 AppImage/.deb）— TODO
2. **Python brain 打包**（PyInstaller 产 binary sidecar）— TODO
3. **MiniCPM-V 模型预下载**或**首次运行自动拉取**— TODO
4. **OpenOCD/GCC 工具链**作为可选插件包，非核心功能时不要求

### 可以现在做的
- 把整个 `FLUXworkbench/` 目录 + `model-server/` 目录打包
- 给用户上面的安装指南
- 用户按指南装好前置后 `./start.sh` 即可

## 故障排除

| 症状 | 解决 |
|---|---|
| `nvidia-smi: No devices` | 检查驱动 + Secure Boot 关闭 |
| vLLM 启动失败 `nvcc not found` | 装 CUDA Toolkit（不是只驱动）|
| vLLM `flashinfer version mismatch` | `export FLASHINFER_DISABLE_VERSION_CHECK=1` |
| Electron 窗口白屏 | `--disable-gpu --no-sandbox` |
| npm 装包卡死 | 用 `pnpm`（不是 npm）；仓库是 pnpm workspace |
| brain 报 `No module named 'flux_brain'` | `export PYTHONPATH=brain` |
| OpenOCD `LIBUSB_ERROR_ACCESS` | `sudo` 或设 udev 规则 |
