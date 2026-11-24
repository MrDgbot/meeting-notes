import { fmtDur, hm } from "@shared/format";
import type { ProjectStream } from "@shared/types";
import { ChevronRight, FolderKanban, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { SegmentedControl, SkeletonLines } from "@/components/MotionPrimitives";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/appStore";

export function ProjectsPage() {
  const navigate = useAppStore((s) => s.navigate);
  const pushToast = useAppStore((s) => s.pushToast);

  const [days, setDays] = useState<"14" | "30" | "90">("30");
  const [projects, setProjects] = useState<ProjectStream[]>([]);
  const [loading, setLoading] = useState(true);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ projects?: ProjectStream[] }>(`/api/projects?days=${days}&limit=12`);
      setProjects(Array.isArray(res?.projects) ? res.projects : []);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : "加载项目脉络失败", 4000);
    } finally {
      setLoading(false);
    }
  }, [days, pushToast]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  return (
    <div className="max-w-[960px] mx-auto px-5 sm:px-8 py-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.01em] m-0 flex items-center gap-2">
            <FolderKanban className="w-5 h-5 text-[var(--muted)]" aria-hidden="true" />
            <span>项目脉络</span>
          </h1>
          <p className="text-[13.5px] text-[var(--muted)] m-0 mt-1">
            根据标题、标签与高频主题词，自动把散落在不同天里的同一项目讨论串成连续时间线
          </p>
        </div>

        <SegmentedControl
          value={days}
          onChange={setDays}
          options={[
            { value: "14", label: "近 14 天" },
            { value: "30", label: "近 30 天" },
            { value: "90", label: "近 90 天" },
          ]}
          ariaLabel="时间范围"
        />
      </div>

      {loading && !projects.length ? (
        <div className="card-surface p-5">
          <SkeletonLines lines={5} />
        </div>
      ) : !projects.length ? (
        <div className="card-surface py-12 px-6 text-center space-y-1.5">
          <div className="text-sm font-medium text-[var(--text)]">近 {days} 天暂无跨场次项目脉络</div>
          <p className="text-xs text-[var(--muted)] m-0">
            当同一主题或项目关键词在 2 场及以上会议中被提及，这里会自动生成项目卡片与进展时间线。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {projects.map((pr) => (
            <section key={pr.id} className="card-surface p-5 space-y-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold m-0 text-[var(--text)]">{pr.name}</h2>
                    <span className="rounded-full bg-[var(--fill)] px-2.5 py-0.5 text-[11px] text-[var(--text-2)] num">
                      {pr.meeting_count} 场会议 · 累计 {fmtDur(pr.total_s)}
                    </span>
                    {pr.latest_at && (
                      <span className="text-xs text-[var(--muted)] num">
                        最近 {pr.latest_at.slice(0, 10)}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {pr.keywords.map((kw) => (
                      <span
                        key={kw}
                        className="rounded-md bg-[var(--fill)] px-2 py-0.5 text-[11.5px] text-[var(--text-2)]"
                      >
                        #{kw}
                      </span>
                    ))}
                    {pr.participants.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--muted)] ml-1">
                        <Users className="w-3 h-3" aria-hidden="true" />
                        <span>{pr.participants.join("、")}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 border-t border-[var(--line-2)] pt-3">
                {pr.meetings.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => navigate(`#/m/${m.id}`)}
                    className="w-full card-interactive rounded-[9px] px-3 py-2 text-left hover:bg-[var(--fill)] flex items-start justify-between gap-3 cursor-pointer"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[11.5px] text-[var(--muted)] num shrink-0">
                          {m.created.slice(0, 10)} {hm(m.created)}
                        </span>
                        <span className="text-[13.5px] font-medium text-[var(--text)] truncate">
                          {m.title}
                        </span>
                      </div>
                      {m.brief && <div className="text-xs text-[var(--text-2)] truncate">{m.brief}</div>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs text-[var(--muted)] num pt-0.5">
                      {m.has_minutes && (
                        <span className="rounded bg-[var(--fill)] px-1.5 py-0.5 text-[11px] text-[var(--text-2)]">
                          有纪要
                        </span>
                      )}
                      <span>{fmtDur(m.duration)}</span>
                      <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
