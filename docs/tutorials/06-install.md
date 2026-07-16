# 剧本 06 — 跨平台一键安装

**视频文件**：`media/06-install.mp4` · **时长**：~1min

## 一句话价值
> Windows / macOS / Linux，下载一个安装包，双击装完即用——内嵌 Python 运行时，不用你装 Python、Node、conda。

## 分镜
| # | 画面 | 操作 | 旁白（中） | 预期 |
|---|---|---|---|---|
| 1 | GitHub Releases 页 | 打开 releases | "去 Releases 页，选你的系统。" | 三平台安装包列表 |
| 2 | 下载对应包 | 点下载 | "Windows 是 .exe，Mac 是 .dmg，Linux 是 AppImage。" | 下载 |
| 3 | 双击安装 | — | "双击装完，自动启动——它自带 Python 运行时，什么都不用你装。" | studio 启动，mock 模式直接可玩 |
| 4 | 首启即用 | 点开始任务（mock） | "第一次启动就是 mock 模式，不接硬件也能跑通整条流程。" | 任务跑通 |

## 英文字幕
- "One installer per OS. Double-click. Done."
- "It bundles its own Python runtime — no Python, Node, or conda to install."
- "First boot runs in mock mode — explore everything with no hardware."

## 参考
- 安装文档：[../../INSTALL.md](../../INSTALL.md)
- 打包脚本：`scripts/fetch-python.mjs`（内嵌 CPython）+ `.github/workflows/release.yml`（三平台 CI）
