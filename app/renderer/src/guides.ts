// Guided-flow registry — the "map" the desk pet reads to lead a user through a
// workflow by highlighting one control at a time. Data only: authored by hand,
// deterministic, no model planning. The pet's ONLY model call is intent
// classification (guide_match) → picks a flow id from this list.
//
// advance = the observable signal that the current step is done, so the engine
// auto-highlights the next control. The pet never operates for the user — it
// only highlights; the USER clicks.

export type Advance =
  | { kind: "tab"; tab: string }                                   // centerTab became this
  | { kind: "subtab"; sub: string }                               // assets sub-tab became this
  | { kind: "click" }                                              // the highlighted control was clicked
  | { kind: "event"; topic: string; where?: Record<string, unknown> }; // a bus event matched

export interface GuideStep {
  guide: string;   // data-guide anchor id to highlight
  tipKey: string;  // i18n key for the one-line instruction
  advance: Advance;
}

export interface Guide {
  id: string;
  titleKey: string;
  match: string;   // natural-language description for the classifier
  steps: GuideStep[];
  next?: string;   // chain into another flow when this one finishes
}

export const GUIDES: Guide[] = [
  {
    id: "onboard",
    titleKey: "guide.onboard.title",
    match: "我连接/插入了一块新板子/开发板/单片机(hpm/stm32/h743/nucleo等)想让系统识别并自动建立档案+SVD寄存器资产+序列号; onboard a new/unknown MCU board, auto-detect and provision, any chip",
    steps: [
      { guide: "tab-real", tipKey: "guide.onboard.s1", advance: { kind: "tab", tab: "real" } },
      { guide: "dev-scan", tipKey: "guide.onboard.s2", advance: { kind: "click" } },
      { guide: "dev-onboard", tipKey: "guide.onboard.s3", advance: { kind: "event", topic: "asset.committed", where: { type: "devready" } } },
    ],
    next: "bringup",
  },
  {
    id: "bringup",
    titleKey: "guide.bringup.title",
    match: "用户连接了硬件/开发板/调试器，想识别、授权 USB、连接真板；bring up a real board, connect debugger, authorize probe",
    steps: [
      { guide: "tab-real", tipKey: "guide.bringup.s1", advance: { kind: "tab", tab: "real" } },
      { guide: "dev-scan", tipKey: "guide.bringup.s2", advance: { kind: "click" } },
      { guide: "dev-authorize", tipKey: "guide.bringup.s3", advance: { kind: "click" } },
      { guide: "dev-connect", tipKey: "guide.bringup.s4", advance: { kind: "event", topic: "device.attached", where: { real: true } } },
    ],
    next: "bringup-asset",
  },
  {
    id: "bringup-asset",
    titleKey: "guide.asset.title",
    match: "把设备调通并沉淀为 devready 资产、导出资产；build a devready asset and export it, characterize a device into an asset",
    steps: [
      { guide: "tab-assets", tipKey: "guide.asset.s1", advance: { kind: "tab", tab: "assets" } },
      { guide: "sub-bringup", tipKey: "guide.asset.s2", advance: { kind: "subtab", sub: "bringup" } },
      { guide: "mission-start", tipKey: "guide.asset.s3", advance: { kind: "event", topic: "mission.milestone", where: { phase: "mission", status: "start" } } },
      { guide: "mission-start", tipKey: "guide.asset.s4", advance: { kind: "event", topic: "mission.milestone", where: { phase: "mission", status: "done" } } },
      { guide: "asset-export", tipKey: "guide.asset.s5", advance: { kind: "click" } },
    ],
  },
  {
    id: "cross-compile",
    titleKey: "guide.build.title",
    match: "交叉编译固件、给某块板卡 build 代码；cross-compile firmware, build code for a board",
    steps: [
      { guide: "asset-card", tipKey: "guide.build.s1", advance: { kind: "click" } },
      { guide: "ad-tab-build", tipKey: "guide.build.s2", advance: { kind: "click" } },
      { guide: "ad-build", tipKey: "guide.build.s3", advance: { kind: "event", topic: "build.progress", where: { phase: "done", ok: true } } },
    ],
  },
  {
    id: "sim-train",
    titleKey: "guide.train.title",
    match: "在仿真里训练机器人/强化学习、跑 RL 训练；train a robot in simulation, run RL training, node graph training",
    steps: [
      { guide: "tab-sim", tipKey: "guide.train.s1", advance: { kind: "tab", tab: "sim" } },
      { guide: "up-load", tipKey: "guide.train.s2", advance: { kind: "click" } },
      { guide: "up-template", tipKey: "guide.train.s3", advance: { kind: "click" } },
      { guide: "up-compile", tipKey: "guide.train.s4", advance: { kind: "click" } },
      { guide: "up-train", tipKey: "guide.train.s5", advance: { kind: "event", topic: "training.started" } },
    ],
  },
];

export const guideById = (id: string): Guide | undefined => GUIDES.find((g) => g.id === id);
export const classifierFlows = (): Array<{ id: string; match: string }> =>
  GUIDES.map((g) => ({ id: g.id, match: g.match }));
