import { isShortClip, tsToSec } from "@shared/format";
import { type InlineSegment, type ListNode, type MarkdownBlock, parseMarkdownBlocks } from "@shared/markdown";
import { Fragment } from "react";

interface MarkdownViewProps {
  markdown: string;
  interactiveTodo?: boolean;
  onSeekSec?: (sec: number) => void;
  onToggleTodo?: (todoIdx: number, checked: boolean) => void;
  className?: string;
}

function renderInlines(segments: InlineSegment[], keyPrefix: string, onSeekSec?: (sec: number) => void) {
  return segments.map((seg, idx) => {
    const k = `${keyPrefix}-${idx}`;
    if (seg.type === "text") {
      return <Fragment key={k}>{seg.value}</Fragment>;
    }
    if (seg.type === "code") {
      return <code key={k}>{seg.value}</code>;
    }
    if (seg.type === "bold") {
      return <strong key={k}>{renderInlines(seg.children, k, onSeekSec)}</strong>;
    }
    if (seg.type === "ts") {
      if (!onSeekSec) {
        return (
          <span
            key={k}
            className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded bg-[var(--fill)] text-[var(--text-2)] font-mono text-[11.5px] num align-baseline"
          >
            {seg.label}
          </span>
        );
      }
      return (
        <button
          key={k}
          type="button"
          onClick={() => onSeekSec(tsToSec(seg.label))}
          className="inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded bg-[var(--fill)] hover:bg-[var(--fill-2)] text-[var(--link)] font-mono text-[11.5px] num cursor-pointer align-baseline"
          title={`跳到 ${seg.label} 播放`}
        >
          {seg.label}
        </button>
      );
    }
    return null;
  });
}

function renderList(
  node: ListNode,
  keyPrefix: string,
  interactiveTodo: boolean,
  onSeekSec?: (sec: number) => void,
  onToggleTodo?: (todoIdx: number, checked: boolean) => void,
) {
  const Tag = node.ordered ? "ol" : "ul";
  return (
    <Tag key={keyPrefix} className="space-y-1">
      {node.items.map((item, idx) => {
        const itemKey = `${keyPrefix}-${idx}`;
        const isTodo = item.todoIdx !== null;
        return (
          <li
            key={itemKey}
            className={`${isTodo ? "list-none -ml-4 flex items-start gap-2" : ""} ${
              isTodo && item.todoDone ? "line-through text-[var(--muted)]" : ""
            }`}
          >
            {isTodo && item.todoIdx !== null && (
              <input
                type="checkbox"
                checked={item.todoDone}
                disabled={!interactiveTodo}
                onChange={(e) => {
                  if (item.todoIdx !== null) {
                    onToggleTodo?.(item.todoIdx, e.target.checked);
                  }
                }}
                aria-label="完成待办"
                className={`mt-1 w-3.5 h-3.5 shrink-0 ${interactiveTodo ? "cursor-pointer" : "cursor-default"}`}
              />
            )}
            <div className="flex-1 min-w-0">
              {item.lines.map((lineSegs, li) => (
                <div key={`${itemKey}-l${li}`}>{renderInlines(lineSegs, `${itemKey}-l${li}`, onSeekSec)}</div>
              ))}
              {item.children.map((childList, ci) =>
                renderList(childList, `${itemKey}-c${ci}`, interactiveTodo, onSeekSec, onToggleTodo),
              )}
            </div>
          </li>
        );
      })}
    </Tag>
  );
}

function renderBlock(
  block: MarkdownBlock,
  idx: number,
  interactiveTodo: boolean,
  onSeekSec?: (sec: number) => void,
  onToggleTodo?: (todoIdx: number, checked: boolean) => void,
) {
  const k = `b-${idx}`;
  switch (block.type) {
    case "heading": {
      if (block.level === 1) return <h1 key={k}>{renderInlines(block.inlines, k, onSeekSec)}</h1>;
      if (block.level === 2) return <h2 key={k}>{renderInlines(block.inlines, k, onSeekSec)}</h2>;
      if (block.level === 3) return <h3 key={k}>{renderInlines(block.inlines, k, onSeekSec)}</h3>;
      return <h4 key={k}>{renderInlines(block.inlines, k, onSeekSec)}</h4>;
    }
    case "hr":
      return <hr key={k} className="my-3 border-[var(--line-2)]" />;
    case "code":
      return (
        <pre key={k}>
          <code>{block.code}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={k}>{renderInlines(block.inlines, k, onSeekSec)}</blockquote>;
    case "paragraph":
      return (
        <p key={k}>
          {block.lines.map((line, li) => (
            <Fragment key={`${k}-p${li}`}>
              {li > 0 && <br />}
              {renderInlines(line, `${k}-p${li}`, onSeekSec)}
            </Fragment>
          ))}
        </p>
      );
    case "table":
      return (
        <div key={k} className="overflow-x-auto my-2">
          <table>
            <thead>
              <tr>
                {block.headers.map((cell, ci) => (
                  <th key={`${k}-th-${ci}`}>{renderInlines(cell, `${k}-th-${ci}`, onSeekSec)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={`${k}-tr-${ri}`}>
                  {row.map((cell, ci) => (
                    <td key={`${k}-td-${ri}-${ci}`}>
                      {renderInlines(cell, `${k}-td-${ri}-${ci}`, onSeekSec)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list":
      return renderList(block, k, interactiveTodo, onSeekSec, onToggleTodo);
  }
}

export function MarkdownView({
  markdown,
  interactiveTodo = false,
  onSeekSec,
  onToggleTodo,
  className = "",
}: MarkdownViewProps) {
  const blocks = parseMarkdownBlocks(markdown, { interactiveTodo });
  return (
    <div className={`md-prose ${className}`}>
      {blocks.map((block, idx) => renderBlock(block, idx, interactiveTodo, onSeekSec, onToggleTodo))}
    </div>
  );
}

export { isShortClip };
