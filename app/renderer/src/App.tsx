// Flux Studio — VScode-like Explorer + drag resize + cc-switch providers + clawhub
import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { HilPanel } from "./HilPanel";
import { ProblemsPanel } from "./ProblemsPanel";
import { FluxWeavePanel } from "./FluxWeavePanel";
import { UnitPortPanel } from "./UnitPortPanel";
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
const PROVIDER_PRESETS: Record<string, { endpoint: string; model: string; label: string }> = {
  vllm: { endpoint: "http://127.0.0.1:8000", model: "openbmb/MiniCPM-V-4.6", label: "Local vLLM" },
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4o", label: "OpenAI" },
  anthropic: { endpoint: "https://api.anthropic.com", model: "claude-sonnet-5-20250929", label: "Anthropic Claude" },
  deepseek: { endpoint: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", label: "DeepSeek" },
  mimo: { endpoint: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5", label: "Xiaomi MiMo" },
  custom: { endpoint: "", model: "", label: "Custom" },
};

export function App() {
  const { t } = useLang();
  const [events, setEvents] = useState<FluxEvent[]>([]);
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
  const [apiConfig, setApiConfig] = useState({ provider: "vllm", endpoint: "http://127.0.0.1:8000", apiKey: "", model: "openbmb/MiniCPM-V-4.6" });
  const [fluxAssets, setFluxAssets] = useState<{id:string;ts:number;type:string;components:string[]}[]>([]);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState("");
  // ── center tabs ──
  const [centerTab, setCenterTab] = useState<"chat" | "fluxweave" | "unitport" | "wiki" | "hil">("chat");
  const [problemsOpen, setProblemsOpen] = useState(false);
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
  useEffect(() => { void window.flux?.listFluxAssets?.().then((a: typeof fluxAssets) => setFluxAssets(a)).catch(() => void 0); }, [events.filter(e=>e.topic==="asset.committed").length]);
  const triageCount = events.filter((e) => e.topic === "triage.result").length;
  useEffect(() => { if (triageCount > 0) setProblemsOpen(true); }, [triageCount]);

  // ── wiki (from Help menu via preload) ──
  useEffect(() => {
    const off = window.flux?.onOpenWiki?.((path: string) => {
      void window.flux?.readFile?.(path).then((c: string) => { setWikiContent(c); setCenterTab("wiki"); });
    });
    return () => off?.();
  }, []);

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

  return (
    <div className="shell" style={{ ["--lw" as string]: `${leftWidth}px`, ["--rw" as string]: `${rightWidth}px` }}>
      <LeftSidebar tab={leftTab} setTab={setLeftTab} events={events} state={state}
        treeRoot={treeRoot} toggleFolder={toggleFolder} activeFile={activeFile} openFile={openFile}
        customOpen={customOpen} setCustomOpen={setCustomOpen} projectPath={projectPath} setProjectPath={setProjectPath}
        onContextMenu={onContextMenu} renaming={renaming} setRenaming={setRenaming} doRename={doRename}
        creating={creating} setCreating={setCreating} doCreate={doCreate} refreshTree={refreshTree}
        apiConfig={apiConfig} setApiConfig={setApiConfig} switchProvider={switchProvider} />
      <div className="resize-bar resize-l" onMouseDown={startDrag("left")} />
      <main className="chat-area">
        <div className="center-tabs">
          <div className={`center-tab ${centerTab === "chat" ? "on" : ""}`} onClick={() => setCenterTab("chat")}>{t("tab.chat")}</div>
          <div className={`center-tab ${centerTab === "fluxweave" ? "on" : ""}`} onClick={() => setCenterTab("fluxweave")}>{t("tab.fluxweave")}</div>
          <div className={`center-tab ${centerTab === "unitport" ? "on" : ""}`} onClick={() => setCenterTab("unitport")}>{t("tab.unitport")}</div>
          <div className={`center-tab ${centerTab === "hil" ? "on" : ""}`} onClick={() => setCenterTab("hil")}>{t("tab.hil")}</div>
          {wikiContent && <div className={`center-tab ${centerTab === "wiki" ? "on" : ""}`} onClick={() => setCenterTab("wiki")}>{t("tab.plan")}</div>}
        </div>
        {centerTab === "chat" && (
          <ChatArea msgs={chatMsgs} input={chatInput} setInput={setChatInput} sendChat={sendChat}
            fileContent={fileContent} activeFile={activeFile} saveFile={saveFile} state={state} />
        )}
        {centerTab === "fluxweave" && <FluxWeavePanel />}
        {centerTab === "unitport" && <UnitPortPanel events={events} />}
        {centerTab === "hil" && <HilPanel events={events} />}
        {centerTab === "wiki" && wikiContent && (
          <div className="wiki-view" dangerouslySetInnerHTML={{ __html: mdToHtml(wikiContent) }} />
        )}
        <div onClick={() => setProblemsOpen(!problemsOpen)}
          style={{ borderTop: "1px solid var(--ink, #333)", padding: "3px 12px", fontSize: 10, cursor: "pointer",
                   fontFamily: "var(--mono, monospace)", color: "var(--grey-3, #888)", userSelect: "none", flexShrink: 0 }}>
          {problemsOpen ? "▾" : "▴"} {t("prob.title")} · {events.filter((e) => e.topic === "build.diagnostic").length} {t("prob.diagnostics")} · {events.filter((e) => e.topic === "triage.result").length} {t("prob.triage")}
        </div>
        {problemsOpen && (
          <div style={{ height: 220, flexShrink: 0, borderTop: "1px solid #222" }}>
            <ProblemsPanel events={events} openFile={openFileByPath} />
          </div>
        )}
      </main>
      <RightPanel events={events} state={state} fluxAssets={fluxAssets} building={building} buildResult={buildResult} doBuild={doBuild}
        rawEvents={events} />
      <Footer state={state} condaEnvs={condaEnvs} condaActive={condaActive} setCondaActive={setCondaActive} condaDropdown={condaDropdown} setCondaDropdown={setCondaDropdown} />
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
      <div className="ls-tabs">
        {(["session", "memory", "explorer"] as LeftTab[]).map((t) => (
          <div key={t} className={`ls-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>
      <div className="ls-content">
        {tab === "session" && (
          <div>
            <button className="ls-new-btn" style={{ marginBottom: 8 }}>+ New Session</button>
            <div className="sess-item active">▶ Current ({events.length} events)</div>
          </div>
        )}
        {tab === "memory" && (
          <div>
            <div className="mem-item"><span className="mem-k">device.attached</span> ×{events.filter((e:FluxEvent)=>e.topic==="device.attached").length}</div>
            <div className="mem-item"><span className="mem-k">openocd.event</span> ×{events.filter((e:FluxEvent)=>e.topic==="openocd.event").length}</div>
            <div className="mem-item"><span className="mem-k">asset.committed</span> ×{events.filter((e:FluxEvent)=>e.topic==="asset.committed").length}</div>
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
      {/* Customizations */}
      <div className="custom-section">
        {/* API Provider (cc-switch style) */}
        <div className="custom-h" onClick={() => setCustomOpen(customOpen === "api" ? null : "api")}>
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
        {/* Other customizations */}
        {[
          { id: "workflow", label: t("side.workflow"), items: state.workflow?.steps.map((s:any)=>`${s.name}: ${s.op}`) ?? ["(none)"] },
          { id: "agents", label: t("side.agents"), items: ["openocd-task", "brain-agent"] },
          { id: "skills", label: t("side.skills"), items: ["characterize", "codegen", "schematic→netlist", "+ Install from ClawhHub"] },
          { id: "mcp", label: t("side.mcp"), items: ["(v2) dimos", "(v2) scp"] },
          { id: "tools", label: t("side.tools"), items: ["riscv GCC", "HPM_SDK", "HPM OpenOCD"] },
        ].map((s) => (
          <div key={s.id}>
            <div className="custom-h" onClick={() => setCustomOpen(customOpen === s.id ? null : s.id)}>{customOpen === s.id ? "▾" : "▸"} {s.label}</div>
            {customOpen === s.id && s.items.map((item: string, i: number) => (
              <div key={i} className="custom-item"><span className={`dot-sm ${i === 0 ? "on" : ""}`} />{item}</div>
            ))}
          </div>
        ))}
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
          <div className="chat-code-block">
            <div style={{ fontSize: 10, color: "#888", marginBottom: 4 }}>📄 {activeFile}</div>
            <textarea defaultValue={fileContent.slice(0, 5000)} rows={Math.min(20, fileContent.split("\n").length)} />
            <div className="chat-code-actions"><button className="chat-code-btn" onClick={() => saveFile(fileContent)}>Save</button></div>
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
        <input className="chat-input" type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }} placeholder="Ask MiniCPM-V…" />
        <button className="chat-send" onClick={sendChat}>Send</button>
      </div>
    </main>
  );
}

// ═══ Right Panel ═══
function RightPanel(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { t } = useLang();
  const { events, state, fluxAssets, building, buildResult, doBuild, rawEvents } = props;
  const ocdEvents = events.filter((e: FluxEvent) => e.topic === "openocd.event").slice(-3);
  const assets = events.filter((e: FluxEvent) => e.topic === "asset.committed");

  // ── Infrastructure Core visualization data ──
  const topics = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of rawEvents) { counts[e.topic] = (counts[e.topic] || 0) + 1; }
    return counts;
  }, [rawEvents]);
  const maxTopic = Math.max(1, ...Object.values(topics));
  const priorityBands = [
    { name: "alarm", level: 90, color: "#ff4444", count: (topics["alarm.critical"] || 0) + (topics["alarm.policy-violation"] || 0) },
    { name: "device", level: 70, color: "#ff8800", count: (topics["device.attached"] || 0) + (topics["openocd.event"] || 0) },
    { name: "build", level: 30, color: "#002FA7", count: (topics["build.progress"] || 0) },
    { name: "agent", level: 30, color: "#5B7BFF", count: (topics["agent.event"] || 0) + (topics["cmd.chat"] || 0) },
    { name: "asset", level: 30, color: "#00aa44", count: (topics["asset.committed"] || 0) + (topics["workflow.published"] || 0) },
  ];
  const flowSteps = state.workflow?.steps || [];
  const topicFlow = rawEvents.slice(-8).reverse();

  return (
    <aside className="right-panel">
      {/* ═══ Infrastructure Core (实时可视化) ═══ */}
      <div className="rp-section infra-viz">
        <div className="rp-h">⚡ Infrastructure Core</div>

        {/* 3×2 Scheduler — priority bands as live bars */}
        <div className="infra-block">
          <div className="infra-label">3×2 Scheduler · Priority Bands</div>
          <div className="priority-bars">
            {priorityBands.map((b) => (
              <div key={b.name} className="pbar-row">
                <div className="pbar-name" style={{ color: b.color }}>{b.level}</div>
                <div className="pbar-track">
                  <div className="pbar-fill" style={{ width: `${Math.max(2, (b.count / maxTopic) * 100)}%`, background: b.color }} />
                  <span className="pbar-text">{b.name} ({b.count})</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* uORB Bus — live topic flow */}
        <div className="infra-block">
          <div className="infra-label">uORB Bus · Live Topic Flow</div>
          <div className="topic-flow">
            {topicFlow.length === 0 ? (
              <div className="empty-hint" style={{ padding: "4px 0" }}>waiting…</div>
            ) : topicFlow.map((e: FluxEvent, i: number) => (
              <div key={i} className="topic-flow-item" style={{ opacity: 1 - i * 0.1 }}>
                <span className="tf-dot" style={{ background: topicColor(e.topic) }} />
                <span className="tf-topic">{e.topic}</span>
                <span className="tf-src">{e.source}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Capability — status badges */}
        <div className="infra-block">
          <div className="infra-label">Capability Auth</div>
          <div className="cap-badges">
            <span className="cap-badge on">ed25519 ✓</span>
            <span className="cap-badge on">openocd-task</span>
            <span className="cap-badge on">brain-agent</span>
            <span className="cap-badge on">policy-gate</span>
          </div>
        </div>

        {/* Supervisor — process status */}
        <div className="infra-block">
          <div className="infra-label">Supervisor · Processes</div>
          <div className="proc-grid">
            <div className={`proc-tile ${state.brainReady ? "alive" : ""}`}>
              <div className={`proc-dot ${state.brainReady ? "on" : ""}`} />
              <span>brain</span>
              <span className="proc-pid">{state.brainReady ? "●" : "…"}</span>
            </div>
            <div className={`proc-tile ${state.deviceAttached ? "alive" : ""}`}>
              <div className={`proc-dot ${state.deviceAttached ? "on" : ""}`} />
              <span>openocd</span>
              <span className="proc-pid">{state.deviceAttached ? (state.real ? "●" : "○") : "…"}</span>
            </div>
          </div>
        </div>

        {/* Flow axis — workflow DAG visual */}
        {flowSteps.length > 0 && (
          <div className="infra-block">
            <div className="infra-label">Flow Axis · Workflow DAG</div>
            <div className="dag-visual">
              {flowSteps.map((s: { name: string; op: string }, i: number) => (
                <div key={s.name} className="dag-node-wrap">
                  <div className={`dag-node ${i < 2 ? "done" : ""}`}>
                    <span className="dag-num">{i + 1}</span>
                    <span className="dag-name">{s.name}</span>
                  </div>
                  {i < flowSteps.length - 1 && <div className="dag-arrow">→</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Flux Insight Loop */}
      <div className="rp-section">
        <div className="rp-h">Flux Insight Loop</div>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">Research</div><div className="nb accent">{events.filter((e:FluxEvent)=>e.topic==="workflow.published").length}</div></div>
          <div className="kpi-cell"><div className="lbl">Execute</div><div className="nb">{ocdEvents.length}</div></div>
        </div>
        <iframe src="http://127.0.0.1:8420" style={{ width: "100%", height: 200, border: "1px solid var(--border)", borderRadius: 3 }} title="Flux Insight" />
      </div>
      <div className="rp-section">
        <div className="rp-h">Physical Subagents</div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.deviceAttached?"on":"off"}`} /> C · {state.real?"REAL":"MOCK"}</div>
          <div className="rp-title">openocd-task</div>
          <div className="rp-chips"><span className="rp-chip">halt</span><span className="rp-chip">flash</span><span className="rp-chip">mdw</span></div>
        </div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.brainReady?"on":"off"}`} /> Python · {state.brainReady?"ready":"..."}</div>
          <div className="rp-title">brain-agent</div>
        </div>
      </div>
      <div className="rp-section">
        <div className="rp-h">{t("rp.build")}</div>
        <button className="chat-send" style={{ width: "100%", marginBottom: 4 }} disabled={building} onClick={doBuild}>{building ? t("rp.building") : t("rp.buildBtn")}</button>
        {buildResult && <div style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--grey-3)", wordBreak: "break-all" }}>{buildResult.slice(0,200)}</div>}
      </div>
      <div className="rp-section">
        <div className="rp-h">{t("rp.assets")}</div>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">{t("rp.events")}</div><div className="nb">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">{t("rp.assetCount")}</div><div className="nb accent">{fluxAssets?.length ?? 0}</div></div>
        </div>
        {fluxAssets?.map((a: any, i: number) => (
          <div key={i} className="rp-card">
            <div className="rp-meta">{(a.type || "asset").toUpperCase()}</div>
            <div className="rp-title" style={{ fontSize: 11 }}>{a.id}</div>
            <div style={{ fontSize: 10, color: "var(--grey-3)" }}>{(a.components ?? []).slice(0, 4).join(" · ")}</div>
          </div>
        ))}
      </div>
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
      <div className="stage">brain <b>{state.brainReady?"ready":"..."}</b></div><span className="arr">→</span>
      <div className="stage">assets <b>{state.assets}</b></div>
      <div className="spacer" />
      <div style={{ position: "relative" }}>
        <div className="stage" onClick={() => setCondaDropdown(!condaDropdown)}>🐍 <b>{condaActive}</b> ▾</div>
        {condaDropdown && (
          <div className="conda-dropdown">
            {condaEnvs.length === 0 ? <div className="conda-item">(no envs)</div> :
              condaEnvs.map((env: CondaEnv) => (
                <div key={env.name} className={`conda-item ${condaActive===env.name?"active":""}`}
                  onClick={() => { setCondaActive(env.name); setCondaDropdown(false); }}>
                  {condaActive === env.name ? "● " : ""}{env.name}
                </div>
              ))}
          </div>
        )}
      </div>
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
