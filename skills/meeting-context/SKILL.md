---
name: meeting-context
description: >-
  Gather, verify, and synthesize local meeting context from the meeting-notes MCP v2 server.
  Use whenever the user asks about meeting notes, past discussions, pre-meeting prep, topic
  timelines, speaker/person history, open commitments, action items/todos, active projects,
  daily summaries, or weekly reviews (会议记录、会议上下文、历史讨论、会前简报、专题脉络复盘、
  人物交集与跟进、口头承诺、待办闭环、活跃项目、日报、周度复盘).
---

# Meeting Context (`meeting-context`)

本技能用于指导外部 AI 助手（Antigravity、Claude Code、Cursor、Codex 等）通过本机只读 `meeting-notes` MCP v2 服务，高效检索、交叉核验并结构化整理用户的历史会议记忆。

## 可用 MCP v2 能力一览

### 11 个只读 Tools

| 工具 | 核心参数 | 典型用途 |
|---|---|---|
| `build_context_pack` | `query?`, `person?`, `days=30` (`0` 不限天数), `max_chars=12000` | **首选入口**：一次调用打包命中会议、高相关带 `[MM:SS]` 原文引证、关联项目、未闭环承诺、待办与近期日报/周报摘要 |
| `list_meetings` | `limit=20`, `kind="all"\|"meeting"\|"ambient"\|"upload"` | 按时间倒序浏览最近会议或全天录音元信息（含摘要、标签与发言人） |
| `search_meetings` | `query`, `limit=10` | 跨标题、摘要/标签、AI 纪要、用户笔记与转写稿进行分词相关性评分与关键词检索，返回命中片段与时间戳 |
| `get_meeting` | `mid`, `include_transcript=true`, `max_chars=24000` | 读取单场会议完整纪要、用户笔记、打点及带时间戳/说话人的转写原文 |
| `get_related_meetings` | `mid`, `limit=5` | 基于共同参会人与高频主题词查找同脉络关联会议 |
| `get_person_history` | `name?` | 查询某位发言人的历史会议、共同参会人、高频议题与待办（留空返回全部人物列表） |
| `list_todos` | `status="open"\|"done"\|"all"`, `person=""`, `limit=100` | 聚合全部会议纪要中的待办事项（含来源会议与时间戳） |
| `list_projects` | `days=30` (`0` 不限天数), `limit=12` | 列出近期活跃项目/专题聚类及关联会议 |
| `list_commitments` | `status="open"\|"done"\|"all"`, `days=14` (`0` 不限天数), `person=""` | 追踪跨会口头承诺与未闭环交付项 |
| `get_daily_summary` | `date=""` | 读取指定日期（默认今天或最近有记录的一天）的日报摘要与当日会议 |
| `get_weekly_digest` | `end_date=""` | 汇总 `end_date` 所在自然周（周一至周日，留空默认本周）的会议、每日总结、待办、口头承诺与已保存周报 |

### 4 个内置 Prompts

- `pre-meeting-brief`（`topic` 必填，`person` / `days` 可选）：会前简报
- `topic-deep-dive`（`topic` 必填，`days` 可选）：专题脉络复盘
- `person-sync-prep`（`person` 必填，`days` 可选）：人物交集与跟进准备
- `weekly-context-review`（`end_date` 可选）：周度上下文复盘

### 4 个只读 Resources

- `meeting://recent`：近期会议速览（JSON）
- `meeting://commitments/open`：当前未闭环承诺清单（JSON）
- `meeting://todos/open`：当前未完成待办清单（JSON）
- `meeting://projects/active`：近期活跃项目/专题清单（JSON）

---

## 标准执行流程（Mandatory Workflow）

### 第 1 步：先广后深——优先单次调用 `build_context_pack`

不要一上来就循环 `list_meetings` + 逐场 `get_meeting`。除纯概览查询可直接读 MCP Resources 外，一律先调用：

```text
build_context_pack(query="<主题/关键词>", person="<相关人名>", days=<时间窗口>, max_chars=12000)
```

- 仅问某个人：传 `person`（可省略 `query`）。
- 仅问某个项目/专题：传 `query`（可按需拉长 `days` 至 60 / 90，或传 `days=0` 表示不限时间回溯全部历史）。
- 两者皆有（如“明天和张三聊 Workday”）：同时传 `query` 和 `person`。
- 仅问“最近有什么未完成待办/承诺”：可直接读取 `meeting://todos/open`、`meeting://commitments/open` 或直接调用 `list_todos` / `list_commitments`。

