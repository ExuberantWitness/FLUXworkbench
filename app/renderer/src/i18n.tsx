// Lightweight i18n — zh/en UI switch, persisted to localStorage.
// Usage: const { t, lang, setLang } = useLang();  <span>{t("tab.chat")}</span>
import React, { createContext, useContext, useState } from "react";

export type Lang = "en" | "zh";

const dict: Record<string, { en: string; zh: string }> = {
  // center tabs
  "tab.chat": { en: "💬 Chat", zh: "💬 对话" },
  "tab.fluxweave": { en: "🧵 FluxWeave", zh: "🧵 装配" },
  "tab.unitport": { en: "🤖 UnitPort", zh: "🤖 训练" },
  "tab.hil": { en: "🧪 HIL", zh: "🧪 在环测试" },
  "tab.plan": { en: "📖 Plan", zh: "📖 计划" },
  // left sidebar sections
  "side.api": { en: "API Provider", zh: "API 服务商" },
  "side.workflow": { en: "Workflow", zh: "工作流" },
  "side.agents": { en: "Agents", zh: "代理" },
  "side.skills": { en: "Skills (ClawhHub)", zh: "技能 (ClawhHub)" },
  "side.mcp": { en: "MCP Servers", zh: "MCP 服务" },
  "side.tools": { en: "Tools", zh: "工具链" },
  "side.endpoint": { en: "Endpoint", zh: "端点" },
  "side.model": { en: "Model", zh: "模型" },
  "side.apikey": { en: "API Key", zh: "密钥" },
  // right panel
  "rp.build": { en: "Cross-Compile", zh: "交叉编译" },
  "rp.building": { en: "Building…", zh: "编译中…" },
  "rp.buildBtn": { en: "▶ Build (flash_xip)", zh: "▶ 编译 (flash_xip)" },
  "rp.assets": { en: "DevReady Assets", zh: "DevReady 资产" },
  "rp.events": { en: "Events", zh: "事件" },
  "rp.assetCount": { en: "Assets", zh: "资产数" },
  // problems drawer
  "prob.title": { en: "PROBLEMS", zh: "问题" },
  "prob.diagnostics": { en: "diagnostics", zh: "条诊断" },
  "prob.triage": { en: "triage", zh: "条分诊" },
  "prob.diagHead": { en: "DIAGNOSTICS", zh: "构建诊断" },
  "prob.noDiag": { en: "no build diagnostics", zh: "暂无构建诊断" },
  "prob.sentinel": { en: "SENTINEL TRIAGE", zh: "Sentinel 分诊" },
  "prob.noTriage": { en: "no triage results — failures land here automatically", zh: "暂无分诊结果——失败会自动出现在这里" },
  "prob.manual": { en: "MANUAL TRIAGE", zh: "手动分诊" },
  "prob.paste": { en: "paste any error output…", zh: "粘贴任意报错内容…" },
  "prob.triageBtn": { en: "🔍 Triage", zh: "🔍 分诊" },
  // HIL panel
  "hil.goalPh": { en: "Describe what the firmware must do…", zh: "描述固件应有的行为…" },
  "hil.generate": { en: "⚡ Generate Plan", zh: "⚡ 生成测试计划" },
  "hil.template": { en: "📄 Template", zh: "📄 模板" },
  "hil.fromAsset": { en: "plan generated from register-map asset", zh: "计划已从寄存器资产生成" },
  "hil.fromTemplate": { en: "(template plan — LLM unavailable)", zh: "(模板计划——LLM 不可用)" },
  "hil.planPh": { en: "Test plan JSON (flux.hil.plan/v1) — generate one or paste here", zh: "测试计划 JSON (flux.hil.plan/v1)——生成或粘贴" },
  "hil.run": { en: "▶ Run", zh: "▶ 运行" },
  "hil.running": { en: "⏳ Running…", zh: "⏳ 运行中…" },
  "hil.reportNote": { en: "report committed as hil-report asset", zh: "报告已作为 hil-report 资产入库" },
  // UnitPort panel
  "up.load": { en: "📦 Load Templates", zh: "📦 加载模板" },
  "up.compiling": { en: "compiling…", zh: "编译中…" },
  "up.spec": { en: "TRAINING SPEC", zh: "训练配置 (Spec)" },
  "up.issues": { en: "issues", zh: "个问题" },
  "up.specPh": { en: "pick a template on the left, or paste a TrainingSpec JSON", zh: "从左侧选择模板，或粘贴 TrainingSpec JSON" },
  "up.train": { en: "▶ Train (kernel)", zh: "▶ 训练（内核调度）" },
  "up.cancel": { en: "■ Cancel", zh: "■ 取消" },
  "up.run": { en: "RUN", zh: "运行" },
  "up.live": { en: "· live", zh: "· 运行中" },
  "up.done": { en: "· done", zh: "· 已完成" },
  "up.metricsHint": { en: "training.metrics events stream here once a run starts", zh: "训练开始后 training.metrics 事件将在此实时滚动" },
  "up.isaac": { en: "ISAAC SIM 6 / ISAACLAB", zh: "ISAAC SIM 6 / ISAACLAB" },
  "up.detecting": { en: "detecting GPU…", zh: "正在检测显卡…" },
  "up.noGpu": { en: "✗ No NVIDIA GPU — Isaac Sim requires an RTX GPU", zh: "✗ 未检测到 NVIDIA 显卡 — Isaac Sim 需要 RTX GPU" },
  "up.driverLow": { en: " (<580, upgrade recommended)", zh: " (<580, 建议升级)" },
  "up.installing": { en: "⏳ Installing… (~10GB)", zh: "⏳ 安装中… (~10GB)" },
  "up.install": { en: "⬇ One-click install Isaac Sim 6 + IsaacLab", zh: "⬇ 一键安装 Isaac Sim 6 + IsaacLab" },
  "up.cancelInstall": { en: "■ Cancel Install", zh: "■ 取消安装" },
  // FluxWeave panel
  "fw.robot": { en: "ROBOT", zh: "机器人" },
  "fw.generate": { en: "⚙ Generate URDF", zh: "⚙ 生成 URDF" },
  "fw.parts": { en: "PARTS", zh: "零件" },
  "fw.joints": { en: "JOINTS", zh: "关节" },
  "fw.stlPh": { en: "STL path (optional)", zh: "STL 路径（可选）" },
  "fw.urdf": { en: "URDF", zh: "URDF" },
  "fw.committed": { en: "· committed as", zh: "· 已入库为" },
  "fw.urdfPh": { en: "generated URDF appears here", zh: "生成的 URDF 显示在这里" },
  "fw.axis": { en: "axis", zh: "转轴" },
  "fw.atParent": { en: "@parent", zh: "@父点" },
  "fw.atChild": { en: "@child", zh: "@子点" },
  // footer
  "foot.device": { en: "device", zh: "设备" },
  "foot.assets": { en: "assets", zh: "资产" },
};

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const Ctx = createContext<LangCtx>({ lang: "en", setLang: () => void 0, t: (k) => k });

export function LangProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const initial = ((): Lang => {
    const saved = localStorage.getItem("flux.lang");
    if (saved === "zh" || saved === "en") return saved;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  })();
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = (l: Lang): void => {
    localStorage.setItem("flux.lang", l);
    setLangState(l);
  };
  const t = (key: string): string => dict[key]?.[lang] ?? key;
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
