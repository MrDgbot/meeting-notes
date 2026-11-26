export interface ParsedTodoItem {
  idx: number;
  done: boolean;
  text: string;
  ts: string;
}

export interface TodoCounts {
  total: number;
  done: number;
}

export type InlineSegment =
  | { type: "text"; value: string }
  | { type: "bold"; children: InlineSegment[] }
  | { type: "code"; value: string }
  | { type: "link"; label: string; href: string }
  | { type: "ts"; label: string };

export interface ListItemNode {
  indent: number;
  ordered: boolean;
  todoIdx: number | null;
  todoDone: boolean;
  lines: InlineSegment[][];
  children: ListNode[];
}

export interface ListNode {
  type: "list";
  ordered: boolean;
  indent: number;
  items: ListItemNode[];
}

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string; inlines: InlineSegment[] }
  | { type: "hr" }
  | { type: "code"; code: string }
  | { type: "table"; headers: InlineSegment[][]; rows: InlineSegment[][][] }
  | { type: "blockquote"; inlines: InlineSegment[] }
  | { type: "paragraph"; lines: InlineSegment[][] }
  | ListNode;

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const TODO_LINE_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](\s+)(.*)$/;
const TS_SINGLE_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?)(?:\s*[,，、]\s*\d{1,2}:\d{2}(?::\d{2})?)*\]/;
const TS_GROUP_RE = /\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,，、]\s*\d{1,2}:\d{2}(?::\d{2})?)*)\]/g;

export function parseInlineSegments(raw: string): InlineSegment[] {
  const s = String(raw ?? "");
  if (!s) return [];
  const out: InlineSegment[] = [];
  // Tokenize inline code first so `**` or `[12:30]` inside backticks stays literal.
  let pos = 0;
  for (const cm of s.matchAll(/`([^`]+)`/g)) {
    const idx = cm.index ?? 0;
    if (idx > pos) {
      pushFormattedText(s.slice(pos, idx), out);
    }
    out.push({ type: "code", value: cm[1] ?? "" });
    pos = idx + cm[0].length;
  }
  if (pos < s.length) {
    pushFormattedText(s.slice(pos), out);
  }
  return out;
}

function pushFormattedText(text: string, out: InlineSegment[]): void {
  let pos = 0;
  for (const bm of text.matchAll(/\*\*(.+?)\*\*/g)) {
    const idx = bm.index ?? 0;
    if (idx > pos) {
      pushLinkAndTimestampText(text.slice(pos, idx), out);
    }
    const inner: InlineSegment[] = [];
    pushLinkAndTimestampText(bm[1] ?? "", inner);
    out.push({ type: "bold", children: inner });
    pos = idx + bm[0].length;
  }
  if (pos < text.length) {
    pushLinkAndTimestampText(text.slice(pos), out);
  }
}

const LINK_OR_URL_RE =
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+)/g;
const TRAILING_URL_PUNCT_RE = /[.,;:!?]+$/;

function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function pushLinkAndTimestampText(text: string, out: InlineSegment[]): void {
  let pos = 0;
  for (const lm of text.matchAll(LINK_OR_URL_RE)) {
    const idx = lm.index ?? 0;
    if (idx > pos) {
      pushTimestampText(text.slice(pos, idx), out);
    }
    const mdLabel = lm[1];
    const mdHref = lm[2];
    const bareRaw = lm[3];
    if (mdLabel !== undefined && mdHref !== undefined) {
      if (isSafeHttpUrl(mdHref)) {
        out.push({ type: "link", label: mdLabel, href: mdHref });
      } else {
        pushTimestampText(lm[0], out);
      }
      pos = idx + lm[0].length;
    } else if (bareRaw !== undefined) {
      const trimmed = bareRaw.replace(TRAILING_URL_PUNCT_RE, "");
      const suffix = bareRaw.slice(trimmed.length);
      if (trimmed && isSafeHttpUrl(trimmed)) {
        out.push({ type: "link", label: trimmed, href: trimmed });
        if (suffix) {
          pushTimestampText(suffix, out);
        }
      } else {
        pushTimestampText(bareRaw, out);
      }
      pos = idx + bareRaw.length;
    }
  }
  if (pos < text.length) {
    pushTimestampText(text.slice(pos), out);
  }
}

function pushTimestampText(text: string, out: InlineSegment[]): void {
  let pos = 0;
  for (const tm of text.matchAll(TS_GROUP_RE)) {
    const idx = tm.index ?? 0;
    if (idx > pos) {
      out.push({ type: "text", value: text.slice(pos, idx) });
    }
    const group = tm[1] ?? "";
    const parts = group.split(/\s*[,，、]\s*/);
    for (const part of parts) {
      if (part) out.push({ type: "ts", label: part });
    }
    pos = idx + tm[0].length;
  }
  if (pos < text.length) {
    out.push({ type: "text", value: text.slice(pos) });
  }
}

function* iterTodoLines(lines: string[]): Generator<{
  lineIdx: number;
  todoIdx: number;
  match: RegExpMatchArray;
  cr: string;
}> {
  let todoIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const cr = raw.endsWith("\r") ? "\r" : "";
    const ln = cr ? raw.slice(0, -1) : raw;
    const fm = ln.match(FENCE_OPEN_RE);
    if (fm) {
      const marker = fm[1] ?? "`";
      const fence = marker[0] ?? "`";
      const minLen = marker.length;
      const closeRe = new RegExp(`^\\s*${fence}{${minLen},}\\s*$`);
      i++;
      while (i < lines.length) {
        const clRaw = lines[i] ?? "";
        const cl = clRaw.endsWith("\r") ? clRaw.slice(0, -1) : clRaw;
        if (closeRe.test(cl)) break;
        i++;
      }
      continue;
    }
    const tm = ln.match(TODO_LINE_RE);
    if (tm) {
      yield { lineIdx: i, todoIdx, match: tm, cr };
      todoIdx++;
    }
  }
}

