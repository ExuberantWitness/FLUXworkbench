// Deterministic planning examples only. No price, availability or physical PASS inference.
export const choices = {
  environment: { indoor: "室内平整地面", outdoor: "户外／不平整地面" },
  appearance: { base: "沿用基础外观", custom: "个性化外壳／装饰" },
  payload: { light: "无额外负载", heavy: "需要携带物品" },
  duration: { short: "约 30 分钟", long: "约 2 小时" }
};

export const presets = {
  companion: { brief: "我想要一个小鸭子外观的室内互动机器人，能响应指令移动，每次玩半小时。", environment: "indoor", appearance: "custom", payload: "light", duration: "short" },
  motion: { brief: "我想要一个室内运动陪练机器人，按约定路线移动；需要先确认速度、稳定性与安全边界。", environment: "indoor", appearance: "base", payload: "light", duration: "short" },
  guide: { brief: "我想要一个在店内引导的小机器人，使用两小时，可以携带小物品；需要评估载荷、避障和续航。", environment: "indoor", appearance: "custom", payload: "heavy", duration: "long" }
};

export function normalize(input) {
  const result = { brief: String(input?.brief ?? "").trim().slice(0, 800) };
  if (result.brief.length < 6) throw new Error("请用至少 6 个字描述需求，再整理草案。");
  for (const [key, values] of Object.entries(choices)) {
    if (!Object.hasOwn(values, input?.[key])) throw new Error("需求选项无效，请重新选择。");
    result[key] = input[key];
  }
  return result;
}

export function plan(input) {
  const brief = normalize(input);
  const tests = ["运动与交互功能：先共同确认动作、速度、停止条件及安全距离。"];
  tests.push(brief.environment === "outdoor" ? "户外适应性：坡度、路面、防护与人员安全需重新评估，不沿用室内结论。" : "室内适应性：碰撞防护、避障与平整地面上的稳定性待测。");
  tests.push(brief.payload === "heavy" ? "负载：先确定质量与重心，再检查驱动力、结构强度和制动距离。" : "空载：检查整机重心、结构干涉与运动稳定性。");
  tests.push(brief.duration === "long" ? "续航：以约 2 小时为目标，评估电池空间、功耗与热安全；不保证现有平台满足。" : "续航：按约 30 分钟目标，在明确工作负载下实测功耗和温升。");
  if (brief.appearance === "custom") tests.push("外观件：检查装配配合、相机视场、散热通道和运动包络。");
  return { brief, tests, constraints: Object.entries(choices).map(([key, values]) => values[brief[key]]).join(" · "),
    scope: brief.environment === "outdoor" || brief.payload === "heavy" || brief.duration === "long"
      ? "需要新增可行性评审：载荷、长续航或户外需求可能超出现有运动平台的适用范围。"
      : "以现有室内运动平台为候选起点；具体型号、控制功能与验收阈值仍需评审确认。" };
}

export function revision(input, kind) {
  const base = normalize(input);
  if (!Object.hasOwn(choices, kind)) throw new Error("未知改型类型。");
  const options = Object.keys(choices[kind]);
  const next = options.find(value => value !== base[kind]);
  const change = `${choices[kind][base[kind]]} → ${choices[kind][next]}`;
  const items = {
    appearance: {
      reuse: ["运动机构与通信接口的设计候选", "原有控制项目与装调记录"],
      redesign: ["外壳／装饰件及其安装接口", "相邻结构的间隙与材料工艺"],
      retest: ["重心、运动干涉与装配贴合", "相机视场、散热与碰撞安全"]
    },
    payload: {
      reuse: ["已有通信协议与交互逻辑", "原有测试方案及失败记录"],
      redesign: ["载荷、重心与驱动选型", "支撑结构、控制参数及供电预算"],
      retest: ["转矩、制动与稳定性", "温升、续航和结构承载"]
    },
    duration: {
      reuse: ["已有功能需求与通信协议", "原有机械布局作为候选"],
      redesign: ["电池容量、空间与供电保护", "功耗管理与散热方案"],
      retest: ["实际工作负载下的续航和温升", "充放电安全、重心与安装配合"]
    },
    environment: {
      reuse: ["用户交互流程与功能目标", "既有模型、测试记录作为参考"],
      redesign: ["路面适应、运动机构与防护方案", "感知、供电和环境约束"],
      retest: ["新场景下稳定性与避障", "环境适应性、人员安全与续航"]
    }
  };
  return { change, ...items[kind], target: plan({ ...base, [kind]: next }) };
}

export function documentText(input, kind) {
  const original = plan(input);
  const revised = revision(input, kind);
  return ["# 数瀚衍动 · 交付规划草案", "", "状态：本地规则演示；未调用 AI、未报价、未下单、未通过物理验收。", "描述按原文保留，以下规则仅根据明确选项整理。", "", "## 原需求", original.brief.brief, original.constraints, original.scope,
    "", "## 拟定分工", "用户确认用途与取舍；数瀚衍动组织方案、供应、装调及整机验收。", "研发、加工和装调伙伴作为分包方参与，尚未匹配具体供应商。", "",
    "## 原需求待确认的验收事项", ...original.tests.map(x => `- ${x}`), "", "## 下一轮改型", revised.change,
    "### 可保留候选（不等于验证通过）", ...revised.reuse.map(x => `- ${x}`), "### 修改或补充", ...revised.redesign.map(x => `- ${x}`), "### 必须重新验证", ...revised.retest.map(x => `- ${x}`),
    "### 改型后的完整目标", revised.target.constraints, ...revised.target.tests.map(x => `- ${x}`),
    "", "## 服务与隐私", "价格、工期、硬件及换新费用另行确认。会员不包含无限硬件换新。", "本草案仅下载或复制到本机，未保存到真实 DevReady 资产库；由用户自行决定是否发送。", "", "https://www.datafluxdynamics.ltd/delivery/"].join("\n");
}