### 第 2 步：按用户目标交叉补齐上下文

根据问题类型，在 `build_context_pack` 结果基础上补充 1–3 个定向工具调用：

- **会前简报**：补充 `list_commitments(status="open", person=...)`、`list_todos(status="open", person=...)`；若明确了参会人，加查 `get_person_history(name=...)`；若发现关键前置会议，用 `get_related_meetings(mid)` 查上下游。
- **专题脉络复盘**：补充 `search_meetings(query=..., limit=10)` 和 `list_projects(days=...)` 补全长尾会议；对关键里程碑会议调用 `get_related_meetings(mid)` 串联演进链条。
- **人物交集与跟进**：主查 `get_person_history(name=...)` + `build_context_pack(person=...)` + `list_commitments(status="all", person=...)` + `list_todos(status="all", person=...)`；若人名不确定，先调用 `get_person_history()` 获取精确具名列表。
- **日报 / 周度复盘**：主查 `get_weekly_digest(end_date=...)`（或 `get_daily_summary(date=...)`），交叉 `list_commitments(status="open")`、`list_todos(status="open")` 和 `list_projects(days=14)` 识别停滞项与跨周延续风险。

### 第 3 步：关键结论必须下钻原话（Verbatim Verification）

当出现以下情况时，**必须**对最关键的 1–3 场会议调用 `get_meeting(mid, include_transcript=true)` 核验转写原文，禁止只凭摘要臆断：

1. 涉及明确拍板结论、关键数字、截止日期、预算或责任人归属；
2. 不同会议的摘要口径存在冲突或演进变化；
3. 需要引用当事人的原始表态来支撑判断。

若需要快速排查多场候选会议，可先调用 `get_meeting(mid, include_transcript=false)` 看纪要与打点，再对高价值场次拉取转写原文。

### 第 4 步：强制引证格式与事实分级

1. **原话引证格式（必须遵守）**：
   每条关键结论、承诺、数据或分歧都必须附带可溯源引用：
   - 转写原话：`《会议标题》[YYYY-MM-DD MM:SS] 说话人`
     示例：`《Q4 商业化评审》[2026-11-18 14:22] 张三：“先灰度 10% 流量，11 月 25 日复盘留存。”`
   - 若引自会议纪要/用户笔记且无段落时间戳，显式标注为：`《会议标题》[YYYY-MM-DD 纪要]`。
   - 若转写中为未具名说话人（如 `说话人1`），如实保留，不得自行猜测真实姓名。

2. **严格区分四类信息（严禁混为一谈）**：
   - **已拍板结论（Confirmed Decisions）**：会议中明确达成共识或决策人确认的事项，附原话证据。
   - **未闭环承诺与待办（Open Commitments & Action Items）**：明确列出负责人、承诺内容、期望时间、来源会议与当前状态（`open` / 逾期 / 反复提及未落地）。
   - **未决分歧与风险（Open Questions / Risks）**：尚未拍板的争议、前后会议口径漂移、缺少负责人或截止时间的悬空项。
   - **证据缺口（Gaps / Excluded）**：本地记录中未找到依据时明确说明“现有会议记录未提及”；如果服务以 `--exclude-private` 启动，提醒用户相关内容可能位于已跳过的「隐私会议」中。

3. **只读边界**：
   `meeting-notes` MCP Server 为纯本机只读服务。严禁宣称自己已修改、勾选或删除任何会议记录、待办或承诺。

---

## 4 大核心场景输出模板

### 场景 1：会前简报（Pre-Meeting Brief / `pre-meeting-brief`）

**推荐调用顺序**：`build_context_pack(query, person, days=30)` → `list_commitments(status="open", person)` + `list_todos(status="open", person)` →（可选）`get_person_history(person)` → 对最近 1–2 场核心会议 `get_meeting(mid)` 核验原话。

```markdown
## 会前简报：<会议主题 / 对方姓名>

### 1. 背景与上次进展（最近 N 天）
- **当前状态**：<1–3 句概括最新推进到哪一步>
- **关联项目 / 历史场次**：<列出 2–5 场最相关会议及日期>

### 2. 已拍板结论（Confirmed Decisions）
- <结论 1> — 《会议标题》[YYYY-MM-DD MM:SS] 说话人
- <结论 2> — 《会议标题》[YYYY-MM-DD MM:SS] 说话人

### 3. 待跟进承诺与未闭环待办（Open Commitments & Todos）
| 类型 | 事项 | 负责人 | 来源会议与时间 | 状态/风险 |
|---|---|---|---|---|
| 承诺 / 待办 | <具体动作> | <姓名/未指派> | 《会议标题》[YYYY-MM-DD MM:SS] | 待跟进 / 已拖延 |

### 4. 本次建议讨论清单与风险提醒
1. **必须对齐的分歧/卡点**：<说明前后口径差异或阻塞原因，附引证>
2. **建议开场确认的问题**：<2–4 个具体可执行问题>
```

