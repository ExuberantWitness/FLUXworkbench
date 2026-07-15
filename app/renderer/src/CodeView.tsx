// CodeView — light-theme file viewer with regex syntax highlighting and an
// edit toggle. No external editor dependency: tokenizing covers the languages
// a firmware/robotics project actually contains (C/C++, Python, JS/TS, JSON,
// shell, CMake, device tree, markdown).
import React, { useMemo, useState } from "react";

const KEYWORDS: Record<string, string[]> = {
  c: ["if", "else", "for", "while", "do", "switch", "case", "default", "return", "break", "continue",
    "typedef", "struct", "union", "enum", "static", "const", "volatile", "extern", "inline", "sizeof",
    "void", "int", "char", "long", "short", "float", "double", "unsigned", "signed", "uint8_t",
    "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t", "bool", "goto"],
  py: ["def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
    "import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "break", "continue",
    "lambda", "yield", "global", "nonlocal", "assert", "del", "is", "None", "True", "False", "async", "await", "self"],
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "switch", "case",
    "default", "break", "continue", "class", "extends", "new", "this", "typeof", "instanceof",
    "import", "export", "from", "as", "async", "await", "try", "catch", "finally", "throw",
    "interface", "type", "enum", "implements", "private", "public", "readonly", "null", "undefined", "true", "false"],
  sh: ["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac",
    "function", "return", "exit", "export", "local", "echo", "set", "source"],
};

function langOf(name: string): { kw: string[]; lineComment: string; hashPre: boolean } {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["c", "h", "cpp", "hpp", "cc", "ino", "ld", "dts", "overlay"].includes(ext))
    return { kw: KEYWORDS["c"]!, lineComment: "//", hashPre: true };
  if (["py"].includes(ext)) return { kw: KEYWORDS["py"]!, lineComment: "#", hashPre: false };
  if (["js", "ts", "jsx", "tsx", "json"].includes(ext)) return { kw: KEYWORDS["js"]!, lineComment: "//", hashPre: false };
  if (["sh", "bash", "cmake", "yml", "yaml", "toml", "cfg", "conf", "txt", "mk"].includes(ext) || name === "Makefile" || name === "CMakeLists.txt")
    return { kw: KEYWORDS["sh"]!, lineComment: "#", hashPre: false };
  return { kw: [], lineComment: "//", hashPre: false };
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One-pass tokenizer: comments > strings > preprocessor > numbers > keywords > calls. */
export function highlight(code: string, fileName: string): string {
  const { kw, lineComment, hashPre } = langOf(fileName);
  const kwSet = new Set(kw);
  const lc = lineComment.replace(/\//g, "\\/");
  const re = new RegExp(
    `(${lc}[^\\n]*|/\\*[\\s\\S]*?\\*/)` +        // 1 comment
    `|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')` + // 2 string
    `|(^\\s*#\\s*\\w+)` +                          // 3 preprocessor / shebang-ish
    `|\\b(0[xX][0-9a-fA-F]+|\\d+\\.?\\d*[fFuUlL]*)\\b` + // 4 number
    `|\\b([A-Za-z_][A-Za-z0-9_]*)(?=\\s*\\()` +    // 5 call
    `|\\b([A-Za-z_][A-Za-z0-9_]*)\\b`,             // 6 word
    "gm");
  let out = "";
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;
    const [full, com, str, pre, num, call, word] = m;
    if (com) out += `<span class="tok-com">${esc(com)}</span>`;
    else if (str) out += `<span class="tok-str">${esc(str)}</span>`;
    else if (pre && hashPre) out += `<span class="tok-pre">${esc(pre)}</span>`;
    else if (pre) out += `<span class="tok-com">${esc(pre)}</span>`;
    else if (num) out += `<span class="tok-num">${esc(num)}</span>`;
    else if (call) out += kwSet.has(call) ? `<span class="tok-kw">${esc(call)}</span>` : `<span class="tok-fn">${esc(call)}</span>`;
    else if (word) out += kwSet.has(word) ? `<span class="tok-kw">${esc(word)}</span>` : esc(word);
    else out += esc(full);
  }
  out += esc(code.slice(last));
  return out;
}

export function CodeView({ fileName, content, onSave, maxHeight = 480 }: {
  fileName: string;
  content: string;
  onSave?: (text: string) => void;
  maxHeight?: number;
}): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content);
  // Re-sync draft when a different file is opened.
  const [lastFile, setLastFile] = useState(fileName);
  if (fileName !== lastFile) { setLastFile(fileName); setDraft(content); setEditing(false); }

  const html = useMemo(() => highlight(content.slice(0, 200_000), fileName), [content, fileName]);
  const lines = content.split("\n").length;

  return (
    <div>
      <div className="code-toolbar">
        <span>📄 {fileName}</span>
        <span style={{ color: "var(--grey-2)" }}>·</span>
        <span>{lines} lines</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          {editing && onSave && (
            <button className="ft-btn" onClick={() => { onSave(draft); setEditing(false); }}>💾 Save</button>
          )}
          <button className="ft-btn" onClick={() => { if (!editing) setDraft(content); setEditing(!editing); }}>
            {editing ? "👁 View" : "✎ Edit"}
          </button>
        </span>
      </div>
      {editing ? (
        <textarea className="flux-textarea" style={{ width: "100%", height: Math.min(maxHeight, 20 + lines * 17), display: "block" }}
          value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      ) : (
        <div className="code-view" style={{ maxHeight }} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
