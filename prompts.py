"""纪要模板与提示词。"""
import vocab
from asr_engine import fmt_ts

SYSTEM = """你是专业的会议纪要助手，根据会议转写稿撰写结构化的中文会议纪要。
规则：
1. 只依据转写稿和参会者笔记，不编造未出现的信息；不确定的写“待确认”。
2. 转写由语音识别生成，可能有同音错字，请结合上下文纠正明显错误；专有名词以“热词”为准。
3. 发言人用转写中的名字（如“说话人1”或真实姓名）。
4. 引用出处时用 [mm:ss] 或 [h:mm:ss] 格式的时间戳，与转写稿一致。
5. 待办事项必须写清楚：事项、负责人、截止时间；未明确的写“待定”。
6. 直接输出 Markdown，不要用代码块包裹，不要输出与纪要无关的话。
7. 第一行输出“# 标题”，标题为根据内容拟定的简洁会议名称（不超过 20 字）。"""

TEMPLATES = {
    "general": {
        "name": "通用会议",
        "prompt": """按以下结构输出：
## 会议概要
3~5 句话概括会议目的、主要内容和结果。
## 议题与讨论
按时间顺序划分议题，每个议题用“### [时间] 议题名”，下面用列表写讨论要点（谁提出了什么观点、依据）。
## 决议与结论
列出已达成的决定。
## 待办事项
表格：| 事项 | 负责人 | 截止时间 | 出处 |
## 发言人观点
每位发言人 1~3 条核心观点。
## 待跟进问题
未解决、有分歧或需要会后确认的问题。
## 关键词
5~10 个关键词，用顿号分隔。""",
    },
    "weekly": {
        "name": "周会 / 例会",
        "prompt": """按以下结构输出：
## 会议概要
## 各成员进展
按发言人分组：本周完成、进行中、遇到的问题。
## 风险与阻塞
## 决议
## 下周计划与待办
表格：| 事项 | 负责人 | 截止时间 | 出处 |""",
    },
    "client": {
        "name": "客户访谈 / 商务沟通",
        "prompt": """按以下结构输出：
## 沟通概要
## 客户背景与现状
## 需求与痛点
按重要程度排序，尽量引用客户原话（标注时间戳）。
## 客户对我方方案/产品的反馈
## 关注点与顾虑（价格、周期、风险等）
## 机会判断
## 后续跟进
表格：| 事项 | 负责人 | 截止时间 | 出处 |""",
    },
    "interview": {
        "name": "招聘面试",
        "prompt": """按以下结构输出：
## 面试概要
## 候选人背景
## 问答要点
按问题列出：面试官问题 → 候选人回答要点（标注时间戳）。
## 能力评估
分维度（专业能力、项目经验、沟通表达、动机稳定性等）列出优势与不足，给出依据。
## 面试官意见与结论
## 待确认事项""",
    },
    "brainstorm": {
        "name": "头脑风暴",
        "prompt": """按以下结构输出：
## 讨论主题
## 想法清单
按主题分组列出所有被提出的想法，注明提出人。
## 评估与取舍
各想法的优缺点、大家的倾向。
## 选定方向
## 下一步行动
表格：| 事项 | 负责人 | 截止时间 | 出处 |""",
    },
    "lecture": {
        "name": "讲座 / 培训",
        "prompt": """按以下结构输出：
## 内容概要
## 大纲
按时间顺序的章节，“### [时间] 章节名”，下面列核心知识点。
## 重点与金句
## 案例
## 可执行建议
## 问答环节""",
    },
}


def spk_name(meta: dict, spk: int) -> str:
    return (meta.get("speakers") or {}).get(str(spk)) or f"说话人{spk + 1}"


def transcript_lines(meta: dict, paras: list[dict]) -> list[str]:
    return [f"[{fmt_ts(p['start'])}] {spk_name(meta, p['spk'])}：{p['text']}" for p in paras]


