# 本机桌面 AI 接入（MCP v2 Server + `meeting-context` Skill）

`meeting-notes` 内置了零额外依赖的本机只读 **MCP v2 Server**（[`mcp_server.py`](../mcp_server.py)，`v2.0.0`）与标准 Agent Skill（[`skills/meeting-context/SKILL.md`](../skills/meeting-context/SKILL.md)），通过标准 stdio JSON-RPC 2.0 协议将你的本机会议记录、全局检索、上下文打包、跨会关联、人物时间线、项目聚类、承诺与待办、日报与周报直接接入 **Antigravity / Claude Code / Cursor / Codex / Claude Desktop** 等桌面 AI 助手。

- **100% 本机运行**：直接读取本地 `MEETING_DATA`（开发仓库默认 `<repo>/data`，独立打包桌面版默认 `~/.meeting-notes/data`），不经过任何第三方云端中转。
- **默认只读**：不会修改或删除你的会议记录、待办或承诺。
- **隐私豁免支持**：启动参数加上 `--exclude-private` 即可自动跳过所有标记了「隐私会议」（`rsi_exclude`）的记录。
- **一步拉取上下文**：通过 `build_context_pack` 工具 + `meeting-context` Skill，外部 AI 一次调用即可获得带时间戳原话引证的结构化会议上下文包。

---

## 一键安装（推荐）

仓库提供零外部依赖的本地安装脚本 [`scripts/install-mcp-skill.mjs`](../scripts/install-mcp-skill.mjs)，可自动检测本机 `.venv` Python（不存在时回退到 `uv run`）、安全合并各客户端 MCP 配置（保留你原有的所有配置项），并自动链接 `meeting-context` Skill。

```bash
# 1. 先预览将要修改的配置文件和 Skill 链接（不写入任何文件）
node scripts/install-mcp-skill.mjs --targets all --dry-run

# 2. 自动检测已安装的桌面 AI 客户端并安装
node scripts/install-mcp-skill.mjs

# 3. 安装到全部 5 个客户端，并跳过隐私会议
node scripts/install-mcp-skill.mjs --targets all --exclude-private

# 4. 仅安装到指定客户端，并显式指定独立数据目录
node scripts/install-mcp-skill.mjs --targets antigravity,claude-code,cursor --data-dir "/path/to/meeting-data"

# 5. 安全卸载（仅移除 meeting-notes MCP 项与 meeting-context Skill，不动其他配置）
node scripts/install-mcp-skill.mjs --targets all --uninstall
```

### CLI 参数说明

| 参数 | 说明 |
|---|---|
| `--targets <list\|all>` | 目标客户端列表，逗号分隔或 `all`；支持 `antigravity`, `claude-code`, `cursor`, `codex`, `claude-desktop`。省略时自动检测本机已安装客户端（若未检测到则默认 `all`） |
| `--exclude-private` | 在 MCP 启动参数中追加 `--exclude-private`，自动过滤隐私会议 |
| `--data-dir <path>` | 指定 `env.MEETING_DATA` 路径（默认优先取环境变量 `MEETING_DATA`，否则为 `<repo>/data`） |
| `--dry-run` | 仅打印计划执行的 MCP 与 Skill 变更，不写入或创建任何文件 |
| `--uninstall` | 仅删除 `meeting-notes` MCP 配置与 `meeting-context` Skill，保留其他所有配置和 Skill |

### 各客户端配置路径一览

