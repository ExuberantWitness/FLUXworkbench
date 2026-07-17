// Flux Studio — VScode-like Explorer + drag resize + cc-switch providers + clawhub
import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { HilPanel } from "./HilPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { UnitPortPanel } from "./UnitPortPanel";
import { AssetsPanel } from "./AssetsPanel";
import { DashboardPanel } from "./DashboardPanel";
import { SchedulerViz, type SchedulerState } from "./SchedulerViz";
import { SceneViewer, type Scene } from "./SceneViewer";
import { TerminalPanel } from "./TerminalPanel";
import { CodeView } from "./CodeView";
import { PipelineViz } from "./PipelineViz";
import { PetAssistant } from "./PetAssistant";
import { AssetDetail } from "./AssetDetail";
import { useLang } from "./i18n";

interface FluxEvent { source: string; kind: string; topic: string; data: Record<string, unknown>; trace_id: string }
interface ChatMsg { role: "user" | "agent"; text: string; codeBlock?: string }
interface DirEntry { name: string; isDir: boolean; ext: string }
interface CondaEnv { name: string; path: string }
interface TreeNode { name: string; path: string; isDir: boolean; ext: string; children?: TreeNode[]; loaded?: boolean; expanded?: boolean }

declare global { interface Window { flux: any } } // eslint-disable-line @typescript-eslint/no-explicit-any

type LeftTab = "session" | "memory" | "explorer";
const DEFAULT_PROJECT = "/home/exuber/hpm_sdk/samples/hello_world";

