import { Radio, X } from "lucide-react";
import { ModalShell } from "@/components/MotionPrimitives";
import { useAppStore } from "@/stores/appStore";

export function AmbientIntroModal() {
  const open = useAppStore((s) => s.ambientIntroOpen);
  const setOpen = useAppStore((s) => s.setAmbientIntroOpen);
  const runAmbientAction = useAppStore((s) => s.runAmbientAction);

  return (
    <ModalShell
      open={open}
      onClose={() => setOpen(false)}
      label="开启全天模式"
      maxWidthClass="max-w-md"
      panelClassName="border border-[var(--line)] p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-[var(--fill)] flex items-center justify-center">
            <Radio className="w-5 h-5 text-[var(--green)]" />
          </div>
          <div>
            <h2 className="text-base font-semibold m-0">开启全天自动记录？</h2>
            <p className="text-xs text-[var(--muted)] m-0">随时开口，自动按停顿分段</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="关闭窗口"
          className="btn-ghost rounded-lg w-7 h-7 flex items-center justify-center cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <ul className="mt-4 space-y-2 text-[13px] text-[var(--text-body)] pl-4 list-disc">
        <li>仅用本机麦克风在本地监听，有人说话时边说边转写；安静几分钟后自动整理为一条记录。</li>
        <li>太短的偶发杂音不会堆进主列表，需要时可在左侧卡里随时找回。</li>
        <li>可随时暂停 30 分钟、手动结束当前对话，或到「设置 → 全天模式」调整灵敏度。</li>
      </ul>

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn-secondary rounded-lg px-3.5 py-1.5 text-sm cursor-pointer"
        >
          先不开
        </button>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem("ambSeen", "1");
            } catch {}
            setOpen(false);
            void runAmbientAction({ action: "start" });
          }}
          className="btn-primary rounded-lg px-3.5 py-1.5 text-sm cursor-pointer"
        >
          开启全天模式
        </button>
      </div>
    </ModalShell>
  );
}