export function parseMarkdownTodos(rawMd: string): ParsedTodoItem[] {
  const lines = String(rawMd ?? "").split("\n");
  const items: ParsedTodoItem[] = [];
  for (const { todoIdx, match } of iterTodoLines(lines)) {
    const mark = (match[2] ?? "").trim().toLowerCase();
    const text = (match[4] ?? "").trim();
    const tsM = text.match(TS_SINGLE_RE);
    items.push({
      idx: todoIdx,
      done: mark === "x",
      text,
      ts: tsM ? (tsM[1] ?? "") : "",
    });
  }
  return items;
}

export function countMarkdownTodos(rawMd: string): TodoCounts {
  const items = parseMarkdownTodos(rawMd);
  let done = 0;
  for (const it of items) {
    if (it.done) done++;
  }
  return { total: items.length, done };
}

export function toggleMarkdownTodo(rawMd: string, todoIdx: number, checked: boolean): string {
  const src = String(rawMd ?? "");
  if (!Number.isInteger(todoIdx) || todoIdx < 0) return src;
  const lines = src.split("\n");
  for (const { lineIdx, todoIdx: idx, match, cr } of iterTodoLines(lines)) {
    if (idx === todoIdx) {
      const mark = checked ? "x" : " ";
      lines[lineIdx] = `${match[1] ?? ""}[${mark}]${match[3] ?? ""}${match[4] ?? ""}${cr}`;
      return lines.join("\n");
    }
  }
  return src;
}

