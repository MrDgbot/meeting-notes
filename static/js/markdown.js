// 轻量 Markdown 渲染（支持围栏代码块、ul/ol 同缩进切换、表格、交互式待办复选框与可点时间戳）
import { esc } from "./utils.js";

const TS_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,，、]\s*\d{1,2}:\d{2}(?::\d{2})?)*)\]/g;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const TODO_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s+)(.*)$/;

export function inline(s) {
  const escaped = esc(s);
  // 先保护行内代码，避免反引号里的 ** 或 [12:30] 被误解析
  const codes = [];
  const withPlaceholders = escaped.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codes.length;
    codes.push(`<code>${code}</code>`);
    return `\x00C${idx}\x00`;
  });
  const formatted = withPlaceholders
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    // [12:30] 和 [12:30, 13:05]（有的模型把几处出处写在一个括号里）都拆成一个个能点的时间
    .replace(TS_RE, (_, g) => g.split(/\s*[,，、]\s*/).map(t => `<a class="ts" data-ts="${t}">[${t}]</a>`).join(""));
  return codes.length ? formatted.replace(/\x00C(\d+)\x00/g, (_, i) => codes[+i]) : formatted;
}

export function toggleMarkdownTodo(rawMd, todoIdx, checked) {
  const src = String(rawMd ?? "");
  if (!Number.isInteger(todoIdx) || todoIdx < 0) return src;
  const lines = src.split("\n");
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const cr = raw.endsWith("\r") ? "\r" : "";
    const ln = cr ? raw.slice(0, -1) : raw;
    const fm = ln.match(FENCE_OPEN_RE);
    if (fm) {
      const fence = fm[1][0], minLen = fm[1].length;
      const closeRe = new RegExp(`^\\s*${fence}{${minLen},}\\s*$`);
      i++;
      while (i < lines.length) {
        const cl = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
        if (closeRe.test(cl)) break;
        i++;
      }
      continue;
    }
    const tm = ln.match(TODO_LINE_RE);
    if (tm) {
      if (idx === todoIdx) {
        lines[i] = `${tm[1]}[${checked ? "x" : " "}]${tm[3]}${tm[4]}${cr}`;
        return lines.join("\n");
      }
      idx++;
    }
  }
  return src;
}

export function countMarkdownTodos(rawMd) {
  const lines = String(rawMd ?? "").replace(/\r/g, "").split("\n");
  let total = 0, done = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const fm = ln.match(FENCE_OPEN_RE);
    if (fm) {
      const fence = fm[1][0], minLen = fm[1].length;
      const closeRe = new RegExp(`^\\s*${fence}{${minLen},}\\s*$`);
      i++;
      while (i < lines.length && !closeRe.test(lines[i])) i++;
      continue;
    }
    const tm = ln.match(TODO_LINE_RE);
    if (tm) {
      total++;
      if (tm[2].trim()) done++;
    }
  }
  return { total, done };
}

export function md(src, opts = {}) {
  const interactiveTodo = !!(opts && opts.interactiveTodo);
  const L = (src || "").replace(/\r/g, "").split("\n");
  let html = "", para = [], stack = [], todoIdx = 0;
  const flushP = () => { if (para.length) { html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const closeLists = (lvl = -1) => {
    while (stack.length && stack[stack.length - 1].indent > lvl) html += `</li></${stack.pop().tag}>`;
  };
  for (let i = 0; i < L.length; i++) {
    const ln = L[i];
    let m;
    // 围栏代码块（``` 或 ~~~）
    if ((m = ln.match(FENCE_OPEN_RE))) {
      flushP(); closeLists();
      const fence = m[1][0], minLen = m[1].length;
      const closeRe = new RegExp(`^\\s*${fence}{${minLen},}\\s*$`);
      const codeLines = [];
      i++;
      while (i < L.length && !closeRe.test(L[i])) { codeLines.push(L[i]); i++; }
      html += `<pre><code>${esc(codeLines.join("\n"))}</code></pre>`;
      continue;
    }
    if (/^\s*$/.test(ln)) { flushP(); continue; }
    if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { flushP(); closeLists(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) { flushP(); closeLists(); html += "<hr>"; continue; }
    if (/^\s*\|/.test(ln) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1])) {
      flushP(); closeLists();
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      html += "<table><thead><tr>" + cells(ln).map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < L.length && /^\s*\|/.test(L[i])) { html += "<tr>" + cells(L[i]).map(c => `<td>${inline(c)}</td>`).join("") + "</tr>"; i++; }
      i--; html += "</tbody></table>"; continue;
    }
    if ((m = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      flushP();
      const indent = m[1].replace(/\t/g, "  ").length, tag = /\d/.test(m[2]) ? "ol" : "ul";
      const tm = interactiveTodo ? ln.match(TODO_LINE_RE) : null;
      const todoChecked = tm ? !!tm[2].trim() : false;
      const liOpen = tm ? `<li class="todo-item${todoChecked ? " todo-done" : ""}">` : "<li>";
      const top = stack[stack.length - 1];
      if (!top || indent > top.indent) {
        html += `<${tag}>${liOpen}`; stack.push({ indent, tag });
      } else {
        closeLists(indent);
        const t2 = stack[stack.length - 1];
        if (t2 && t2.indent === indent && t2.tag === tag) {
          html += `</li>${liOpen}`;
        } else {
          if (t2 && t2.indent === indent) html += `</li></${stack.pop().tag}>`;
          html += `<${tag}>${liOpen}`; stack.push({ indent, tag });
        }
      }
      if (tm) {
        const idx = todoIdx++;
        html += `<input type="checkbox" class="cb" data-todo-idx="${idx}" aria-label="切换待办完成状态" ${todoChecked ? "checked" : ""}><span class="todo-txt">${inline(tm[4])}</span>`;
      } else {
        html += inline(m[3]).replace(/^\[( |x|X)\]\s*/, (_, c) => `<input type="checkbox" class="cb" disabled ${c.trim() ? "checked" : ""}>`);
      }
      continue;
    }
    if ((m = ln.match(/^>\s?(.*)$/))) { flushP(); closeLists(); html += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
    if (stack.length && /^\s{2,}\S/.test(ln)) { html += "<br>" + inline(ln.trim()); continue; }
    closeLists(); para.push(ln);
  }
  flushP(); closeLists();
  return html;
}