| 客户端 (`--targets`) | MCP 配置文件 | 格式 | Skill 安装路径 |
|---|---|---|---|
| `antigravity` | `~/.gemini/config/mcp_config.json` | JSON (`mcpServers`) | `~/.gemini/config/skills/meeting-context` |
| `claude-code` | `~/.claude.json` | JSON (`mcpServers`) | `~/.claude/skills/meeting-context` |
| `cursor` | `~/.cursor/mcp.json` | JSON (`mcpServers`) | `~/.cursor/skills/meeting-context` |
| `codex` | `~/.codex/config.toml` | TOML (`[mcp_servers.meeting-notes]`) | `~/.codex/skills/meeting-context` |
| `claude-desktop` | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json`<br>Linux: `~/.config/Claude/claude_desktop_config.json` | JSON (`mcpServers`) | 不适用（直接使用 MCP Prompts / Resources） |

> 安装完成后重启对应桌面 AI 客户端即可生效。对于 Claude Code，若当前有正在运行的会话，建议先退出再修改 `~/.claude.json`（运行中的会话退出时会重写该文件），或使用安装脚本输出提示中的 `claude mcp add-json -s user meeting-notes '...'` 命令注册。你也可以在应用内「设置 → 多端与集成 → AI 桌面客户端接入 (MCP & Skill)」中一键复制带本机真实路径的 JSON 配置或安装命令。

---

## 手动配置与 `MEETING_DATA`

### JSON 客户端（Antigravity / Claude Code / Cursor / Claude Desktop）

优先直接使用本机 `.venv` Python 指向 `mcp_server.py`，并通过 `env.MEETING_DATA` 显式绑定数据目录（避免独立打包版或不同工作目录下读取到空 `data/`）：

```json
{
  "mcpServers": {
    "meeting-notes": {
      "command": "/path/to/meeting-notes/.venv/bin/python",
      "args": [
        "/path/to/meeting-notes/mcp_server.py"
      ],
      "env": {
        "MEETING_DATA": "/path/to/meeting-notes/data"
      }
    }
  }
}
```

如果没有 `.venv`，可回退为 `uv run`：

```json
{
  "mcpServers": {
    "meeting-notes": {
      "command": "uv",
      "args": [
        "run",
        "--directory",
        "/path/to/meeting-notes",
        "python",
        "mcp_server.py"
      ],
      "env": {
        "MEETING_DATA": "/path/to/meeting-notes/data"
      }
    }
  }
}
```

如需跳过所有标记了「隐私会议」的记录，在 `args` 末尾加上 `"--exclude-private"`。

### Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.meeting-notes]
command = "/path/to/meeting-notes/.venv/bin/python"
args = ["/path/to/meeting-notes/mcp_server.py"]

[mcp_servers.meeting-notes.env]
MEETING_DATA = "/path/to/meeting-notes/data"
```

### 独立客户端数据目录说明

- 开发仓库默认数据目录为 `<repo>/data`。
- 独立打包桌面版默认数据目录位于 `~/.meeting-notes/data`（若在桌面端设置了自定义数据目录，则以该目录为准）。请通过 `--data-dir` 或 `env.MEETING_DATA` 指向实际的数据目录（其中应包含 `meetings/` 子目录）。

---

## MCP v2 能力清单

### 11 个只读 Tools

| 工具名 | 参数 | 作用 |
|---|---|---|
| `build_context_pack` | `query?`, `person?`, `days=30` (`0` 表示不限天数), `max_chars=12000` | **一步聚合上下文包**：返回匹配会议、高相关带 `[MM:SS]` 原话引证、关联项目、未闭环承诺、未完成待办及近期日报/周报上下文，自动按字符预算裁剪 |
| `list_meetings` | `limit=20`, `kind="all"\|"meeting"\|"ambient"\|"upload"` | 列出最近会议与全天录音（含标题、日期、时长、来源、摘要、标签与具名发言人） |
| `search_meetings` | `query`, `limit=10` | 跨标题、摘要/标签、AI 纪要、用户笔记与转写稿进行分词相关性评分与关键词检索，返回命中片段与时间戳 |
| `get_meeting` | `mid`, `include_transcript=true`, `max_chars=24000` | 读取单场会议的元信息、AI 纪要、用户笔记、打点与带时间戳/说话人的转写全文 |
| `get_related_meetings` | `mid`, `limit=5` | 查找与指定会议最相关的历史会议（基于共同参会人与高频主题词） |
| `get_person_history` | `name?` | 查看某位发言人的全部历史会议、共同参会人、高频话题与相关待办（留空返回全部人物列表） |
| `list_todos` | `status="open"\|"done"\|"all"`, `person=""`, `limit=100` | 聚合全部会议纪要里的待办事项（含来源会议与时间戳），可按状态与人物筛选 |
| `list_projects` | `days=30` (`0` 表示全部), `limit=12` | 列出近期活跃项目/专题聚类及其关联会议 |
| `list_commitments` | `status="open"\|"done"\|"all"`, `days=14` (`0` 表示不限), `person=""` | 聚合跨会口头承诺事项，支持按状态、时间窗与人物筛选 |
| `get_daily_summary` | `date=""` | 获取指定日期（默认今天或最近有记录的一天）的日报摘要与当日非隐私会议列表 |
| `get_weekly_digest` | `end_date=""` | 获取 `end_date` 所在自然周（周一至周日，留空默认本周）的会议、每日总结、待办、口头承诺与已保存周报（含草稿兜底） |

