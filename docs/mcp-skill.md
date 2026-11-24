# 本机桌面 AI 接入（MCP Server / 类 `auday-skill`）

`meeting-notes` 内置了零额外依赖的本机只读 **MCP Server**（[`mcp_server.py`](../mcp_server.py)），通过标准 stdio JSON-RPC 2.0 协议将你的本机会议记录、全文搜索、跨会关联、人物时间线和待办汇总直接接入 **Antigravity / Claude Desktop / Claude Code / Cursor / Codex** 等桌面 AI 助手。

- **100% 本机运行**：直接读取本地 `data/`，不经过任何第三方云端中转。
- **默认只读**：不会修改或删除你的会议记录。
- **隐私豁免支持**：启动参数加上 `--exclude-private` 即可自动跳过所有标记了「隐私会议」的记录。

---

## 快速配置

在你的桌面 AI 工具的 MCP 配置文件中加入以下片段（也可在网页「设置 → 桌面 AI 接入 (MCP)」中一键复制带本机真实路径的配置）：

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
      ]
    }
  }
}
```

如需跳过所有标记了「隐私会议」的记录，在 `args` 末尾加上 `"--exclude-private"` 即可。

---

## 暴露的 6 个只读工具

| 工具名 | 作用 |
|---|---|
| `list_meetings` | 列出最近会议与全天录音（支持按 `all / meeting / ambient / upload` 筛选） |
| `search_meetings` | 跨标题、纪要、转写稿全文关键词检索，返回带时间戳的命中片段 |
| `get_meeting` | 读取单场会议的元信息、AI 纪要、笔记、打点与转写全文 |
| `get_related_meetings` | 查找与某场会议最相关的历史会议（基于共同参会人与高频主题词） |
| `get_person_history` | 查看某位发言人的全部会议、共同参会人、高频话题与相关待办 |
| `list_todos` | 聚合全部会议纪要里的未完成/已完成待办事项（可按人物筛选） |

接入后你可以直接向桌面 AI 提问，例如：
- “帮我查一下上周和张三聊 Workday 时定了什么结论，还有哪些待办没闭环？”
- “把最近 7 天所有未完成的待办按负责人整理成一份跟进清单。”
