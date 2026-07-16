# 录制约定 / Recording Conventions

## 工具 / Tools

- **屏幕录制**：OBS Studio（跨平台，免费）或 macOS 自带 `Cmd+Shift+5` / Windows `Win+G`。
- **转 GIF**（README 里内联预览用）：`ffmpeg -i in.mp4 -vf "fps=12,scale=900:-1" out.gif`
- **终端演示**（可选，命令类步骤）：`asciinema rec` → `agg` 转 gif。

## 规格 / Specs

| 项 | 值 |
|---|---|
| 分辨率 | 1440×900（studio 默认窗口尺寸，见 `app/main/index.ts` createWindow） |
| 帧率 | 30fps 录，导 GIF 降到 12fps |
| 光标 | 打开高亮/放大（OBS 里加 cursor highlight） |
| 语言 | 录两版：中文旁白 + 英文字幕，或界面切 zh/en 各录一遍（右上角语言开关） |
| 时长 | 单功能 ≤3min，超了拆成多段 |

## 命名与放置 / Naming & placement

```
docs/tutorials/
├── media/
│   ├── 01-pcb-to-bsp.mp4        # 完整视频
│   ├── 01-pcb-to-bsp.gif        # README 内联预览（≤5MB）
│   └── 02-device-onboard.mp4
```

- 文件名 = 剧本编号 + 功能 slug，和各 `.md` 顶部声明的一致。
- GIF 控制在 5MB 以内（GitHub 内联渲染）；完整 mp4 可上传 Release 附件或用 Git LFS。

## 嵌入 README / Embedding

GitHub 不内联播放 mp4，但内联 GIF。在 README/剧本里：

```markdown
![PCB to BSP](media/01-pcb-to-bsp.gif)
[▶ 完整视频 / full video](media/01-pcb-to-bsp.mp4)
```

mp4 若走 Git LFS：`git lfs track "docs/tutorials/media/*.mp4"`。

## 录制前环境准备 / Pre-flight

统一在剧本各自的「前置准备」里；通用项：
- studio 已构建：`cd /home/exuber/CODE/FLUXworkbench && pnpm dev`
- 关掉桌宠首启气泡以外的干扰通知
- 清一个干净的 workspace（避免旧资产刷屏）：新建一个空 workspace 再录
