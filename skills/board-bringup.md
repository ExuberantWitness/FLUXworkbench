# Board Bring-up（通用板卡调通）

FluxStudio 原生技能：把任意开发板从"插上"带到"DevReady 资产"。板卡差异全部住在
`skills/boards.json` 档案里——**新板卡 = 加一条档案，不改流程**。

## 流程（studio 内完成，与档案字段一一对应）

1. **检测**（`usb.vid/pid`）：真实页设备栏自动匹配已插入的调试器。
2. **授权**（一次性）：USB 设备节点默认 root 只读；设备栏「一键授权」按钮经系统
   授权框（pkexec）安装 udev 规则，无需终端。
3. **连接**（`openocd.*`）：设备栏「连接真板」用档案里的 bin/cfgs 起 OpenOCD，
   物理 subagent 从 mock 切真板；TAP id 对上即识别成功。
4. **编译**（`build.*`）：资产详情「交叉编译」页 / build_service 读
   `toolchain_env`（未设置时按 `toolchain_glob` 自动探测 ~/toolchains）。
5. **入资产**（`pinmux` / `svd`）：黄金路径识别步骤：有 SVD 用 `ingest_svd`；
   没有 SVD 的板卡（如 HPMicro 全系）自动回退 `ingest_pinmux` 解析板级
   pinmux.c → 引脚资产；调通经验用 `commit_asset` 追加。
6. **流通**（`export_asset`/`import_asset`）：资产面板 ⬆⬇ 按钮，JSON bundle
   （flux.assets/v1）跨机器/跨工作空间迁移。

## 已验证档案

| 板卡 | 芯片 | 调试器 | 备注 |
|---|---|---|---|
| hpm6e00evk | HPM6E80 (RISC-V) | FT2232 0403:6010 | 2026-07 全流程实测；soc cfg 是 hpm6e80 不是 hpm6e00；烧录必须 hpmicro fork（hpm_xpi） |
| hpm5300evk | HPM5361 (RISC-V) | FT2232 0403:6010 | 同 HPM 工具链/OpenOCD，未实测 |
| stm32f103-bluepill | STM32F103 (CM3) | ST-Link 0483:3748 | 上游 OpenOCD 即可烧录；SVD 路线 |

## 供给坑位（任何板卡通用）

- 工具二进制装 `~/tools`、`~/toolchains`，**永远不放 /tmp**（会被清空）。
- 无 sudo 装 autotools 依赖：源码装 `~/tools/local` 并 `export ACLOCAL_PATH=~/tools/local/share/aclocal`。
- depth-1 克隆 OpenOCD 缺 jimtcl：`git submodule update --init jimtcl` + `--enable-internal-jimtcl`。
- cmake 报 `No module named yaml`：shell 被 venv 污染用错 python，`export PATH=/usr/bin:$PATH`。
- agent shell 启动 studio 前 `env -u ELECTRON_RUN_AS_NODE`。

## 给助手（桌宠）的话术锚点

- 「怎么调通我的板子」→ 引导：真实页设备栏 → 授权 → 连接 → 资产页设备调通。
- 「不支持我的板子」→ 指引在 skills/boards.json 加档案（六个字段组）。
- 权限报错 LIBUSB_ERROR_ACCESS → 设备栏「一键授权」。
