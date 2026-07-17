// 现场快照 viewer — open a flux.scene/v1 JSON captured on ANY user's machine
// (Windows/macOS/Linux) and reconstruct the scene here: what system it was,
// what the user said (pet + chat transcripts), and every bus/tool event in the
// window, on a scrollable timeline with expandable payloads. Pure JSON in,
// no OS-specific anything — a field report becomes a debuggable artifact.
import React, { useMemo, useState } from "react";
import { useLang } from "./i18n";

interface SceneEvent { ts: number; topic: string; kind?: string; source?: string; data?: unknown; trace_id?: string }
export interface Scene {
  schema: string; created: string; note?: string;
  app?: { version?: string; packaged?: boolean };
  system?: { platform?: string; arch?: string; os_release?: string; locale?: string };
  llm?: { provider?: string; model?: string };
  pet_chat?: Array<{ role?: string; text?: string }>;
  chat?: Array<{ role?: string; text?: string }>;
  window_minutes?: number;
  events?: SceneEvent[];
  error?: string;
}

const TOPIC_COLOR: Record<string, string> = {
  "alarm": "#ff4444", "device": "#ff8800", "hil": "#c77dff", "mcp": "#5B7BFF",
  "mission": "#0aa", "build": "#002FA7", "asset": "#00aa44", "agent": "#5B7BFF",
};
const colorOf = (topic: string): string => TOPIC_COLOR[topic.split(".")[0] ?? ""] ?? "var(--grey-3)";

export function SceneViewer({ scene, onClose }: { scene: Scene; onClose: () => void }): React.ReactElement {
  const { lang } = useLang();
  const zh = lang === "zh";
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [topicFilter, setTopicFilter] = useState<string>("");

  const events = scene.events ?? [];
  const t0 = events[0]?.ts ?? 0;
  const topics = useMemo(() => [...new Set(events.map((e) => e.topic.split(".")[0] ?? ""))].sort(), [events]);
  const shown = topicFilter ? events.filter((e) => e.topic.startsWith(topicFilter)) : events;
  const say = (m: { role?: string; text?: string }, i: number): React.ReactElement => (
    <div key={i} style={{ marginBottom: 6, fontSize: 12 }}>
      <b style={{ color: m.role === "user" ? "var(--accent)" : "var(--grey-3)" }}>{m.role === "user" ? (zh ? "用户" : "user") : "🤖"}</b>
      <span style={{ marginLeft: 6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{String(m.text ?? "")}</span>
    </div>
  );

  if (scene.error) {
    return (
      <div className="asset-modal" onClick={onClose}>
        <div className="asset-card" style={{ width: 420, padding: 20 }} onClick={(e) => e.stopPropagation()}>
          <b>⚠ {zh ? "无法读取现场文件" : "Could not read scene file"}</b>
          <div style={{ fontSize: 12, color: "var(--grey-3)", marginTop: 8 }}>{scene.error}</div>
          <button className="chat-send" style={{ marginTop: 14 }} onClick={onClose}>OK</button>
        </div>
      </div>
    );
  }

  return (
    <div className="asset-modal" onClick={onClose}>
      <div className="asset-card" style={{ width: 980, maxWidth: "94vw", maxHeight: "88vh", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        {/* header: the machine this came from */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <b style={{ fontSize: 13 }}>📸 {zh ? "现场快照" : "Scene snapshot"}</b>
          <span style={{ fontSize: 11, fontFamily: "var(--mono, monospace)", color: "var(--grey-3)" }}>
            {scene.system?.platform}/{scene.system?.arch} · os {scene.system?.os_release} · app v{scene.app?.version}{scene.app?.packaged ? "" : " (dev)"} · {scene.llm?.provider || "no-llm"}{scene.llm?.model ? `/${scene.llm.model}` : ""}
          </span>
          <span style={{ fontSize: 11, color: "var(--grey-3)" }}>{scene.created} · {scene.window_minutes}min · {events.length} events</span>
          <button className="ft-btn" style={{ marginLeft: "auto" }} onClick={onClose}>✕</button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* left: what the user said */}
          <div style={{ width: 320, flexShrink: 0, borderRight: "1px solid var(--border)", padding: 12, overflow: "auto" }}>
            {scene.note && <div style={{ fontSize: 12, padding: 8, background: "rgba(255,200,0,.08)", borderRadius: 4, marginBottom: 10 }}>📝 {scene.note}</div>}
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--grey-3)", marginBottom: 6 }}>{zh ? "小Flux 对话" : "Pet chat"}</div>
            {(scene.pet_chat ?? []).length ? (scene.pet_chat ?? []).map(say) : <div style={{ fontSize: 11, color: "var(--grey-2)" }}>—</div>}
            {(scene.chat ?? []).length > 0 && (<>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--grey-3)", margin: "10px 0 6px" }}>{zh ? "主对话" : "Main chat"}</div>
              {(scene.chat ?? []).map(say)}
            </>)}
          </div>

          {/* right: the event timeline */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
              <button className="ft-btn" style={{ fontWeight: topicFilter === "" ? 700 : 400 }} onClick={() => setTopicFilter("")}>{zh ? "全部" : "all"} ({events.length})</button>
              {topics.map((tp) => (
                <button key={tp} className="ft-btn" style={{ color: colorOf(tp), fontWeight: topicFilter === tp ? 700 : 400 }}
                  onClick={() => setTopicFilter(topicFilter === tp ? "" : tp)}>{tp}</button>
              ))}
            </div>
            <div style={{ flex: 1, overflow: "auto", padding: "6px 12px", fontFamily: "var(--mono, monospace)", fontSize: 11 }}>
              {shown.map((e, i) => (
                <div key={i} style={{ borderBottom: "1px solid var(--border)", padding: "3px 0" }}>
                  <div style={{ display: "flex", gap: 8, cursor: "pointer", alignItems: "baseline" }} onClick={() => setOpenIdx(openIdx === i ? null : i)}>
                    <span style={{ color: "var(--grey-3)", minWidth: 62, textAlign: "right" }}>+{((e.ts - t0) / 1000).toFixed(1)}s</span>
                    <span style={{ color: colorOf(e.topic), fontWeight: 600 }}>{e.topic}</span>
                    <span style={{ color: "var(--grey-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {JSON.stringify(e.data ?? {}).slice(0, 120)}
                    </span>
                  </div>
                  {openIdx === i && (
                    <pre style={{ margin: "4px 0 6px 70px", padding: 8, background: "var(--grey-1, rgba(0,0,0,.04))", borderRadius: 4, overflow: "auto", maxHeight: 240, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {JSON.stringify(e, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
              {shown.length === 0 && <div style={{ color: "var(--grey-2)", padding: 20 }}>—</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