// ── cc-switch style provider presets ──
// Cloud APIs first (recommended — works on a fresh install with just a key).
// vLLM stays as the self-hosted / offline option (run your own server).
const PROVIDER_PRESETS: Record<string, { endpoint: string; model: string; label: string }> = {
  deepseek: { endpoint: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", label: "DeepSeek（推荐 · 便宜）" },
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4o", label: "OpenAI" },
  anthropic: { endpoint: "https://api.anthropic.com", model: "claude-sonnet-5-20250929", label: "Anthropic Claude" },
  mimo: { endpoint: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5", label: "Xiaomi MiMo" },
  vllm: { endpoint: "http://127.0.0.1:8000", model: "openbmb/MiniCPM-V-4.6", label: "本地 vLLM（自建 · MiniCPM-V-4.6）" },
  custom: { endpoint: "", model: "", label: "Custom" },
};

export function App() {
  const { t } = useLang();
  const [events, setEvents] = useState<FluxEvent[]>([]);
  const [schedState, setSchedState] = useState<SchedulerState | null>(null);
  const [scene, setScene] = useState<Scene | null>(null); // imported 现场快照
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [leftTab, setLeftTab] = useState<LeftTab>("explorer");
  const [projectPath, setProjectPath] = useState(DEFAULT_PROJECT);
  const [treeRoot, setTreeRoot] = useState<TreeNode[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [activeFilePath, setActiveFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [condaEnvs, setCondaEnvs] = useState<CondaEnv[]>([]);
  const [condaActive, setCondaActive] = useState("base");
  const [condaDropdown, setCondaDropdown] = useState(false);
  const [customOpen, setCustomOpen] = useState<string | null>("api");
  // Cloud-first default so a fresh install just needs an API key; remembers the
  // last provider/key across launches (machine-local, mirrored to ~/.flux/llm.json).
  const [apiConfig, setApiConfig] = useState<{ provider: string; endpoint: string; apiKey: string; model: string }>(() => {
    try {
      const s = JSON.parse(localStorage.getItem("flux.apiConfig") ?? "null");
      if (s?.provider) return s;
    } catch { /* first run */ }
    return { provider: "deepseek", endpoint: PROVIDER_PRESETS.deepseek!.endpoint, apiKey: "", model: PROVIDER_PRESETS.deepseek!.model };
  });
  const apiConfigRef = useRef(apiConfig); apiConfigRef.current = apiConfig;
  useEffect(() => { try { localStorage.setItem("flux.apiConfig", JSON.stringify(apiConfig)); } catch { /* quota */ } }, [apiConfig]);
  const [fluxAssets, setFluxAssets] = useState<{id:string;ts:number;type:string;components:string[]}[]>([]);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState("");
  // ── center tabs: 对话 / 资产 / 仿真 / 真实 ──
  const [centerTab, setCenterTab] = useState<"chat" | "assets" | "sim" | "real" | "wiki">("assets");
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<"problems" | "terminal">("problems");
  // assets sub-tab lifted here so the guide engine can observe it (advance signal)
  const [assetsSub, setAssetsSub] = useState<"bringup" | "assembly" | "pcb">("bringup");
  // ── chat sessions (issue: + New Session did nothing) ──
  const [sessions, setSessions] = useState<Array<{ id: string; name: string; msgs: ChatMsg[] }>>(
    [{ id: "current", name: "Session 1", msgs: [] }]);
  const [activeSession, setActiveSession] = useState("current");
  const [wikiContent, setWikiContent] = useState("");
  // ── context menu state ──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TreeNode | null; isRoot: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ node: TreeNode; newName: string } | null>(null);
  const [creating, setCreating] = useState<{ parentPath: string; name: string; isDir: boolean } | null>(null);
  // ── drag resize ──
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(300);

  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) => {
      // scheduler.state is a high-frequency live snapshot — keep it OUT of the
      // 200-entry ring (it would flush everything else) and hold only the latest.
      if (e.topic === "scheduler.state") { setSchedState(e.data as unknown as SchedulerState); return; }
      // Re-apply the saved API key to the freshly-booted brain (covers a brain
      // that has no ~/.flux/llm.json yet — e.g. first run after the user set it).
      if (e.topic === "brain.ready" && apiConfigRef.current.apiKey) window.flux?.sendSetApi?.(apiConfigRef.current);
      setEvents((p) => [...p.slice(-200), e]);
      if (e.topic === "agent.event" && e.data?.["step"] === "chat") {
        const reply = String(e.data?.["reply"] ?? "(no reply)");
        const m = reply.match(/```(\w+)?\n([\s\S]*?)```/);
        setChatMsgs((p) => [...p.slice(-100), { role: "agent", text: reply, codeBlock: m?.[2] }]);
      }
    });
    return () => off?.();
  }, []);

  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    try {
      const entries: DirEntry[] = await window.flux?.readDir?.(dirPath);
      return entries.map((e) => ({ name: e.name, path: `${dirPath}/${e.name}`, isDir: e.isDir, ext: e.ext, children: e.isDir ? [] : undefined, loaded: !e.isDir, expanded: false }));
    } catch { return []; }
  }, []);

  useEffect(() => { void loadDir(projectPath).then(setTreeRoot); }, [projectPath, loadDir]);
  useEffect(() => { void window.flux?.condaList?.().then((e: CondaEnv[]) => { setCondaEnvs(e); }).catch(() => void 0); }, []);
  // Asset panel reads through query_asset so it follows the active workspace
  // (the old flux:listAssets exec path always hit the global store).
  useEffect(() => {
    void window.flux?.mcpCall?.("query_asset", {})
      .then((text: string) => { const a = JSON.parse(text); if (Array.isArray(a)) setFluxAssets(a); })
      .catch(() => { void window.flux?.listFluxAssets?.().then((a: typeof fluxAssets) => setFluxAssets(a)).catch(() => void 0); });
  }, [events.filter(e=>e.topic==="asset.committed").length]);

  // WorkSpace isolation: opening a project points the asset store at
  // <project>/.flux; the default sample stays on the global store.
  const [wsLabel, setWsLabel] = useState("global");
  // OS detection: shown in the footer; Linux-only features gate on caps.
  const [osInfo, setOsInfo] = useState<{ platform: string; distro: string; arch: string; session: string } | null>(null);
  useEffect(() => { void window.flux?.osInfo?.().then(setOsInfo).catch(() => void 0); }, []);
  useEffect(() => {
    const target = projectPath === DEFAULT_PROJECT ? "" : projectPath;
    void window.flux?.mcpCall?.("set_workspace", { path: target })
      .then((text: string) => {
        try { setWsLabel(JSON.parse(text).workspace === "global" ? "global" : (projectPath.split("/").pop() ?? "ws")); }
        catch { setWsLabel("global"); }
      })
      .catch(() => void 0);
  }, [projectPath]);

  // ── Workspaces (left rail, first-class): add / rename / delete ──
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; path: string }>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("flux.workspaces") ?? "") as Array<{ id: string; name: string; path: string }>;
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* first run */ }
    return [{ id: "global", name: "Global", path: DEFAULT_PROJECT }];
  });
  const [activeWs, setActiveWs] = useState("global");
  const [renamingWs, setRenamingWs] = useState<string | null>(null);
  useEffect(() => { localStorage.setItem("flux.workspaces", JSON.stringify(workspaces)); }, [workspaces]);
  const addWorkspace = async (): Promise<void> => {
    const p = await window.flux?.openFolder?.();
    if (!p) return;
    const id = `ws-${Date.now()}`;
    setWorkspaces((w) => [...w, { id, name: p.split("/").pop() ?? p, path: p }]);
    setActiveWs(id); setProjectPath(p);
  };
  const selectWorkspace = (id: string): void => {
    const ws = workspaces.find((x) => x.id === id) as { id: string; name: string; path: string; conda?: string } | undefined;
    if (!ws) return;
    setActiveWs(id); setProjectPath(ws.path);
    if (ws.conda) setCondaActive(ws.conda);
  };
  // Conda env is chosen per-workspace from the left rail; the selection is
  // real: the bottom terminal runs commands with that env's bin on PATH.
  const condaBin = useMemo(() => {
    const env = condaEnvs.find((e) => e.name === condaActive);
    return env?.path ? `${env.path}/bin` : undefined;
  }, [condaEnvs, condaActive]);
  const chooseConda = (name: string): void => {
    setCondaActive(name);
    setWorkspaces((w) => w.map((x) => x.id === activeWs ? { ...x, conda: name } : x));
  };
  const renameWorkspace = (id: string, name: string): void => {
    setWorkspaces((w) => w.map((x) => x.id === id ? { ...x, name: name.trim() || x.name } : x));
    setRenamingWs(null);
  };
  const deleteWorkspace = (id: string): void => {
    setWorkspaces((w) => w.filter((x) => x.id !== id));
    if (activeWs === id) { setActiveWs("global"); setProjectPath(DEFAULT_PROJECT); }
  };

  // MCP server inventory (left mcp section + right software-modules list).
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; count: number }>>([]);
  useEffect(() => {
    void window.flux?.mcpTools?.().then((tools: Array<{ server: string }>) => {
      const m = new Map<string, number>();
      for (const tl of tools) m.set(tl.server, (m.get(tl.server) ?? 0) + 1);
      setMcpServers([...m.entries()].map(([name, count]) => ({ name, count })));
    }).catch(() => void 0);
  }, []);

  // Studio-native skills (repo skills/*.md) for the left rail.
  const [studioSkills, setStudioSkills] = useState<Array<{ name: string; title: string }>>([]);
  useEffect(() => {
    void window.flux?.mcpCall?.("list_skills", {})
      .then((text: string) => { try { setStudioSkills(JSON.parse(text).skills ?? []); } catch { /* */ } })
      .catch(() => void 0);
  }, []);

  // Asset detail modal (per-asset actions: pins / build / usd / props).
  const [detailAsset, setDetailAsset] = useState<{ id: string; type: string; components?: string[] } | null>(null);
  const triageCount = events.filter((e) => e.topic === "triage.result").length;
  useEffect(() => { if (triageCount > 0) setProblemsOpen(true); }, [triageCount]);

  // ── wiki (from Help menu via preload) ──
  useEffect(() => {
    const off = window.flux?.onOpenWiki?.((path: string) => {
      void window.flux?.readFile?.(path).then((c: string) => { setWikiContent(c); setCenterTab("wiki"); });
    });
    return () => off?.();
  }, []);

  // ── Terminal menu (Ctrl+`) opens the bottom drawer on its terminal tab ──
  useEffect(() => {
    const off = window.flux?.onOpenTerminal?.(() => { setProblemsOpen(true); setBottomTab("terminal"); });
    return () => off?.();
  }, []);

  // ── session ops: each session is a stable slot; chatMsgs is the live buffer
  // of whichever slot is active. Switching saves the buffer back first.
  const newSession = () => {
    const id = `s-${Date.now()}`;
    setSessions((s) => [
      ...s.map((x) => x.id === activeSession ? { ...x, msgs: chatMsgs } : x),
      { id, name: `Session ${s.length + 1}`, msgs: [] },
    ]);
    setChatMsgs([]);
    setActiveSession(id);
  };
  const openSession = (id: string) => {
    if (id === activeSession) return;
    const target = sessions.find((x) => x.id === id);
    if (!target) return;
    setSessions((s) => s.map((x) => x.id === activeSession ? { ...x, msgs: chatMsgs } : x));
    setChatMsgs(target.msgs);
    setActiveSession(id);
  };

  const state = useMemo(() => deriveState(events), [events]);

  // ── tree operations ──
  const refreshTree = useCallback(async () => { setTreeRoot(await loadDir(projectPath)); }, [projectPath, loadDir]);
  const toggleFolder = async (node: TreeNode) => {
    if (!node.isDir) return;
    if (!node.loaded) { node.children = await loadDir(node.path); node.loaded = true; }
    node.expanded = !node.expanded; setTreeRoot([...treeRoot]);
  };
  const openFile = async (node: TreeNode) => {
    if (node.isDir) return;
    setActiveFile(node.name); setActiveFilePath(node.path);
    try { setFileContent(await window.flux?.readFile?.(node.path)); } catch { setFileContent("(cannot read)"); }
  };
  const openFileByPath = (p: string): void => {
    void openFile({ name: p.split("/").pop() ?? p, path: p, isDir: false } as TreeNode);
  };
  const saveFile = async (content: string) => { if (activeFilePath) await window.flux?.writeFile?.(activeFilePath, content); };

  // ── context menu actions ──
  const onContextMenu = (e: React.MouseEvent, node: TreeNode | null) => {
    e.preventDefault(); e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, node, isRoot: !node });
  };
  const closeCtx = () => setCtxMenu(null);

  const doCreate = async (isDir: boolean) => {
    if (!creating) return;
    const fullPath = `${creating.parentPath}/${creating.name}`;
    try {
      if (isDir) await window.flux?.createDir?.(fullPath);
      else await window.flux?.createFile?.(fullPath);
      setCreating(null); await refreshTree();
    } catch (e) { console.error(e); setCreating(null); }
  };
  const doRename = async () => {
    if (!renaming) return;
    const dir = renaming.node.path.substring(0, renaming.node.path.lastIndexOf("/"));
    await window.flux?.renameFile?.(renaming.node.path, `${dir}/${renaming.newName}`);
    setRenaming(null); await refreshTree();
  };
  const doDelete = async (node: TreeNode) => {
    await window.flux?.deleteFile?.(node.path); await refreshTree(); closeCtx();
  };
  const copyPath = (node: TreeNode) => {
    navigator.clipboard?.writeText(node.path); closeCtx();
  };
  const copyRelPath = (node: TreeNode) => {
    navigator.clipboard?.writeText(node.path.replace(projectPath + "/", "")); closeCtx();
  };
  const addToChat = (node: TreeNode) => {
    setChatMsgs((p) => [...p, { role: "user", text: `[add file: ${node.name}]` }]);
    void openFile(node); closeCtx();
  };

  // ── chat ──
  const sendChat = () => {
    const text = chatInput.trim(); if (!text) return;
    setChatMsgs((p) => [...p, { role: "user", text }]); setChatInput("");
    void window.flux?.sendChat?.(text);
  };
  // ── provider switch ──
  const switchProvider = (provider: string) => {
    const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS.custom!;
    const newConfig = { provider, endpoint: preset!.endpoint, model: preset!.model, apiKey: apiConfig.apiKey };
    setApiConfig(newConfig);
    // mimo is the multimodal model — switching it targets the vision channel
    void window.flux?.sendSetApi?.(provider === "mimo" ? { ...newConfig, target: "vision" } : newConfig);
  };
  // ── build ──
  const doBuild = async () => {
    setBuilding(true); setBuildResult("Building…");
    try { const res = await window.flux?.build?.(projectPath); setBuildResult(res?.ok ? `✅ ${res.elf}` : `❌ ${res?.error?.slice(0,200)}`); }
    catch (e) { setBuildResult(`❌ ${e}`); } setBuilding(false);
  };
  // ── drag resize ──
  const startDrag = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startL = leftWidth; const startR = rightWidth;
    const onMove = (ev: MouseEvent) => {
      if (side === "left") setLeftWidth(Math.max(150, Math.min(500, startL + ev.clientX - startX)));
      else setRightWidth(Math.max(150, Math.min(500, startR - (ev.clientX - startX))));
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
  };
  useEffect(() => { const h = () => closeCtx(); window.addEventListener("click", h); return () => window.removeEventListener("click", h); }, []);
  // auto code insert
  useEffect(() => {
    const last = chatMsgs[chatMsgs.length - 1];
    if (last?.role === "agent" && last.codeBlock) { setFileContent(last.codeBlock); setActiveFile("agent_generated.py"); setActiveFilePath(""); }
  }, [chatMsgs]);

  // ── alarm banner: latest alarm.critical not yet followed by alarm.cleared ──
  const alarmActive = useMemo(() => {
    let active: FluxEvent | null = null;
    for (const e of events) {
      if (e.topic === "alarm.critical") active = e;
      else if (e.topic === "alarm.cleared") active = null;
    }
    return active;
  }, [events]);

  return (
    <div className="shell" style={{ ["--lw" as string]: `${leftWidth}px`, ["--rw" as string]: `${rightWidth}px` }}>
      {alarmActive && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
          background: "#b71c1c", color: "#fff", padding: "6px 16px",
          display: "flex", alignItems: "center", gap: 12, fontSize: 12, fontWeight: 600,
        }}>
          <span>{t("alarm.banner")}</span>
          <span style={{ fontWeight: 400, opacity: 0.85, fontFamily: "var(--mono, monospace)", fontSize: 11 }}>
            {String((alarmActive.data as { message?: string })?.message ?? "")}
          </span>
          <button className="chat-send" style={{ marginLeft: "auto", background: "#fff", color: "#b71c1c" }}
            onClick={() => void window.flux?.alarmClear?.()}>{t("alarm.resume")}</button>
        </div>
      )}
      <LeftSidebar tab={leftTab} setTab={setLeftTab} events={events} state={state}
        treeRoot={treeRoot} toggleFolder={toggleFolder} activeFile={activeFile} openFile={openFile}
        customOpen={customOpen} setCustomOpen={setCustomOpen} projectPath={projectPath} setProjectPath={setProjectPath}
        onContextMenu={onContextMenu} renaming={renaming} setRenaming={setRenaming} doRename={doRename}
        creating={creating} setCreating={setCreating} doCreate={doCreate} refreshTree={refreshTree}
        apiConfig={apiConfig} setApiConfig={setApiConfig} switchProvider={switchProvider}
        sessions={sessions} activeSession={activeSession} newSession={newSession} openSession={openSession}
        workspaces={workspaces} activeWs={activeWs} renamingWs={renamingWs} setRenamingWs={setRenamingWs}
        addWorkspace={addWorkspace} selectWorkspace={selectWorkspace} renameWorkspace={renameWorkspace}
        deleteWorkspace={deleteWorkspace} mcpServers={mcpServers} condaEnvs={condaEnvs} condaActive={condaActive} chooseConda={chooseConda} studioSkills={studioSkills}
        openSkill={(md: string) => { setWikiContent(md); setCenterTab("wiki"); }} />
      <div className="resize-bar resize-l" onMouseDown={startDrag("left")} />
      <main className="chat-area">
        <div className="center-tabs">
          <div data-guide="tab-chat" className={`center-tab ${centerTab === "chat" ? "on" : ""}`} onClick={() => setCenterTab("chat")}>{t("tab.chat")}</div>
          <div data-guide="tab-assets" className={`center-tab ${centerTab === "assets" ? "on" : ""}`} onClick={() => setCenterTab("assets")}>{t("tab.assets")}</div>
          <div data-guide="tab-sim" className={`center-tab ${centerTab === "sim" ? "on" : ""}`} onClick={() => setCenterTab("sim")}>{t("tab.sim")}</div>
          <div data-guide="tab-real" className={`center-tab ${centerTab === "real" ? "on" : ""}`} onClick={() => setCenterTab("real")}>{t("tab.real")}</div>
          {wikiContent && <div className={`center-tab ${centerTab === "wiki" ? "on" : ""}`} onClick={() => setCenterTab("wiki")}>{t("tab.plan")}</div>}
        </div>
        {centerTab === "chat" && (
          <ChatArea msgs={chatMsgs} input={chatInput} setInput={setChatInput} sendChat={sendChat}
            fileContent={fileContent} activeFile={activeFile} saveFile={saveFile} state={state} />
        )}
        {centerTab === "assets" && <AssetsPanel events={events} sub={assetsSub} setSub={setAssetsSub} />}
        {centerTab === "sim" && <UnitPortPanel events={events} />}
        {centerTab === "real" && <HilPanel events={events} />}
        {centerTab === "wiki" && wikiContent && (
          <div className="wiki-view" dangerouslySetInnerHTML={{ __html: mdToHtml(wikiContent) }} />
        )}
        <div className="drawer-tabs">
          <span style={{ padding: "4px 8px", cursor: "pointer" }} onClick={() => setProblemsOpen(!problemsOpen)}>
            {problemsOpen ? "▾" : "▴"}
          </span>
          <span className={`drawer-tab ${problemsOpen && bottomTab === "problems" ? "on" : ""}`}
            onClick={() => { setBottomTab("problems"); setProblemsOpen(bottomTab === "problems" ? !problemsOpen : true); }}>
            {t("prob.title")} · {events.filter((e) => e.topic === "build.diagnostic").length + events.filter((e) => e.topic === "triage.result").length}
          </span>
          <span className={`drawer-tab ${problemsOpen && bottomTab === "terminal" ? "on" : ""}`}
            onClick={() => { setBottomTab("terminal"); setProblemsOpen(bottomTab === "terminal" ? !problemsOpen : true); }}>
            {t("term.title")}
          </span>
        </div>
        {problemsOpen && (
          <div style={{ height: 220, flexShrink: 0 }}>
            {bottomTab === "problems"
              ? <ProblemsPanel events={events} openFile={openFileByPath} />
              : <TerminalPanel events={events} cwd={projectPath} condaBin={condaBin} />}
          </div>
        )}
      </main>
      <RightPanel events={events} state={state} fluxAssets={fluxAssets}
        rawEvents={events} wsLabel={wsLabel} mcpServers={mcpServers} onOpenAsset={setDetailAsset} schedState={schedState} />
      <Footer state={state} osInfo={osInfo} condaEnvs={condaEnvs} condaActive={condaActive} setCondaActive={setCondaActive} condaDropdown={condaDropdown} setCondaDropdown={setCondaDropdown}
        onSceneDump={() => {
          const petLog = ((): unknown[] => { try { return JSON.parse(localStorage.getItem("flux.petLog") ?? "[]"); } catch { return []; } })();
          void window.flux?.sceneDump?.({ minutes: 10, petLog, chat: chatMsgs.slice(-30), provider: apiConfig.provider, model: apiConfig.model });
        }}
        onSceneLoad={() => { void window.flux?.sceneLoad?.().then((s: Scene | null) => { if (s) setScene(s); }); }} />
      {scene && <SceneViewer scene={scene} onClose={() => setScene(null)} />}
      {detailAsset && <AssetDetail asset={detailAsset} projectPath={projectPath} onClose={() => setDetailAsset(null)}
        onDeleted={() => { void window.flux?.mcpCall?.("query_asset", {}).then((tx: string) => { const a = JSON.parse(tx); if (Array.isArray(a)) setFluxAssets(a); }); }}
        revealInExplorer={(p: string) => { const dir = p.substring(0, p.lastIndexOf("/")); const home = "/home/exuber"; setProjectPath(home + dir); setLeftTab("explorer"); }} />}
      <PetAssistant events={events} centerTab={centerTab} assetsSub={assetsSub} schedState={schedState} />
      {ctxMenu && <ContextMenu ctxMenu={ctxMenu} closeCtx={closeCtx} refreshTree={refreshTree}
        doDelete={doDelete} copyPath={copyPath} copyRelPath={copyRelPath} addToChat={addToChat}
        setCreating={setCreating} projectPath={projectPath}
        setRenaming={setRenaming} />}
    </div>
  );
}