def context_header(meta: dict, notes: str) -> str:
    head = [f"会议标题：{meta['title']}", f"会议时间：{meta['created'].replace('T', ' ')}"]
    names = sorted(set((meta.get("speakers") or {}).values()))
    if names:
        head.append("已知参会人：" + "、".join(names))
    hw = vocab.hotwords(meta.get("hotword", ""))
    if hw:
        head.append("热词（专有名词正确写法）：" + hw)
    if notes.strip():
        head.append("参会者手写笔记（重要，纪要应重点体现其中强调的内容）：\n" + notes.strip())
    return "\n".join(head)


def chunk_lines(lines: list[str], max_chars: int) -> list[list[str]]:
    chunks, cur, n = [], [], 0
    for ln in lines:
        if cur and n + len(ln) > max_chars:
            chunks.append(cur)
            cur, n = [], 0
        cur.append(ln)
        n += len(ln) + 1
    if cur:
        chunks.append(cur)
    return chunks


MAP_PROMPT = """下面是一场长会议转写稿的第 {i}/{n} 部分。请提炼这一部分的详细要点笔记，供之后合并成完整纪要：
- 按时间顺序列出议题和讨论要点，保留关键数字、结论、分歧，注明发言人和 [时间戳]
- 单独列出这一部分出现的决定和待办（含负责人、截止时间）
只输出要点笔记。

{text}"""


def minutes_messages(meta, notes, template_id, body_text, partial=False):
    t = TEMPLATES.get(template_id) or TEMPLATES["general"]
    kind = "各部分要点笔记（按时间顺序）" if partial else "转写稿"
    user = f"""{context_header(meta, notes)}

纪要模板：{t['name']}
{t['prompt']}

以下是会议{kind}：
{body_text}"""
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]


QA_SYSTEM = """你是会议助理，根据会议转写稿（及已生成的纪要）回答用户关于这场会议的问题。
只依据会议内容回答；会议中没有提到的，直接说明“会议中没有提到”。回答简洁，必要时引用 [时间戳] 和发言人。用中文 Markdown 回答。"""


# ---------- 每日汇总 ----------
DAILY_SYSTEM = """你是私人工作助理，根据用户一天中录下的多段对话/会议（全天自动记录 + 手动会议），写一份当天的工作日志式汇总。
要求：
- 只依据材料，不编造；转写可能有同音错字，结合上下文理解，人名/术语以热词为准。
- 很多片段是闲聊、电话、碎片对话，没有信息量的直接忽略，不要逐段复述。
- 用 **[HH:MM]** 标注出处时间（材料中每段开头给出了钟点时间）。
- 用中文 Markdown 输出，第一行是 `# M月D日 工作汇总`，然后依次是以下小节（某节没有内容就写“无”）："""

DAILY_SECTIONS = """## 今日概览
3~5 句话概括今天主要在忙什么、有哪些重要进展。

## 时间线
按时间顺序，每段有实质内容的对话一行：`- **[HH:MM]** 主题（参与人）：一句话要点`

## 决定事项

## 待办事项
| 事项 | 负责人 | 截止时间 | 出处 |
|---|---|---|---|

## 值得记住的信息
数字、联系方式、对方的需求和顾虑、灵感与想法等。

## 需要跟进
悬而未决的问题、承诺过但还没做的事。"""

DAY_MAP_PROMPT = """下面是用户某天一段对话的转写/纪要（开头标注了钟点时间）。请提炼成不超过 {n} 字的要点笔记：主题、参与人、关键信息与数字、决定、待办（负责人/截止时间）。没有实质内容（闲聊、噪音、碎片）就只输出“（无实质内容）”。

{text}"""


def daily_messages(date_label: str, hotwords: str, blocks: list[str]) -> list[dict]:
    head = f"日期：{date_label}\n" + (f"热词（专有名词正确写法）：{hotwords}\n" if hotwords.strip() else "")
    user = head + "\n输出格式：\n" + DAILY_SECTIONS + "\n\n以下是当天按时间顺序的各段材料：\n\n" + "\n\n".join(blocks)
    return [{"role": "system", "content": DAILY_SYSTEM}, {"role": "user", "content": user}]
