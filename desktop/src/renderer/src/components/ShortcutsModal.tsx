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
      maxWidthClass="max-w-lg"
      panelClassName="border border-[var(--line)] p-5"
    >
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-[var(--line-2)]">
        <h2 className="text-base font-semibold m-0">键盘快捷键</h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭快捷键说明"
          className="btn-ghost rounded-lg w-7 h-7 flex items-center justify-center cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-4 space-y-4 max-h-[68vh] overflow-y-auto pr-1">
        {sections.map((sec) => (
          <div key={sec.title}>
            <h3 className="text-xs font-semibold text-[var(--muted)] m-0 mb-2">{sec.title}</h3>
            <div className="space-y-1.5">
              {sec.items.map((it) => (
                <div key={it.key} className="flex items-center justify-between gap-4 py-1 text-[13px]">
                  <span className="text-[var(--text-body)]">{it.desc}</span>
                  <kbd className="font-mono text-xs px-2 py-0.5 rounded-md bg-[var(--fill)] border border-[var(--line-2)] text-[var(--text)] shrink-0">
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
