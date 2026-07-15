// mdlite — minimal markdown → HTML shared by the pet chat and asset wiki view.
// Code blocks, inline code, bold, headers, lists. No external deps.
export function mdLite(src: string): string {
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = src.split(/```/);
  let html = "";
  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 1) { // code block
      const body = blocks[i]!.replace(/^\w*\n/, "");
      html += `<pre class="pet-code">${esc(body)}</pre>`;
      continue;
    }
    let t = esc(blocks[i]!);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/^### (.*)$/gm, "<b>$1</b>");
    t = t.replace(/^## (.*)$/gm, "<b>$1</b>");
    t = t.replace(/^# (.*)$/gm, "<b>$1</b>");
    t = t.replace(/^[-*] (.*)$/gm, "• $1");
    t = t.replace(/\n/g, "<br/>");
    html += t;
  }
  return html;
}
