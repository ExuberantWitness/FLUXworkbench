import { presets, plan, revision, documentText } from "./model.mjs?v=9627eb6e2ad455c4";

function init() {
  const root = document.querySelector("[data-delivery-demo]");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "true";
  const form = root.querySelector("form");
  form.querySelector("[data-inputs]").disabled = false;
  const status = root.querySelector("#delivery-status");
  const change = root.querySelector("#delivery-change");
  let current = null;
  let copySequence = 0;
  const say = text => { status.textContent = text; };
  const fillList = (selector, rows) => {
    const list = root.querySelector(selector);
    list.replaceChildren(...rows.map(text => { const li = document.createElement("li"); li.textContent = text; return li; }));
  };
  function show(step, focus = true) {
    if (step !== 0 && !current) {
      say("先填写需求并整理清单，再查看后续步骤。");
      form.elements.brief.focus();
      return;
    }
    root.querySelectorAll("[data-panel]").forEach(panel => { panel.hidden = Number(panel.dataset.panel) !== step; });
    root.querySelectorAll("[data-step]").forEach(button => {
      if (Number(button.dataset.step) === step) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
    if (focus) (root.querySelector(`[data-panel="${step}"] [data-focus]`) || form.elements.brief).focus({ preventScroll: true });
    say(["修改选项后，重新整理需求清单。", "确认用途与取舍，查看各环节分工。", "逐项确认交付内容与验收重点。", "选择一个变化，查看需要调整与验证的部分。"][step]);
  }
  function updateRevision() {
    if (!current) return;
    const result = revision(current.brief, change.value);
    root.querySelector("[data-change-label]").textContent = result.change;
    fillList("[data-reuse]", result.reuse);
    fillList("[data-redesign]", result.redesign);
    fillList("[data-retest]", result.retest);
  }
  function invalidate() {
    current = null;
    copySequence++;
    root.querySelectorAll("[data-preset]").forEach(button => button.setAttribute("aria-pressed", "false"));
    say("需求已更新，请重新整理清单。");
  }
  form.addEventListener("input", invalidate);
  form.addEventListener("change", invalidate);
  root.querySelectorAll("[data-preset]").forEach(button => button.addEventListener("click", () => {
    invalidate();
    for (const [key, value] of Object.entries(presets[button.dataset.preset])) form.elements[key].value = value;
    button.setAttribute("aria-pressed", "true");
    say("示例已填入，可以按你的需求调整。");
  }));
  form.addEventListener("submit", event => {
    event.preventDefault();
    try {
      current = plan(Object.fromEntries(new FormData(form)));
      root.querySelector("[data-brief]").textContent = current.brief.brief;
      root.querySelector("[data-scope]").textContent = current.scope;
      root.querySelector("[data-constraints]").textContent = current.constraints;
      fillList("[data-tests]", current.tests);
      updateRevision();
      show(1);
    } catch (error) { say(error.message); form.elements.brief.focus(); }
  });
  root.querySelectorAll("[data-step], [data-goto]").forEach(button => button.addEventListener("click", () => show(Number(button.dataset.step ?? button.dataset.goto))));
  change.addEventListener("change", () => { updateRevision(); say("改型对比已更新，请查看修改项与验证项。"); });
  root.querySelector("[data-download]").addEventListener("click", () => {
    if (!current) return;
    const blob = new Blob([documentText(current.brief, change.value)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "DataFlux-delivery-brief.md";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say("请在下载列表中查看需求清单。");
  });
  root.querySelector("[data-copy]").addEventListener("click", async () => {
    if (!current) return;
    const sequence = ++copySequence;
    const text = documentText(current.brief, change.value);
    try {
      await navigator.clipboard.writeText(text);
      if (sequence === copySequence) say("需求清单已复制。");
    } catch {
      if (sequence !== copySequence) return;
      say("复制未完成，请下载需求清单。");
    }
  });
  root.querySelector("[data-reset]").addEventListener("click", () => {
    current = null; copySequence++; form.reset(); change.selectedIndex = 0;
    root.querySelectorAll("[data-preset]").forEach(button => button.setAttribute("aria-pressed", "false"));
    root.querySelectorAll("[data-brief],[data-constraints],[data-scope],[data-tests],[data-reuse],[data-redesign],[data-retest],[data-change-label]").forEach(node => node.replaceChildren());
    show(0); say("已清空，可以开始新的需求。");
  });
  // No persistent storage, backend calls, timers simulating progress, or hidden analytics.
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
else init();