### 4 个内置 Prompts

支持 MCP Prompts 的客户端（如 Claude Desktop、Cursor、Claude Code 等）可直接调用内置提示模板：

| Prompt 名 | 参数 | 用途 |
|---|---|---|
| `pre-meeting-brief` | `topic`（必填）, `person`（可选）, `days`（可选） | 生成会前简报：背景脉络、已拍板结论、未闭环承诺/待办与本次建议议题 |
| `topic-deep-dive` | `topic`（必填）, `days`（可选） | 专题脉络复盘：按时间线梳理方案演进、口径变化、争议点与原话证据 |
| `person-sync-prep` | `person`（必填）, `days`（可选） | 人物交集与跟进准备：历史合作会议、对方关注点、双方未闭环承诺与沟通建议 |
| `weekly-context-review` | `end_date`（可选） | 周度复盘：汇总一周核心结论、活跃项目进展、跨周未闭环项与下周风险提醒 |

### 4 个只读 Resources

支持 MCP Resources 的客户端可直接订阅/读取以下 JSON 资源：

| Resource URI | 说明 |
|---|---|
| `meeting://recent` | 近期非隐私会议速览 |
| `meeting://commitments/open` | 当前所有未闭环承诺清单 |
| `meeting://todos/open` | 当前所有未完成待办清单 |
| `meeting://projects/active` | 近期活跃项目与专题清单 |

---

## `meeting-context` Agent Skill 使用指南

安装 [`skills/meeting-context/SKILL.md`](../skills/meeting-context/SKILL.md) 后，当你在 Antigravity、Claude Code、Cursor 或 Codex 中询问会议历史或上下文时，AI 会自动遵循以下规范：

1. **先广后深**：优先一次调用 `build_context_pack` 获取全局脉络，避免低效逐场翻查；
2. **交叉核验**：按场景组合 `list_commitments`、`list_todos`、`get_person_history`、`list_projects`、`get_daily_summary`、`get_weekly_digest`；
3. **原话下钻**：遇到关键决策、数字、日期或冲突口径时，调用 `get_meeting` 核对转写原话；
4. **严格引证与分级**：统一使用 `《会议标题》[YYYY-MM-DD MM:SS] 说话人` 格式引证，并明确区分「已拍板结论」与「未闭环承诺/待确认风险」。

### 常用提问示例

- **会前简报**：“下午要和张三开 Workday 方案评审会，帮我出一份会前简报，重点看上次拍板的结论和还没闭环的承诺。”
- **专题脉络复盘**：“把最近 60 天关于定价策略的所有讨论按时间线复盘一下，哪些口径变过、目前定下来什么？”
- **人物交集与跟进**：“整理一下我和李四最近的全部会议交集，他承诺的事项和我要交付给他的待办各有哪些？”
- **周度复盘**：“帮我做一份本周会议周报，重点标出跨周还没闭环的高优承诺和下周风险。”