// ═══ Tree View with context menu ═══
function TreeView({ nodes, depth, activeFile, toggleFolder, openFile, onContextMenu, renaming, setRenaming, doRename }: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (
    <ul className="ft-list" style={{ marginLeft: depth > 0 ? 8 : 0 }}>
      {nodes.map((node: TreeNode) => (
        <li key={node.path}>
          {renaming?.node === node ? (
            <input className="input-inline" autoFocus value={renaming.newName}
              onChange={(e) => setRenaming({ ...renaming, newName: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") doRename(); if (e.key === "Escape") setRenaming(null); }}
              onBlur={doRename} />
          ) : (
            <div className={`ft-item ${activeFile === node.name ? "active" : ""}`} style={{ paddingLeft: depth * 8 }}
              onClick={() => node.isDir ? toggleFolder(node) : openFile(node)}
              onContextMenu={(e) => onContextMenu(e, node)}>
              <span>{node.isDir ? (node.expanded ? "📂" : "📁") : iconForExt(node.ext)}</span>
              {node.name}
            </div>
          )}
          {node.isDir && node.expanded && node.children && (
            <TreeView nodes={node.children} depth={depth + 1} activeFile={activeFile}
              toggleFolder={toggleFolder} openFile={openFile} onContextMenu={onContextMenu}
              renaming={renaming} setRenaming={setRenaming} doRename={doRename} />
          )}
        </li>
      ))}
    </ul>
  );
}

// ═══ Context Menu ═══
function ContextMenu({ ctxMenu, closeCtx, refreshTree, doDelete, copyPath, copyRelPath, addToChat, setCreating, projectPath, setRenaming }: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { x, y, node, isRoot } = ctxMenu;
  const parentPath = node ? (node.isDir ? node.path : node.path.substring(0, node.path.lastIndexOf("/"))) : projectPath;
  return (
    <div className="ctx-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      {isRoot || node?.isDir ? (
        <>
          <div className="ctx-item" onClick={() => { setCreating({ parentPath, name: "", isDir: false }); closeCtx(); }}>📄 New File</div>
          <div className="ctx-item" onClick={() => { setCreating({ parentPath, name: "", isDir: true }); closeCtx(); }}>📁 New Folder</div>
          <div className="ctx-sep" />
        </>
      ) : null}
      {!isRoot && node && (
        <>
          <div className="ctx-item" onClick={() => { addToChat(node); }}>💬 Add File to Chat</div>
          <div className="ctx-item" onClick={() => copyPath(node)}>📋 Copy Path</div>
          <div className="ctx-item" onClick={() => copyRelPath(node)}>📋 Copy Relative Path</div>
          <div className="ctx-sep" />
          <div className="ctx-item disabled">✂️ Cut <span className="ctx-shortcut">Ctrl+X</span></div>
          <div className="ctx-item disabled">📋 Copy <span className="ctx-shortcut">Ctrl+C</span></div>
          <div className="ctx-item" onClick={() => { setRenaming({ node, newName: node.name }); closeCtx(); }}>✏️ Rename <span className="ctx-shortcut">F2</span></div>
          <div className="ctx-item" onClick={() => doDelete(node)}>🗑️ Delete <span className="ctx-shortcut">Del</span></div>
          <div className="ctx-sep" />
          <div className="ctx-item disabled">🧪 Run Test</div>
          <div className="ctx-item disabled">🐛 Debug Test</div>
        </>
      )}
    </div>
  );
}

// ═══ Left Sidebar ═══
function LeftSidebar(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t } = useLang();
  const { tab, setTab, events, state, treeRoot, toggleFolder, activeFile, openFile,
    customOpen, setCustomOpen, projectPath, setProjectPath, onContextMenu, renaming, setRenaming, doRename,
    creating, setCreating, doCreate, refreshTree, apiConfig, setApiConfig, switchProvider } = props;
  return (
    <aside className="left-sidebar">
      {/* ── Workspaces: first-class, PilotDeck-style (add/rename/delete) ── */}
      <div className="ws-bar">
        <div style={{ fontSize: 9, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".08em", color: "var(--grey-3)", marginBottom: 4, display: "flex", alignItems: "center" }}>
          {t("ws.title")}
          <button className="ft-btn" style={{ marginLeft: "auto" }} title={t("ws.add")} onClick={() => void props.addWorkspace()}>＋</button>
        </div>
        {props.workspaces?.map((ws: { id: string; name: string; path: string }) => (
          <div key={ws.id} className={`ws-row ${props.activeWs === ws.id ? "on" : ""}`} onClick={() => props.selectWorkspace(ws.id)}>
            <span className="ws-dot" />
            {props.renamingWs === ws.id ? (
              <input className="input-inline" autoFocus defaultValue={ws.name}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") props.renameWorkspace(ws.id, (e.target as HTMLInputElement).value);
                  if (e.key === "Escape") props.setRenamingWs(null);
                }}
                onBlur={(e) => props.renameWorkspace(ws.id, e.target.value)} />
            ) : (
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ws.path}>{ws.name}</span>
            )}
            {ws.id !== "global" && props.renamingWs !== ws.id && (
              <span className="ws-actions">
                <button className="ft-btn" title={t("ws.rename")} onClick={(e) => { e.stopPropagation(); props.setRenamingWs(ws.id); }}>✎</button>
                <button className="ft-btn" title={t("ws.remove")} onClick={(e) => { e.stopPropagation(); props.deleteWorkspace(ws.id); }}>🗑</button>
              </span>
            )}
          </div>
        ))}
      </div>

      {/* upper half: session | explorer */}
      <div className="ls-tabs">
        {(["session", "explorer"] as LeftTab[]).map((tt) => (
          <div key={tt} className={`ls-tab ${tab === tt ? "on" : ""}`} onClick={() => setTab(tt)}>{tt}</div>
        ))}
      </div>
      <div className="ls-content">
        {tab === "session" && (
          <div>
            <button className="ls-new-btn" style={{ marginBottom: 8 }} onClick={props.newSession}>+ New Session</button>
            {props.sessions?.map((sx: { id: string; name: string; msgs: unknown[] }) => (
              <div key={sx.id} className={`sess-item ${props.activeSession === sx.id ? "active" : ""}`}
                onClick={() => props.openSession(sx.id)}>
                {props.activeSession === sx.id ? "▶ " : ""}{sx.name}
                <span style={{ float: "right", color: "var(--grey-3)", fontSize: 10 }}>
                  {props.activeSession === sx.id ? "" : `${sx.msgs.length}`}
                </span>
              </div>
            ))}
          </div>
        )}
        {tab === "explorer" && (
          <div onContextMenu={(e) => onContextMenu(e, null)}>
            <div className="ft-toolbar">
              <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--grey-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{projectPath.split("/").pop()}</span>
              <button className="ft-btn" onClick={async () => { const p = await window.flux?.openFolder?.(); if (p) { setProjectPath(p); } }}>📂</button>
              <button className="ft-btn" onClick={() => refreshTree()}>↻</button>
            </div>
            {creating && (
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 10, color: "var(--grey-3)" }}>{creating.isDir ? "📁" : "📄"} </span>
                <input className="input-inline" autoFocus placeholder={creating.isDir ? "folder name" : "file name"}
                  value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") doCreate(creating.isDir); if (e.key === "Escape") setCreating(null); }}
                  onBlur={() => creating.name && doCreate(creating.isDir)} />
              </div>
            )}
            {treeRoot.length === 0 ? <div className="empty-hint">Loading…</div> :
              <TreeView nodes={treeRoot} depth={0} activeFile={activeFile} toggleFolder={toggleFolder}
                openFile={openFile} onContextMenu={onContextMenu} renaming={renaming}
                setRenaming={setRenaming} doRename={doRename} />}
          </div>
        )}
      </div>

      {/* lower half: api / agent / memory / mcp / skill / conda */}
      <div className="custom-section">
        <div className="custom-h" data-guide="api-config" onClick={() => setCustomOpen(customOpen === "api" ? null : "api")}>
          {customOpen === "api" ? "▾" : "▸"} {t("side.api")}
        </div>
        {customOpen === "api" && (
          <div style={{ padding: "4px 8px" }}>
            {Object.entries(PROVIDER_PRESETS).map(([key, preset]) => (
              <div key={key} className="custom-item" style={{ cursor: "pointer", fontWeight: apiConfig.provider === key ? 600 : 400, color: apiConfig.provider === key ? "var(--accent)" : "var(--grey-3)" }}
                onClick={() => switchProvider(key)}>
                <span className={`dot-sm ${apiConfig.provider === key ? "on" : ""}`} />
                {preset.label}
              </div>
            ))}
            <div style={{ marginTop: 6 }}>
              <div className="custom-item"><span className="lbl-sm">{t("side.endpoint")}</span><input type="text" value={apiConfig.endpoint} onChange={(e) => setApiConfig({ ...apiConfig, endpoint: e.target.value })} onBlur={() => window.flux?.sendSetApi?.(apiConfig)} /></div>
              <div className="custom-item"><span className="lbl-sm">{t("side.model")}</span><input type="text" value={apiConfig.model} onChange={(e) => setApiConfig({ ...apiConfig, model: e.target.value })} onBlur={() => window.flux?.sendSetApi?.(apiConfig)} /></div>
              <div className="custom-item"><span className="lbl-sm">{t("side.apikey")}</span><input type="password" value={apiConfig.apiKey} onChange={(e) => setApiConfig({ ...apiConfig, apiKey: e.target.value })} onBlur={() => window.flux?.sendSetApi?.(apiConfig)} placeholder="(optional)" /></div>
            </div>
          </div>
        )}

        <div className="custom-h" onClick={() => setCustomOpen(customOpen === "agent" ? null : "agent")}>
          {customOpen === "agent" ? "▾" : "▸"} {t("side.agents")}
        </div>
        {customOpen === "agent" && (
          <>
            <div className="custom-item"><span className={`dot-sm ${state.deviceAttached ? "on" : ""}`} />openocd-task · {state.real ? "REAL" : "mock"}</div>
            <div className="custom-item" title={t("rp.engineTip")}><span className={`dot-sm ${state.brainReady ? "on" : ""}`} />{t("rp.engine")}</div>
            <div className="custom-item"><span className="dot-sm on" />mission-engine</div>
            <div className="custom-item"><span className="dot-sm on" />training-agent</div>
          </>
        )}

        <div className="custom-h" onClick={() => setCustomOpen(customOpen === "memory" ? null : "memory")}>
          {customOpen === "memory" ? "▾" : "▸"} {t("side.memory")}
        </div>
        {customOpen === "memory" && (
          <>
            {["asset.committed", "mission.milestone", "triage.result"].map((k) => (
              <div key={k} className="custom-item"><span className="dot-sm on" />{k} ×{events.filter((e: FluxEvent) => e.topic === k).length}</div>
            ))}
            <div className="custom-item" style={{ cursor: "pointer" }} title={t("rp.dreamTip")}
              onClick={() => void window.flux?.mcpCall?.("dream", {})}>🌙 {t("side.dream")}</div>
          </>
        )}

        <div className="custom-h" onClick={() => setCustomOpen(customOpen === "mcp" ? null : "mcp")}>
          {customOpen === "mcp" ? "▾" : "▸"} {t("side.mcp")}
        </div>
        {customOpen === "mcp" && (
          (props.mcpServers?.length ? props.mcpServers : [{ name: "(loading…)", count: 0 }]).map((srv: { name: string; count: number }) => (
            <div key={srv.name} className="custom-item"><span className="dot-sm on" />{srv.name} · {srv.count} tools</div>
          ))
        )}

        <div className="custom-h" onClick={() => setCustomOpen(customOpen === "skills" ? null : "skills")}>
          {customOpen === "skills" ? "▾" : "▸"} {t("side.skills")}
        </div>
        {customOpen === "skills" && (props.studioSkills?.length ? props.studioSkills : [{ name: "board-bringup", title: "" }]).map((sk: { name: string; title: string }, i: number) => (
          <div key={i} className="custom-item" style={{ cursor: "pointer" }}
            title={sk.title}
            onClick={() => void window.flux?.mcpCall?.("get_skill", { name: sk.name }).then((md: string) => props.openSkill?.(md))}>
            <span className="dot-sm on" />📖 {sk.name}
          </div>
        ))}

        <div className="custom-h" onClick={() => setCustomOpen(customOpen === "conda" ? null : "conda")}>
          {customOpen === "conda" ? "▾" : "▸"} {t("side.conda")}
        </div>
        {customOpen === "conda" && (
          (props.condaEnvs?.length ? props.condaEnvs : [{ name: "(none)", path: "" }]).map((env: CondaEnv) => (
            <div key={env.name} className="custom-item" style={{ cursor: "pointer", fontWeight: props.condaActive === env.name ? 600 : 400 }}
              onClick={() => env.path && props.chooseConda?.(env.name)}>
              <span className={`dot-sm ${props.condaActive === env.name ? "on" : ""}`} />{env.name}
              {props.condaActive === env.name && <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 9 }}>active</span>}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// ═══ Chat Area ═══
function ChatArea(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { msgs, input, setInput, sendChat, fileContent, activeFile, saveFile, state } = props;
  return (
    <main className="chat-area">
      <div className="chat-messages">
        {activeFile && fileContent && (
          <div style={{ marginBottom: 12 }}>
            <CodeView fileName={activeFile} content={fileContent} onSave={(text) => saveFile(text)} />
          </div>
        )}
        {msgs.length === 0 && !activeFile && (
          <div className="chat-empty">
            <div style={{ fontSize: 28, fontWeight: 200, marginBottom: 8 }}>Flux Studio</div>
            <div style={{ fontSize: 14 }}>{state.brainReady ? "Ask MiniCPM-V anything." : "Connecting…"}</div>
          </div>
        )}
        {msgs.map((m: ChatMsg, i: number) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <span className="chat-role">{m.role === "user" ? "▸" : "⚡"}</span>
            <div className="chat-text">{m.text}
              {m.codeBlock && (<div className="chat-code-block"><textarea defaultValue={m.codeBlock.slice(0,5000)} rows={Math.min(15, m.codeBlock.split("\n").length)} /><div className="chat-code-actions"><button className="chat-code-btn" onClick={() => saveFile(m.codeBlock!)}>Save</button></div></div>)}
            </div>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <textarea className="chat-input" rows={1} value={input}
          onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`; }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); (e.target as HTMLTextAreaElement).style.height = "auto"; } }}
          placeholder="Ask anything…  (Enter 发送 · Shift+Enter 换行)" />
        <button className="chat-send" onClick={sendChat}>Send</button>
      </div>
    </main>
  );
}

// ═══ Right Panel ═══
// Collapsible right-panel section (issue 11): header toggles, extra widgets
// (badges/buttons) live in the header without triggering the fold.
function Fold({ title, defaultOpen = true, extra, children }: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rp-section">
      <div className="rp-h fold-h" onClick={() => setOpen(!open)}>
        <span className="fold-caret">{open ? "▾" : "▸"}</span>
        <span style={{ flex: 1 }}>{title}</span>
        {extra && <span onClick={(e) => e.stopPropagation()}>{extra}</span>}
      </div>
      {open && children}
    </div>
  );
}

function RightPanel(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t } = useLang();
  const { events, state, fluxAssets, rawEvents, mcpServers, onOpenAsset, schedState } = props;
  const assets = events.filter((e: FluxEvent) => e.topic === "asset.committed");

  // Software modules: everything the kernel can schedule that is NOT a
  // physical probe — with what each one is allowed to touch.
  const MOD_PERMS: Record<string, Array<[string, boolean]>> = {
    "flux-insight": [[t("mod.pLlm"), true], [t("mod.pAsset"), true], [t("mod.pHw"), false]],
    "unitport": [[t("mod.pProc"), true], [t("mod.pHw"), false]],
    "isaacsim": [[t("mod.pSim"), true], [t("mod.pHw"), false]],
    "physical": [[t("mod.pHw"), true]],
  };
  const kernelModules: Array<{ name: string; desc: string; on: boolean; perms: Array<[string, boolean]> }> = [
    { name: "hil-runner", desc: t("mod.hil"), on: true, perms: [[t("mod.pHw"), true], [t("mod.pSim"), true]] },
    { name: "build-service", desc: t("mod.build"), on: true, perms: [[t("mod.pProc"), true]] },
    { name: "training-agent", desc: t("mod.train"), on: true, perms: [[t("mod.pProc"), true]] },
    { name: "git", desc: t("mod.git"), on: false, perms: [[t("mod.pFs"), false]] },
  ];

  return (
    <aside className="right-panel">
      {/* ── the dev flow, visualized (merged Overview + Insight Loop) ── */}
      <Fold title={t("rp.pipeline")}>
        <PipelineViz events={rawEvents} />
      </Fold>

      {/* live kernel scheduler — its own fold so users can collapse it (点标题即收起) */}
      <Fold title={t("rp.sched")} defaultOpen={false}>
        <SchedulerViz state={schedState ?? null} onDemo={() => void window.flux?.schedulerDemo?.()} />
      </Fold>

      {/* ── software modules: kernel-schedulable, permission-scoped ── */}
      <Fold title={t("rp.modules")}>
        {(mcpServers ?? []).map((srv: { name: string; count: number }) => (
          <div key={srv.name} className="mod-row">
            <span className="ws-dot" style={{ background: "#4caf50" }} />
            <span style={{ fontWeight: 600 }}>{srv.name}</span>
            <span style={{ color: "var(--grey-3)" }}>{srv.count}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {(MOD_PERMS[srv.name] ?? [[t("mod.pProc"), true]] as Array<[string, boolean]>).map(([pm, g], i) => (
                <span key={i} className={`mod-chip ${g ? "grant" : "deny"}`}>{pm}{g ? " ✓" : " ✗"}</span>
              ))}
            </span>
          </div>
        ))}
        {kernelModules.map((m) => (
          <div key={m.name} className="mod-row">
            <span className="ws-dot" style={{ background: m.on ? "#4caf50" : "var(--grey-2)" }} />
            <span style={{ fontWeight: 600, color: m.on ? "var(--ink)" : "var(--grey-3)" }}>{m.name}</span>
            <span style={{ color: "var(--grey-3)" }}>{m.desc}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
              {m.perms.map(([pm, g], i) => (
                <span key={i} className={`mod-chip ${g ? "grant" : "deny"}`}>{pm}{g ? " ✓" : " ✗"}</span>
              ))}
            </span>
          </div>
        ))}
        <div style={{ fontSize: 9.5, color: "var(--grey-3)", marginTop: 4 }} title={t("rp.capTip")}>{t("rp.capHint")}</div>
      </Fold>

      <Fold title={t("rp.subagents")} defaultOpen={false}>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.deviceAttached ? "on" : "off"}`} /> C · {state.real ? "REAL" : "MOCK"}</div>
          <div className="rp-title">openocd-task</div>
          <div className="rp-chips"><span className="rp-chip">halt</span><span className="rp-chip">flash</span><span className="rp-chip">mdw</span></div>
        </div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.brainReady ? "on" : "off"}`} /> Python · {state.brainReady ? "ready" : "..."}</div>
          <div className="rp-title" title={t("rp.engineTip")}>{t("rp.engine")}</div>
        </div>
      </Fold>

      {/* ── DevReady assets: click a card for pins / build / usd / props ── */}
      <Fold title={t("rp.assets")} extra={
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 8, border: "1px solid var(--grey-2)",
            background: props.wsLabel === "global" ? "var(--grey-1)" : "rgba(0,47,167,.08)",
            color: props.wsLabel === "global" ? "var(--grey-3)" : "var(--accent)" }}>
            {props.wsLabel ?? "global"}
          </span>
          <button data-guide="asset-export" className="ft-btn" title={t("rp.export")}
            onClick={async () => {
              const out = `~/.flux/exports/${props.wsLabel ?? "assets"}-${Date.now()}.json`;
              const r = JSON.parse(await (window as any).flux?.mcpCall?.("export_asset", { out_path: out }));
              alert(`${t("rp.exported")}: ${r.count} → ${r.path}`);
            }}>⬆</button>
          <button data-guide="asset-import" className="ft-btn" title={t("rp.import")}
            onClick={async () => {
              const f = await (window as any).flux?.openFile?.([{ name: "Flux assets", extensions: ["json"] }]);
              if (!f) return;
              const r = JSON.parse(await (window as any).flux?.mcpCall?.("import_asset", { path: f }));
              alert(`${t("rp.imported")}: ${r.imported} (skipped ${r.skipped})`);
            }}>⬇</button>
          <button data-guide="asset-dream" className="ft-btn" title={t("rp.dreamTip")}
            onClick={() => void (window as any).flux?.mcpCall?.("dream", {})}>🌙</button>
        </span>
      }>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">{t("rp.events")}</div><div className="nb">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">{t("rp.assetCount")}</div><div className="nb accent">{fluxAssets?.length ?? 0}</div></div>
        </div>
        <div style={{ fontSize: 9.5, color: "var(--grey-3)", margin: "2px 0 4px" }}>{t("rp.assetHint")}</div>
        {(() => {
          const RECORD_TYPES = new Set(["mission", "hil-report", "triage-case", "evidence-bundle", "dream-report", "bench-result", "feedback", "board-health"]);
          const records = (fluxAssets ?? []).filter((a: any) => RECORD_TYPES.has(a.type));
          return records.length > 0 ? (
            <div style={{ fontSize: 9.5, color: "var(--grey-3)", marginBottom: 4 }}>
              🗂 {records.length} {t("rp.recordsHint")}
            </div>
          ) : null;
        })()}
        {fluxAssets?.filter((a: any) => !["mission", "hil-report", "triage-case", "evidence-bundle", "dream-report", "bench-result", "feedback", "board-health"].includes(a.type)).map((a: any, i: number) => (
          <div key={i} data-guide={i === 0 ? "asset-card" : undefined} className="rp-card" style={{ cursor: "pointer" }} onClick={() => onOpenAsset?.(a)}>
            <div className="rp-meta">{(a.type || "asset").toUpperCase()}</div>
            <div className="rp-title" style={{ fontSize: 11 }}>{a.id}</div>
            <div style={{ fontSize: 10, color: "var(--grey-3)" }}>{(a.components ?? []).slice(0, 4).join(" · ")}</div>
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <span className="mod-chip">📌 {t("ad.pins")}</span>
              <span className="mod-chip">🔧 {t("ad.build")}</span>
              <span className="mod-chip">🧊 {t("ad.usd")}</span>
              <span className="mod-chip">⋯</span>
            </div>
          </div>
        ))}
      </Fold>
    </aside>
  );
}

// ═══ Footer ═══
function Footer(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t, lang, setLang } = useLang();
  const { state, condaEnvs, condaActive, setCondaActive, condaDropdown, setCondaDropdown } = props;
  return (
    <footer className="footbar">
      <div className="stage" onClick={() => setLang(lang === "zh" ? "en" : "zh")} title="switch language" style={{ cursor: "pointer" }}><b>{lang === "zh" ? "中" : "EN"}</b></div><span className="arr">·</span>
      <div className="stage">{t("foot.device")} <b>{state.deviceAttached ? (state.real?"REAL":"mock") : "—"}</b></div><span className="arr">→</span>
      <div className="stage" title={t("rp.engineTip")}>{t("rp.engine")} <b>{state.brainReady?"ready":"..."}</b></div><span className="arr">→</span>
      <div className="stage">assets <b>{state.assets}</b></div>
      <div className="spacer" />
      {/* 现场快照: one click captures the last 10 min for a bug report; import restores it here */}
      <button className="ft-btn" data-guide="scene-save" title={t("scene.saveTip")} onClick={() => props.onSceneDump?.()}>📸 {t("scene.save")}</button>
      <button className="ft-btn" title={t("scene.loadTip")} onClick={() => props.onSceneLoad?.()}>📂 {t("scene.load")}</button>
      {props.osInfo && (
        <div className="stage" title={`kernel ${props.osInfo.kernel ?? ""} · ${props.osInfo.session ?? ""}`}>
          🖥 <b>{props.osInfo.distro || props.osInfo.platform}</b> {props.osInfo.arch}
        </div>
      )}
    </footer>
  );
}

// ── helpers ──
function mdToHtml(md: string): string {
  let html = md
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    // code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="code-block">$2</code></pre>')
    // headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // bold/italic/code
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // tables (simple pipe tables)
    .replace(/^\|(.+)\|$/gm, (match) => {
      const cells = match.split("|").filter((c) => c.trim());
      if (cells.every((c) => /^[-:\s]+$/.test(c.trim()))) return "";
      const tds = cells.map((c) => `<td>${c.trim()}</td>`).join("");
      return `<tr>${tds}</tr>`;
    })
    .replace(/(<tr>[\s\S]*?<\/tr>\s*)+/g, (m) => `<table>${m}</table>`)
    // lists
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    // horizontal rules
    .replace(/^---+$/gm, "<hr/>")
    // paragraphs (double newline)
    .replace(/\n\n/g, "</p><p>")
    .replace(/^(?!<)/gm, "");
  return `<div class="wiki-content"><p>${html}</p></div>`;
}

function topicColor(topic: string): string {
  if (topic.startsWith("alarm")) return "#ff4444";
  if (topic.startsWith("device")) return "#ff8800";
  if (topic.startsWith("openocd")) return "#ff8800";
  if (topic.startsWith("build")) return "#002FA7";
  if (topic.startsWith("agent")) return "#5B7BFF";
  if (topic.startsWith("asset")) return "#00aa44";
  if (topic.startsWith("workflow")) return "#9c27b0";
  if (topic.startsWith("cmd")) return "#737373";
  return "#737373";
}
function iconForExt(ext: string): string {
  const m: Record<string,string> = { py:"🐍", ts:"🟦", tsx:"⚛️", c:"🔧", h:"🔧", js:"🟨", json:"📄", md:"📖", yaml:"📄", yml:"📄", proto:"📄", sh:"📜" };
  return m[ext?.toLowerCase()] || "📄";
}
interface StudioState {
  deviceAttached: boolean; brainReady: boolean; real: boolean; assets: number; openocdEvents: number;
  lastAlarm: FluxEvent | undefined;
  workflow: { name: string; steps: Array<{ name: string; op: string; deps: string[] }> } | undefined;
}
function deriveState(events: FluxEvent[]): StudioState {
  let deviceAttached=false, brainReady=false, real=false, assets=0, openocdEvents=0;
  let lastAlarm: FluxEvent|undefined; let workflow: StudioState["workflow"];
  for (const e of events) {
    if (e.topic==="device.attached"){deviceAttached=true;real=Boolean(e.data?.["real"]);}
    if (e.topic==="brain.ready") brainReady=true;
    if (e.topic==="alarm.critical"||e.topic==="alarm.policy-violation") lastAlarm=e;
    if (e.topic==="asset.committed") assets++;
    if (e.topic==="openocd.event") openocdEvents++;
    if (e.topic==="workflow.published") workflow={name:String(e.data?.["name"] ?? "?"),steps:((e.data?.["steps"] as unknown as Array<{name:string;op:string;deps:string[]}>) ?? [])};
  }
  return { deviceAttached, brainReady, lastAlarm, assets, openocdEvents, real, workflow };
}