---

### 场景 2：专题脉络复盘（Topic Deep Dive / `topic-deep-dive`）

**推荐调用顺序**：`build_context_pack(query, days=90)` → `search_meetings(query, limit=10)` + `list_projects(days=90)` → `get_related_meetings(mid)` → 对关键转折会议 `get_meeting(mid)` 核验原话。

```markdown
## 专题脉络复盘：<专题名称>（覆盖范围：YYYY-MM-DD ~ YYYY-MM-DD）

### 1. 一句话结论
<当前专题处于什么阶段、核心共识是什么、最大不确定性是什么>

### 2. 时间线演进（按时间正序）
- **YYYY-MM-DD｜《会议标题》**（参会：<人物列表>）
  - 关键讨论 / 方案变化：<要点>
  - 关键原话：`《会议标题》[YYYY-MM-DD MM:SS] 说话人：“...”`
- **YYYY-MM-DD｜《会议标题》**
  - ...

### 3. 已确认结论 vs 口径变更 / 未决分歧
- **已确认（Confirmed）**：<逐条列明及原话引证>
- **口径变更 / 分歧（Changed / Disputed）**：<指出何时、为何发生变化，目前是否已有定论>

### 4. 未闭环承诺、待办与阻塞风险
- <负责人>：<事项>（《会议标题》[YYYY-MM-DD MM:SS] 说话人）
```

---

### 场景 3：人物交集与跟进（Person Sync Prep / `person-sync-prep`）

**推荐调用顺序**：`get_person_history(name)` → `build_context_pack(person=name, days=60)` → `list_commitments(status="all", person=name)` + `list_todos(status="all", person=name)` → 对最近重要互动会议 `get_meeting(mid)` 核验原话。

```markdown
## 人物交集与跟进：<姓名>

### 1. 合作画像与近期交集
- **历史共同会议**：共 N 场（最近一次：YYYY-MM-DD《会议标题》）
- **高频共同议题**：<主题词 / 项目>
- **常共同参会人**：<人物列表>

### 2. 对方的核心观点与已达成共识（Confirmed）
- <观点或结论> — 《会议标题》[YYYY-MM-DD MM:SS] <姓名>

### 3. 双方未闭环承诺与待办
- **对方承诺 / 待推进**：
  - <事项> — 《会议标题》[YYYY-MM-DD MM:SS] <姓名>
- **我方 / 团队待交付给对方**：
  - <事项> — 《会议标题》[YYYY-MM-DD MM:SS] <说话人>

### 4. 下次沟通建议议题
1. <需要向对方确认或同步的关键事项>
2. <潜在风险或依赖项>
```

---

### 场景 4：周度复盘（Weekly Context Review / `weekly-context-review`）

**推荐调用顺序**：`get_weekly_digest(end_date)` → `get_daily_summary(date)`（按需补看重点日期）→ `list_commitments(status="open", days=14)` + `list_todos(status="open")` + `list_projects(days=14)` → 对核心拍板或风险会议 `get_meeting(mid)` 核验原话。

```markdown
## 周度上下文复盘（YYYY-MM-DD ~ YYYY-MM-DD）

### 1. 本周概览
- **会议总量与分布**：共 N 场（正式会议 / 全天录音 / 上传录音），重点聚焦项目：<项目列表>

### 2. 本周核心进展与已拍板结论（Confirmed Decisions）
- **<项目/主题 A>**：<进展与结论> — 《会议标题》[YYYY-MM-DD MM:SS] 说话人
- **<项目/主题 B>**：...

### 3. 未闭环承诺与待办盘点（按优先级/负责人）
- **高优 / 跨周未闭环**：<事项 + 负责人 + 来源引证>
- **本周新增待办**：<事项 + 负责人 + 来源引证>

### 4. 下周重点关注与风险预警
- **潜在风险 / 阻塞**：<说明证据来源与建议跟进动作>
- **下周会前准备建议**：<建议提前准备简报的议题或人选>
```