export function parseMarkdownBlocks(
  rawMd: string,
  opts: { interactiveTodo?: boolean } = {},
): MarkdownBlock[] {
  const interactiveTodo = Boolean(opts.interactiveTodo);
  const lines = String(rawMd ?? "")
    .replace(/\r/g, "")
    .split("\n");
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  const stack: ListNode[] = [];
  let todoIdx = 0;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", lines: para.map(parseInlineSegments) });
      para = [];
    }
  };

  const closeLists = (minIndent = -1) => {
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!top || top.indent <= minIndent) break;
      stack.pop();
    }
  };

  const attachList = (list: ListNode) => {
    const parentList = stack[stack.length - 1];
    if (parentList && parentList.items.length > 0) {
      const parentItem = parentList.items[parentList.items.length - 1];
      parentItem?.children.push(list);
    } else {
      blocks.push(list);
    }
    stack.push(list);
  };

  const splitTableCells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    const fm = ln.match(FENCE_OPEN_RE);
    if (fm) {
      flushPara();
      closeLists();
      const marker = fm[1] ?? "`";
      const fence = marker[0] ?? "`";
      const closeRe = new RegExp(`^\\s*${fence}{${marker.length},}\\s*$`);
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !closeRe.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ type: "code", code: codeLines.join("\n") });
      continue;
    }

    if (/^\s*$/.test(ln)) {
      flushPara();
      continue;
    }

    const hm = ln.match(/^(#{1,4})\s+(.*)$/);
    if (hm) {
      flushPara();
      closeLists();
      const level = Math.min(4, Math.max(1, (hm[1] ?? "#").length)) as 1 | 2 | 3 | 4;
      const text = hm[2] ?? "";
      blocks.push({ type: "heading", level, text, inlines: parseInlineSegments(text) });
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) {
      flushPara();
      closeLists();
      blocks.push({ type: "hr" });
      continue;
    }

    const nextLn = lines[i + 1];
    if (/^\s*\|/.test(ln) && nextLn !== undefined && /^\s*\|?\s*:?-{2,}/.test(nextLn)) {
      flushPara();
      closeLists();
      const headers = splitTableCells(ln).map(parseInlineSegments);
      const rows: InlineSegment[][][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) {
        rows.push(splitTableCells(lines[i] ?? "").map(parseInlineSegments));
        i++;
      }
      i--;
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const lm = ln.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (lm) {
      flushPara();
      const indent = (lm[1] ?? "").replace(/\t/g, "  ").length;
      const ordered = /\d/.test(lm[2] ?? "");
      const tm = interactiveTodo ? ln.match(TODO_LINE_RE) : null;
      let itemLines: InlineSegment[][];
      let itemTodoIdx: number | null = null;
      let itemTodoDone = false;
      if (tm) {
        itemTodoIdx = todoIdx++;
        itemTodoDone = Boolean((tm[2] ?? "").trim());
        itemLines = [parseInlineSegments(tm[4] ?? "")];
      } else {
        const body = lm[3] ?? "";
        const staticTodo = body.match(/^\[( |x|X)\]\s*(.*)$/);
        if (staticTodo) {
          itemTodoIdx = -1;
          itemTodoDone = Boolean((staticTodo[1] ?? "").trim());
          itemLines = [parseInlineSegments(staticTodo[2] ?? "")];
        } else {
          itemLines = [parseInlineSegments(body)];
        }
      }

      const itemNode: ListItemNode = {
        indent,
        ordered,
        todoIdx: itemTodoIdx,
        todoDone: itemTodoDone,
        lines: itemLines,
        children: [],
      };

      const top = stack[stack.length - 1];
      if (!top || indent > top.indent) {
        const list: ListNode = { type: "list", ordered, indent, items: [itemNode] };
        attachList(list);
      } else {
        closeLists(indent);
        const aligned = stack[stack.length - 1];
        if (aligned && aligned.indent === indent && aligned.ordered === ordered) {
          aligned.items.push(itemNode);
        } else {
          if (aligned && aligned.indent === indent) stack.pop();
          const list: ListNode = { type: "list", ordered, indent, items: [itemNode] };
          attachList(list);
        }
      }
      continue;
    }

    const bq = ln.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara();
      closeLists();
      blocks.push({ type: "blockquote", inlines: parseInlineSegments(bq[1] ?? "") });
      continue;
    }

    if (stack.length > 0 && /^\s{2,}\S/.test(ln)) {
      const top = stack[stack.length - 1];
      const lastItem = top?.items[top.items.length - 1];
      if (lastItem) {
        lastItem.lines.push(parseInlineSegments(ln.trim()));
        continue;
      }
    }

    closeLists();
    para.push(ln);
  }

  flushPara();
  closeLists();
  return blocks;
}
