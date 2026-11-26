import { describe, expect, it } from "vitest";
import {
  countMarkdownTodos,
  parseInlineSegments,
  parseMarkdownBlocks,
  parseMarkdownTodos,
  toggleMarkdownTodo,
} from "../markdown";

describe("shared markdown todo parity with Python relations.py", () => {
  const fixture = [
    "## 待办",
    "- [ ] 第一条 [12:30, 13:05]",
    "```markdown",
    "- [ ] 围栏里不算",
    "```",
    "~~~",
    "1. [x] 波浪围栏也不算",
    "~~~",
    "1. [X] 第二条已完成 [01:02:03]",
    "  * [ ] 第三条子项",
    "",
  ].join("\n");

  it("skips backtick and tilde fences and parses CRLF consistently", () => {
    const crlf = fixture.replace(/\n/g, "\r\n");
    const items = parseMarkdownTodos(crlf);
    expect(items).toHaveLength(3);
    expect(items.map((x) => x.done)).toEqual([false, true, false]);
    expect(items[0]?.ts).toBe("12:30");
    expect(items[1]?.ts).toBe("01:02:03");
    expect(countMarkdownTodos(crlf)).toEqual({ total: 3, done: 1 });
  });

  it("toggles target todo without corrupting CRLF or fenced code", () => {
    const crlf = "## 待办\r\n- [ ] 任务一\r\n```md\r\n- [ ] 保持不变\r\n```\r\n- [x] 任务二\r\n";
    const toggled0 = toggleMarkdownTodo(crlf, 0, true);
    expect(toggled0).toContain("- [x] 任务一\r\n");
    expect(toggled0).toContain("```md\r\n- [ ] 保持不变\r\n```");

    const toggled1 = toggleMarkdownTodo(toggled0, 1, false);
    expect(toggled1).toContain("- [ ] 任务二\r\n");
  });

  it("splits multi-timestamps outside backtick code spans", () => {
    const segs = parseInlineSegments("请核对 `[00:10]` 与 **[12:30, 13:05]** 及 [14:00]");
    const flattenTs = (list: ReturnType<typeof parseInlineSegments>): string[] =>
      list.flatMap((s) => (s.type === "ts" ? [s.label] : s.type === "bold" ? flattenTs(s.children) : []));
    const tsLabels = flattenTs(segs);
    const codeVals = segs.filter((s) => s.type === "code").map((s) => s.value);
    expect(tsLabels).toEqual(["12:30", "13:05", "14:00"]);
    expect(codeVals).toEqual(["[00:10]"]);
  });

  it("builds safe AST blocks for headings, tables, code fences, and interactive todos", () => {
    const doc = [
      "# 周会纪要",
      "",
      "| 议题 | 负责人 |",
      "| --- | --- |",
      "| 权限 | 张三 |",
      "",
      "- [ ] 跟进 [05:10]",
    ].join("\n");
    const blocks = parseMarkdownBlocks(doc, { interactiveTodo: true });
    expect(blocks.map((b) => b.type)).toEqual(["heading", "table", "list"]);
    const list = blocks[2];
    expect(list?.type).toBe("list");
    if (list?.type === "list") {
      expect(list.items[0]?.todoIdx).toBe(0);
      expect(list.items[0]?.todoDone).toBe(false);
    }
  });

  it("parses markdown links and bare URLs safely while ignoring code spans", () => {
    const segs = parseInlineSegments(
      "查看 [更新日志](https://github.com/MrDgbot/meeting-notes/blob/v0.1.1/CHANGELOG.md)，或访问 https://github.com/MrDgbot/meeting-notes。忽略 `[文档](https://example.com)` 与 [bad](javascript:alert(1))",
    );
    const links = segs.filter((s) => s.type === "link");
    expect(links).toEqual([
      {
        type: "link",
        label: "更新日志",
        href: "https://github.com/MrDgbot/meeting-notes/blob/v0.1.1/CHANGELOG.md",
      },
      {
        type: "link",
        label: "https://github.com/MrDgbot/meeting-notes",
        href: "https://github.com/MrDgbot/meeting-notes",
      },
    ]);
    const codeVals = segs.filter((s) => s.type === "code").map((s) => s.value);
    expect(codeVals).toEqual(["[文档](https://example.com)"]);
  });
});
