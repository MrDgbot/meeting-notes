import { X } from "lucide-react";
import { ModalShell } from "@/components/MotionPrimitives";
import { useAppStore } from "@/stores/appStore";

export function ShortcutsModal() {
  const open = useAppStore((s) => s.shortcutsOpen);
  const setOpen = useAppStore((s) => s.setShortcutsOpen);
  const desktopInfo = useAppStore((s) => s.desktopInfo);

  const isMac = desktopInfo ? desktopInfo.platform === "darwin" : /Mac/i.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl+";
  const shift = isMac ? "⇧" : "Shift+";
  const alt = isMac ? "⌥" : "Alt+";

  const sections = [
    {
      title: "全局热键（任意应用前台均可使用）",
      items: [
        { key: `${mod}${shift}Space`, desc: "呼出 / 收起全局闪问浮窗，跨所有会议即时检索与试听" },
        { key: `${mod}${shift}M`, desc: "在当前进行中的会议或全天录音中立即打点" },
        { key: `${mod}${alt}${shift}N`, desc: "呼出主窗口并跳转到开始新会议页面" },
      ],
    },
    {
      title: "全局与导航",
      items: [
        { key: `${mod}K`, desc: "打开命令面板，快速搜索会议与功能" },
        { key: `${mod}\\`, desc: "收起或展开左侧边栏" },
        { key: `${mod},`, desc: "打开设置" },
        { key: "?", desc: "打开 / 关闭此快捷键说明" },
      ],
    },
    {
      title: "录音控制",
      items: [{ key: "M", desc: "录音过程中快速给当前时刻打个点" }],
    },
    {
      title: "回放与校对",
      items: [
        { key: "Space", desc: "播放 / 暂停音频" },
        { key: "← / →", desc: "后退 / 前进 5 秒" },
        { key: "[ / ]", desc: "降低 / 提高播放速度" },
      ],
    },
  ];

  return (
    <ModalShell
      open={open}
      onClose={() => setOpen(false)}
      label="键盘快捷键"
      maxWidthClass="max-w-xl"
      backdropClassName="bg-[var(--backdrop)] backdrop-blur-[4px]"
      panelClassName="max-h-[85vh] rounded-[16px] bg-[var(--surface-elev)] shadow-[var(--shadow-3)] flex flex-col"
    >
      <div className="px-6 py-4 border-b border-[var(--line-2)] flex items-center justify-between gap-3 shrink-0">
        <h2 className="text-base leading-[24px] font-semibold text-[var(--text)] whitespace-nowrap m-0">
          键盘快捷键
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭快捷键说明"
          className="btn-ghost rounded-[8px] w-8 h-8 flex items-center justify-center cursor-pointer shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {sections.map((sec) => (
          <div key={sec.title}>
            <h3 className="text-xs leading-[18px] font-medium text-[var(--muted)] m-0 mb-2">{sec.title}</h3>
            <div className="rounded-[12px] border border-[var(--line-2)] bg-[var(--surface)] divide-y divide-[var(--line-2)] px-4">
              {sec.items.map((it) => (
                <div
                  key={it.key}
                  className="flex items-center justify-between gap-4 py-2.5 text-sm leading-[22px]"
                >
                  <span className="text-[var(--text-body)]">{it.desc}</span>
                  <kbd className="font-mono text-[11px] leading-[14px] font-medium px-2 py-1 rounded-[6px] bg-[var(--fill)] border border-[var(--line)] text-[var(--text)] whitespace-nowrap shrink-0">
                    {it.key}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
