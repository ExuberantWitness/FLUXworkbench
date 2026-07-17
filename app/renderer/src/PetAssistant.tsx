// PetAssistant — the bottom-right desk pet (clawd-on-desk style).
// Strictly READ-ONLY: it can look at everything (tools, assets, status,
// events) and answer questions with markdown; it can highlight controls
// (data-guide attributes) but can never change anything. Roles: tutorial
// guide (device bring-up), quick reference, encourager, feedback collector.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "./i18n";
import { DashboardPanel } from "./DashboardPanel";
import { GUIDES, guideById, classifierFlows, type Guide, type Advance } from "./guides";
import { mdLite } from "./mdlite";
import { PREFLIGHT_RULES, SUGGESTIONS, type PreflightCtx } from "./preflight";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }
interface PetMsg { role: "user" | "pet"; text: string }

// ── control highlighting: pulse any element carrying data-guide="<id>".
// persist=true keeps the pulse until clearGuide() (guided-flow steps);
// otherwise it self-clears after one pulse cycle (one-off hints). ──
export function highlightGuide(id: string, persist = false): boolean {
  const el = document.querySelector(`[data-guide="${id}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("guide-highlight");
  if (!persist) setTimeout(() => el.classList.remove("guide-highlight"), 3200);
  return true;
}

export function clearGuide(): void {
  document.querySelectorAll(".guide-highlight").forEach((el) => el.classList.remove("guide-highlight"));
}


const FACES = { idle: "🤖", happy: "🎉", think: "💭", sad: "🫂" } as const;

// Which center-tab a flow expects to be on at step i (last preceding tab step).
function tabOfStep(g: Guide, i: number): string | null {
  for (let k = i; k >= 0; k--) {
    const a = g.steps[k]?.advance;
    if (a?.kind === "tab") return a.tab;
    if (a?.kind === "subtab") return "assets";
  }
  return null;
}

export function PetAssistant({ events, centerTab, assetsSub, schedState }: {
  events: FluxEvent[];
  centerTab: string;
  assetsSub: string;
  schedState?: unknown;
}): React.ReactElement {
  const { t, lang } = useLang();
  const activeTab = centerTab; // used in the read-only Q&A context string
  const [open, setOpen] = useState(false);
  const [face, setFace] = useState<keyof typeof FACES>("idle");
  const [bubble, setBubble] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<PetMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [showDash, setShowDash] = useState(false);
  const [stats, setStats] = useState<{ tokens: number; cost: number; saved: number; assets: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── guided-flow engine (observational: highlight → user clicks → advance) ──
  const [flow, setFlow] = useState<Guide | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const flowRef = useRef<{ flow: Guide | null; idx: number }>({ flow: null, idx: 0 });
  flowRef.current = { flow, idx: stepIdx };
  const clickCleanup = useRef<(() => void) | null>(null);
  const flux = (window as unknown as {
    flux: {
      mcpCall(tool: string, args: Record<string, unknown>): Promise<string>;
      mcpTools(): Promise<Array<{ name: string; description: string; server: string }>>;
      listFluxAssets(): Promise<Array<{ id: string; type: string }>>;
    };
  }).flux;

  const say = (text: string, f: keyof typeof FACES = "idle", ms = 9000): void => {
    setFace(f);
    setBubble(text);
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current);
    bubbleTimer.current = setTimeout(() => { setBubble(null); setFace("idle"); }, ms);
  };

  // ── lab-partner instincts (preflight.ts, deterministic) ──────────────────
  // 1) Hover a consequential button → contextual tips BEFORE the click.
  //    Delegated via pointerover (enter events don't bubble); per-control
  //    debounce so the partner advises, never nags.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const lastTipAt = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const onOver = (ev: Event): void => {
      const target = (ev.target as Element)?.closest?.("[data-guide]");
      if (!target) return;
      const id = target.getAttribute("data-guide") ?? "";
      const rule = PREFLIGHT_RULES.find((r) => r.guide === id);
      if (!rule) return;
      const now = Date.now();
      if ((lastTipAt.current.get(id) ?? 0) > now - 45_000) return;
      const ctx: PreflightCtx = {
        events: eventsRef.current,
        attr: (name) => target.closest(`[${name}]`)?.getAttribute(name) ?? "",
      };
      let keys: string[] = [];
      try { keys = rule.check(ctx); } catch { /* a rule must never break the UI */ }
      if (!keys.length) return;
      lastTipAt.current.set(id, now);
      const lines = keys.map((k) => (k.startsWith("!") ? k.slice(1) : t(k)));
      say(lines.join("\n"), "think", 11000);
    };
    document.addEventListener("pointerover", onOver, true);
    return () => document.removeEventListener("pointerover", onOver, true);
  }, [lang]);

  // 2) Event-driven suggestions: state changed → "now you could…" (one-shot,
  //    silenced while a guided flow is running — the flow banner owns the UI).
  const suggested = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (flowRef.current.flow) return;
    for (const s of SUGGESTIONS) {
      if (suggested.current.has(s.id)) continue;
      let hit = false;
      try { hit = s.when(events); } catch { /* never break on a rule */ }
      if (!hit) continue;
      suggested.current.add(s.id);
      say(t(s.tipKey), "happy", 12000);
      if (s.highlight) setTimeout(() => highlightGuide(s.highlight!), 500);
      break;
    }
  }, [events.length]);

  // Is an advance condition ALREADY satisfied right now? (skip steps the user
  // is already past — e.g. already on the target tab).
  const advanceSatisfied = (a: Advance): boolean => {
    if (a.kind === "tab") return centerTab === a.tab;
    if (a.kind === "subtab") return centerTab === "assets" && assetsSub === a.sub;
    return false; // click / event are transitions, never "already satisfied"
  };

  const endFlow = (): void => {
    if (clickCleanup.current) { clickCleanup.current(); clickCleanup.current = null; }
    clearGuide();
    setFlow(null); setStepIdx(0);
  };

  // Highlight the step's control (after a beat so a just-switched tab has
  // mounted it) and, for click-advance steps, arm a one-shot click listener.
  const runStep = (g: Guide, i: number): void => {
    if (i >= g.steps.length) {
      clearGuide();
      say(t("guide.done"), "happy", 9000);
      if (g.next && guideById(g.next)) setTimeout(() => startFlow(g.next!, true), 1200);
      else setFlow(null);
      return;
    }
    const step = g.steps[i]!;
    // skip already-satisfied steps immediately
    if (advanceSatisfied(step.advance)) { setStepIdx(i + 1); runStep(g, i + 1); return; }
    if (clickCleanup.current) { clickCleanup.current(); clickCleanup.current = null; }
    clearGuide();
    setFlow(g); setStepIdx(i);
    // the flow banner (render below) shows the tip; let the DOM settle (a
    // just-clicked tab mounts the target), then highlight the control. Retry a
    // few times in case the target mounts a beat late after a tab switch.
    let tries = 0;
    const tryHighlight = (): void => {
      // bail if the flow moved on while we were waiting
      if (flowRef.current.flow?.id !== g.id || flowRef.current.idx !== i) return;
      const ok = highlightGuide(step.guide, true);
      if (!ok) {
        if (++tries < 8) setTimeout(tryHighlight, 200);
        return;
      }
      if (step.advance.kind === "click") {
        const el = document.querySelector(`[data-guide="${step.guide}"]`);
        if (el) {
          const onClick = (): void => { advance(); };
          el.addEventListener("click", onClick, { once: true });
          clickCleanup.current = () => el.removeEventListener("click", onClick);
        }
      }
    };
    setTimeout(tryHighlight, 200);
  };

  const advance = (): void => {
    const { flow: g, idx } = flowRef.current;
    if (!g) return;
    if (clickCleanup.current) { clickCleanup.current(); clickCleanup.current = null; }
    setStepIdx(idx + 1);
    runStep(g, idx + 1);
  };

  const startFlow = (id: string, chained = false): void => {
    const g = guideById(id);
    if (!g) return;
    setOpen(false);
    if (!chained) say(`${t("guide.startPrefix")}${t(g.titleKey)}`, "happy", 6000);
    setFlow(g); setStepIdx(0);
    runStep(g, 0);
  };

  // classify a user utterance (or a deviation signal) into a flow id
  const classify = async (utterance: string): Promise<string | null> => {
    try {
      const r = JSON.parse(await flux.mcpCall("guide_match", { utterance, flows: classifierFlows() }));
      return r.flow_id ?? null;
    } catch { return null; }
  };

  // advance watcher: tab / subtab transitions + deviation → re-confirm intent
  useEffect(() => {
    const g = flow; if (!g) return;
    const step = g.steps[stepIdx]; if (!step) return;
    const a = step.advance;
    if (a.kind === "tab" && centerTab === a.tab) { advance(); return; }
    if (a.kind === "subtab" && centerTab === "assets" && assetsSub === a.sub) { advance(); return; }
    // deviation: user switched to a tab that this step does not expect →
    // re-read intent (three-souls: follow the human, don't fight them).
    if ((a.kind === "click" || a.kind === "event") && step.guide.startsWith("tab-") === false) {
      const expectTab = tabOfStep(g, stepIdx);
      if (expectTab && centerTab !== expectTab && centerTab !== "wiki") {
        void classify(`用户切到了「${centerTab}」页`).then((fid) => {
          if (fid && fid !== g.id) {
            setPendingSwitch(fid);
            setOpen(true);
            setMsgs((m) => [...m, { role: "pet", text: `${t("guide.deviate")}《${t(guideById(fid)!.titleKey)}》？` }]);
          }
        });
      }
    }
  }, [centerTab, assetsSub]); // eslint-disable-line react-hooks/exhaustive-deps

  // advance watcher: bus events (+ mission fail → comfort & end)
  const lastEventKey = events.length ? `${events.length}-${events[events.length - 1]!.topic}` : "";
  useEffect(() => {
    const g = flow; if (!g) return;
    const step = g.steps[stepIdx]; if (!step || step.advance.kind !== "event") return;
    const a = step.advance;
    const e = events[events.length - 1];
    if (!e) return;
    // mission failed while we were waiting on it → comfort, point to Problems, end
    if (a.topic === "mission.milestone" && e.topic === "mission.milestone"
      && (e.data as { phase?: string }).phase === "mission"
      && (e.data as { status?: string }).status === "fail") {
      say(t("pet.comfort"), "sad", 12000);
      endFlow();
      return;
    }
    if (e.topic !== a.topic) return;
    const where = a.where ?? {};
    if (Object.entries(where).every(([k, v]) => (e.data as Record<string, unknown>)[k] === v)) advance();
  }, [lastEventKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── first-run greeting: the pet owns the bring-up tutorial now ──
  useEffect(() => {
    if (localStorage.getItem("flux.pet.greeted") === "1") return;
    localStorage.setItem("flux.pet.greeted", "1");
    setTimeout(() => {
      say(t("pet.greet"), "happy", 14000);
      highlightGuide("tab-assets");
    }, 2500);
  }, []);

  // ── dock overview line: 7d tokens · cost · routing savings · assets ──
  const assetCommits = events.filter((e) => e.topic === "asset.committed").length;
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const u = JSON.parse(await flux.mcpCall("usage_stats", { days: 7 })) as { total_in: number; total_out: number; cost_usd: number; saved_pct: number };
        const assets = await flux.listFluxAssets().catch(() => []);
        setStats({ tokens: u.total_in + u.total_out, cost: u.cost_usd, saved: u.saved_pct, assets: assets.length });
      } catch { /* metering not up yet */ }
    };
    void load();
  }, [assetCommits]);

  // ── encourager: react to mission verdicts + alarms ──
  const missionEnds = useMemo(() => events.filter((e) =>
    e.topic === "mission.milestone" && (e.data as { phase?: string }).phase === "mission"
    && ["done", "fail"].includes(String((e.data as { status?: string }).status))), [events]);
  const lastEnd = missionEnds[missionEnds.length - 1];
  const lastEndKey = lastEnd ? `${lastEnd.trace_id}-${(lastEnd.data as { status?: string }).status}` : "";
  const seenEnd = useRef("");
  useEffect(() => {
    if (!lastEnd || seenEnd.current === lastEndKey) return;
    seenEnd.current = lastEndKey;
    const ok = (lastEnd.data as { status?: string }).status === "done";
    if (ok) { say(t("pet.cheer"), "happy"); }
    else { say(t("pet.comfort"), "sad", 12000); }
  }, [lastEndKey]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [msgs.length, open]);

  // ── ask: classify intent → guided flow FIRST; else read-only Q&A ──
  const ask = async (q: string): Promise<void> => {
    if (!q.trim() || busy) return;
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setInput(""); setBusy(true); setFace("think");
    try {
      if (feedbackMode) {
        await flux.mcpCall("commit_asset", {
          asset_id: `feedback-${Date.now()}`, type: "feedback",
          source: { kind: "pet-feedback" }, components: ["user-feedback"],
          characterization: { text: q, tab: activeTab, lang },
        });
        setMsgs((m) => [...m, { role: "pet", text: t("pet.fbThanks") }]);
        setFeedbackMode(false);
        setFace("happy");
        return;
      }
      // intent first: does this map to a guided flow? if so, lead the user.
      const fid = await classify(q);
      if (fid && guideById(fid)) {
        setMsgs((m) => [...m, { role: "pet", text: `${t("guide.leadIn")}《${t(guideById(fid)!.titleKey)}》` }]);
        setFace("happy");
        startFlow(fid);
        return;
      }
      let ctx = "";
      try {
        const tools = await flux.mcpTools();
        const assets = await flux.listFluxAssets();
        ctx = `You are the friendly READ-ONLY helper pet inside Flux Studio (a hardware bring-up IDE). `
          + `Answer briefly in ${lang === "zh" ? "Chinese" : "English"} with markdown. NEVER claim you changed anything — you cannot write. `
          + `UI map: tabs = Bring-up(设备调通: plug device→auto verify), Overview(总览: metrics), Chat, FluxWeave(URDF assembly), UnitPort(RL training), HIL(硬件在环). `
          + `Right panel: pipeline viz, software modules, DevReady assets. Bottom drawer: problems + terminal.\n`
          + `Available tools (${tools.length}): ${tools.map((x) => x.name).join(", ")}\n`
          + `Recent assets: ${assets.slice(0, 12).map((a) => `${a.id}(${a.type})`).join(", ") || "(none yet)"}\n`
          + `Recent activity: ${[...new Set(events.slice(-15).map((e) => e.topic))].join(", ") || "(quiet)"}\n`
          + `Current tab: ${activeTab}\nUser question: `;
      } catch { ctx = "Answer briefly with markdown. Question: "; }
      const reply = await flux.mcpCall("chat", { message: ctx + q, use_assets: false });
      setMsgs((m) => [...m, { role: "pet", text: reply }]);
      setFace("idle");
    } catch (e) {
      setMsgs((m) => [...m, { role: "pet", text: `😵 ${(e as Error).message.slice(0, 120)}` }]);
      setFace("idle");
    } finally { setBusy(false); }
  };

  // quick actions: "带我操作" lists flows; overview / ask / feedback unchanged
  const quick = (kind: "tour" | "overview" | "ask" | "feedback"): void => {
    if (kind === "tour") {
      const list = GUIDES.map((g) => `- ${t(g.titleKey)}`).join("\n");
      setMsgs((m) => [...m, { role: "pet", text: `${t("guide.pick")}\n${list}` }]);
    } else if (kind === "overview") {
      setShowDash(true);
    } else if (kind === "feedback") {
      setFeedbackMode(true);
      setMsgs((m) => [...m, { role: "pet", text: t("pet.fbPrompt") }]);
    } else {
      setMsgs((m) => [...m, { role: "pet", text: t("pet.askMd") }]);
    }
  };

  // deviation re-confirm: user accepted switching to another flow
  const acceptSwitch = (): void => {
    if (!pendingSwitch) return;
    const id = pendingSwitch; setPendingSwitch(null);
    endFlow();
    startFlow(id);
  };

  return (
    <>
      {/* bubble tip — anchored above the dock, full right-column width */}
      {bubble && !open && !flow && (
        <div className="pet-bubble" onClick={() => { setOpen(true); setBubble(null); }}>
          <div dangerouslySetInnerHTML={{ __html: mdLite(bubble) }} />
        </div>
      )}
      {/* active guided-flow banner: current step tip + progress + skip */}
      {flow && flow.steps[stepIdx] && (
        <div className="pet-guide-banner">
          <span className="pet-guide-step">{stepIdx + 1}/{flow.steps.length}</span>
          <span style={{ flex: 1 }}>👉 {t(flow.steps[stepIdx]!.tipKey)}</span>
          <button className="ft-btn" onClick={endFlow}>{t("guide.skip")}</button>
        </div>
      )}
      {/* chat window — docked, same width as the right column */}
      {open && (
        <div className="pet-window">
          <div className="pet-head">
            <span>{FACES[face]} {t("pet.title")}</span>
            <span style={{ marginLeft: "auto", fontSize: 9, color: "var(--grey-3)" }}>{t("pet.readonly")}</span>
            <button className="ft-btn" onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="pet-quick">
            <button className="ft-btn" onClick={() => quick("tour")}>{t("pet.qTour")}</button>
            <button className="ft-btn" onClick={() => quick("overview")}>{t("pet.qOverview")}</button>
            <button className="ft-btn" onClick={() => quick("ask")}>{t("pet.qAsk")}</button>
            <button className="ft-btn" onClick={() => quick("feedback")}>{t("pet.qFb")}</button>
          </div>
          <div className="pet-log" ref={logRef}>
            {msgs.length === 0 && <div style={{ color: "var(--grey-3)", fontSize: 11 }}>{t("pet.hint")}</div>}
            {msgs.map((m, i) => (
              <div key={i} className={`pet-msg ${m.role}`}>
                <div dangerouslySetInnerHTML={{ __html: mdLite(m.text) }} />
              </div>
            ))}
            {busy && <div className="pet-msg pet">💭 …</div>}
            {pendingSwitch && (
              <div className="pet-msg pet" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button className="chat-send" style={{ padding: "3px 10px", fontSize: 10 }} onClick={acceptSwitch}>{t("guide.switch")}</button>
                <button className="ft-btn" onClick={() => setPendingSwitch(null)}>{t("guide.keep")}</button>
              </div>
            )}
          </div>
          <div className="pet-in">
            <textarea className="flux-textarea" rows={1}
              style={{ flex: 1, fontSize: 11, maxHeight: 96, minHeight: 30, lineHeight: 1.4 }}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(96, e.target.scrollHeight)}px`;
              }}
              placeholder={feedbackMode ? t("pet.fbPh") : t("pet.ph")}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter inserts a newline; paste works natively.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(input);
                  (e.target as HTMLTextAreaElement).style.height = "auto";
                }
              }} />
            <button className="chat-send" style={{ padding: "6px 12px" }} disabled={busy}
              onClick={() => void ask(input)}>➤</button>
          </div>
        </div>
      )}
      {/* merged overview (was the center 总览 tab) — opens from the dock */}
      {showDash && (
        <div className="asset-modal" onClick={() => setShowDash(false)}>
          <div className="asset-card" style={{ width: 900, maxWidth: "92vw" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", padding: "8px 14px" }}>
              <b style={{ fontSize: 13 }}>📈 {t("pet.qOverview")}</b>
              <button className="ft-btn" style={{ marginLeft: "auto" }} onClick={() => setShowDash(false)}>✕</button>
            </div>
            <div style={{ height: "68vh", overflow: "auto" }}>
              <DashboardPanel events={events as never} schedState={schedState as never} />
            </div>
          </div>
        </div>
      )}
      {/* the dock itself: full right-column width, sits above the footer */}
      <div className="pet-dock">
        <span className="pet-face" style={{ cursor: "pointer" }} title={t("pet.title")}
          onClick={() => { setOpen(!open); setBubble(null); }}>{FACES[face]}</span>
        <div className="pet-stats" onClick={() => setShowDash(true)} title={t("pet.statsTip")}>
          {stats ? (
            <>
              <span>{t("dash.tokens")}: <b>{stats.tokens}</b> · ${stats.cost}</span>
              <span style={{ color: "#2e7d32" }}> · {t("dash.saved")} {stats.saved}%</span>
              <span> · {t("foot.assets")} {stats.assets}</span>
            </>
          ) : <span style={{ color: "var(--grey-3)" }}>…</span>}
        </div>
        <button className="ft-btn" onClick={() => { setOpen(!open); setBubble(null); }}>{open ? "▾" : "▴"}</button>
      </div>
    </>
  );
}
