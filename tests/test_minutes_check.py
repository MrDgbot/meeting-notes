"""纪要校验：没有原话的期限改成待定，时间戳按原话校正。不调用大模型。

用法：.venv/bin/python tests/test_minutes_check.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("MEETING_DATA", tempfile.mkdtemp(prefix="mn-min-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import minutes_check as mc
import prompts

fails = 0
_STANDALONE = False


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + str(msg))
    if not cond:
        fails += 1
        if not _STANDALONE:
            raise AssertionError(str(msg))


PARAS = [
    {"start": 10000, "end": 18000, "spk": 0, "text": "测试预算的事我来申请，时间还没定"},
    {"start": 60000, "end": 70000, "spk": 1, "text": "周四开始跑，周六全天跑"},
    {"start": 120000, "end": 130000, "spk": 1, "text": "长尾词的效果下周再看，李娜来跟"},
]


def doc(actions, **kw):
    base = {"title": "周会", "summary": "讨论了预算。", "sections": [], "keywords": ["预算"], "actions": actions}
    base.update(kw)
    return json.dumps(base, ensure_ascii=False)


def test_invented_due_becomes_pending():
    raw = doc([
        {"task": "申请测试预算", "owner": "我", "due": "下周", "time": "00:10", "quote": "测试预算的事我来申请"},
        {"task": "看长尾词效果", "owner": "李娜", "due": "下周", "time": "02:00", "quote": "效果下周再看"},
        {"task": "安排跑数", "owner": "李娜", "due": "周四全天", "time": "01:00", "quote": "周四开始跑，周六全天跑"},
        {"task": "已经待定的事", "owner": "李娜", "due": "待定", "time": "02:00", "quote": "李娜来跟"},
    ])
    built, checks = mc.build(raw, PARAS)
    by = {a["task"]: a for a in built["actions"]}
    check(by["申请测试预算"]["due"] == "待定（原文未说明期限）", f"原话没说期限不能填下周：{by['申请测试预算']}")
    check(by["申请测试预算"]["owner"] == "待定（原文未点名）", "「我」不是转写里的姓名")
    check(by["看长尾词效果"]["due"] == "下周" and by["看长尾词效果"]["owner"] == "李娜", f"原话里有的期限和姓名保留：{by['看长尾词效果']}")
    check(by["安排跑数"]["due"] == "待定（原文未说明期限）", f"「周四全天」不能从「周四开始、周六全天」推出来：{by['安排跑数']}")
    check(by["已经待定的事"]["due"] == "待定", "模型自己写的待定保持待定")
    dues = [c for c in checks if c["kind"] == "due"]
    check(len(dues) == 2 and all(c["to"].startswith("待定") for c in dues), f"改过的期限要记下来：{dues}")
    owners = [c for c in checks if c["kind"] == "owner"]
    check(any(c["where"] == "申请测试预算" for c in owners), f"改过的负责人要记下来：{owners}")
    check(not any(c["kind"] == "due" and c["where"] == "已经待定的事" for c in checks), "待定本身不算一处改动")


def test_timestamp_snap_and_miss():
    raw = doc([
        {"task": "看长尾词效果", "owner": "李娜", "due": "下周", "time": "00:10", "quote": "效果下周再看"},
        {"task": "没有出处", "owner": "李娜", "due": "待定", "time": "45:00", "quote": ""},
    ], summary="详见 [16:21]。")
    built, checks = mc.build(raw, PARAS)
    by = {a["task"]: a for a in built["actions"]}
    check(by["看长尾词效果"]["time"].startswith("02:00") and "校正" in by["看长尾词效果"]["time"],
          f"摘句对上了就把时间戳挪过去：{by['看长尾词效果']['time']}")
    check("时间对不上" in by["没有出处"]["time"], f"对不上的时间要标出来：{by['没有出处']['time']}")
    check("时间对不上" in built["summary"], f"正文里的时间也要标：{built['summary']}")
    md = mc.render(built, "weekly")
    check(md.startswith("# 周会") and "## 下周计划与待办" in md, "周会模板渲染出标题和待办表")
    check("待定（原文未说明期限）" not in md.split("看长尾词")[0] or "申请" not in md, "渲染不额外发明期限")
    check("| 看长尾词效果 | 李娜 | 下周 | [02:00]（已按原话校正） |" in md, f"表格用校正后的时间：\n{md}")
    check(any(c["kind"] == "time" and c.get("to", "").startswith("02:00") for c in checks), "校正记进 checks")


def test_due_rules_and_parse():
    check(mc.due_supported("下周", "我们下周再看"), "下周对下周")
    check(not mc.due_supported("下周", "周四开始跑"), "没说下周就不能写下周")
    check(not mc.due_supported("下周四", "周四开会"), "只有周四不能变成下周四")
    check(mc.due_supported("下周四", "放到下周的周四"), "下周和周四都在才算")
    check(mc.due_supported("待定", "什么都没说"), "待定总是通过")
    check(mc.due_supported("11月6日", "定在11月6日发布"), "日期照抄算数")
    text = "```json\n" + doc([]) + "\n```"
    built, checks = mc.build(text, PARAS)
    check(built["title"] == "周会" and built["actions"] == [] and checks == [], f"代码块里的 JSON 也能解析：{built}")
    try:
        mc.build("不是 json", PARAS)
        check(False, "坏 JSON 应该失败")
    except ValueError as e:
        check("可核对" in str(e), str(e))


def test_duplicate_summary_heading():
    raw = doc([], summary="讨论了预算和转岗。", sections=[
        {"heading": "会议概要", "body": "讨论了预算和转岗。"},
        {"heading": "决议与结论", "body": "先不调人。"},
        {"heading": "决议与结论", "body": "先不调人。再写一遍。"},
    ])
    built, _ = mc.build(raw, PARAS)
    md = mc.render(built, "general")
    check(md.count("## 会议概要") == 1, f"概要标题只出现一次：\n{md}")
    check(md.count("## 决议与结论") == 1, "连续重复的小节只留前面一节")
    check("讨论了预算和转岗。" in md, "summary 里的概要还在")
    weekly = mc.render({"title": "周会", "summary": "本周同步。", "sections": [
        {"heading": "会议概要", "body": "模型又写了一遍概要"},
        {"heading": "各成员进展", "body": "李娜在跟长尾词。"},
    ], "actions": [], "keywords": []}, "weekly")
    check(weekly.count("## 会议概要") == 1 and "模型又写了一遍" not in weekly, weekly)
    client = mc.render({"title": "客户会", "summary": "对方要报价。", "sections": [
        {"heading": "沟通概要", "body": "又写了一遍"},
        {"heading": "客户需求", "body": "要报价。"},
    ], "actions": [], "keywords": []}, "client")
    check(client.count("## 沟通概要") == 1 and "又写了一遍" not in client and "要报价" in client, client)
    clean = mc.render({"title": "周会", "summary": "讨论了预算。", "sections": [
        {"heading": "决议与结论", "body": "先不调人。"},
    ], "actions": [], "keywords": ["预算"]}, "general")
    check(clean == mc.dedupe_markdown_headings(clean), "没有重复标题时原文不变")
    raw_md = "# 周会\n\n## 会议概要\n\n第一段。\n\n## 会议概要\n\n第二段。\n\n## 决议\n\n留下。\n"
    folded = mc.dedupe_markdown_headings(raw_md)
    check(folded.count("## 会议概要") == 1 and "第二段" not in folded and "留下" in folded and "第一段" in folded, folded)


def test_prompt_keeps_overview_out_of_sections():
    msgs = prompts.minutes_json_messages(
        {"title": "周会", "created": "2026-11-04T18:24:35", "speakers": {}, "hotword": ""},
        "", "general", "[00:01] 说话人1：预算", False)
    user = msgs[-1]["content"]
    check("不要在 sections" in user and "会议概要" in user, "提示里要求概要只写在 summary")


def test_auto_refresh_decision():
    live = {"from_live": True, "src_hash": "aaa", "edited": False}
    check(mc.should_auto_refresh(live, from_live=True, transcript_changed=True), "实时稿纪要在精转完成后要重写")
    edited = {**live, "edited": True}
    check(not mc.should_auto_refresh(edited, from_live=True, transcript_changed=True), "手改过的不覆盖")
    old = {"from_live": False, "src_hash": "aaa", "edited": False}
    check(mc.should_auto_refresh(old, from_live=False, transcript_changed=True), "精转稿更新后，指纹对不上的纪要要重写")
    check(not mc.should_auto_refresh(old, from_live=False, transcript_changed=False), "转写没变（只改了笔记）不自动重写")
    check(not mc.should_auto_refresh(None, from_live=True), "没有纪要不重写")


def test_unknown_owner():
    raw = doc([{"task": "补测试平台", "owner": "王五", "due": "待定", "time": "02:00", "quote": "李娜来跟"}])
    built, checks = mc.build(raw, PARAS)
    check(built["actions"][0]["owner"] == "待定（原文未点名）", built["actions"][0]["owner"])
    check(any(c.get("kind") == "owner" and c.get("from") == "王五" for c in checks),
          json.dumps(checks, ensure_ascii=False))


def test_numbers_narrative_counters_and_dates_not_flagged():
    """回归 #28(a): 常见概括词（人/个/条/阶段/天/小时/分钟）与年份不能被误标「待确认」。"""
    paras = [{"start": 0, "end": 5000, "spk": 0, "text": "今天一起过一下接下来的研发计划和上线安排"}]
    summary = "本次会议共有4人参与，讨论了3个议题，计划2026年上线。提出2条建议，分2个阶段推进。"
    body = "- 安排3天联调，分5次灰度，单次窗口2小时30分钟。\n- 共涉及2家合作方、10台机器、3套环境。"
    raw = doc([], summary=summary, sections=[{"heading": "实施计划", "body": body}])
    built, checks = mc.build(raw, paras)
    check(built["summary"] == summary, f"概括词和年份不应误标：{built['summary']}")
    check(built["sections"][0]["body"] == body, f"小节常见计数词不应误标：{built['sections'][0]['body']}")
    num_checks = [c for c in checks if c["kind"] == "number"]
    check(not num_checks, f"不应产生任何数字告警：{num_checks}")


def test_numbers_multibullet_section_not_truncated_by_first_timestamp():
    """回归 #28(b): 小节首条带 [00:00] 时，不能把整节裁到 00:00±90s 而误杀 10:00 处的真实数据。"""
    paras = [
        {"start": 0, "end": 5000, "spk": 0, "text": "预算确定为二十万"},
        {"start": 600000, "end": 605000, "spk": 1, "text": "今年毛利率目标提升到百分之十五"},
    ]
    body = "- 预算确定为20万。[00:00]\n- 毛利率目标提升至15%。\n- 运维成本降低42%。"
    raw = doc([], summary="讨论预算与利润率目标。", sections=[{"heading": "核心结论", "body": body}])
    built, checks = mc.build(raw, paras)
    sec_body = built["sections"][0]["body"]
    check("20万（待确认）" not in sec_body, f"20万有原文支撑不应误标：{sec_body}")
    check("15%（待确认）" not in sec_body, f"10:00 处的 15% 不应被首条 [00:00] 截断误标：{sec_body}")
    check("42%（待确认）" in sec_body, f"真正编造的 42% 应标待确认：{sec_body}")
    num_checks = [c for c in checks if c["kind"] == "number"]
    check([c["from"] for c in num_checks] == ["42%"], f"只应记录 42%：{num_checks}")

    # 跨段边界：相邻段末尾与开头的数字不能被拼成一个新数字
    adj_paras = [
        {"start": 0, "end": 3000, "spk": 0, "text": "预算20"},
        {"start": 4000, "end": 7000, "spk": 1, "text": "500元左右"},
    ]
    adj_raw = doc([], summary="总计20500元。")
    adj_built, _ = mc.build(adj_raw, adj_paras)
    check("20500元（待确认）" in adj_built["summary"], f"跨段数字不应拼接成 20500：{adj_built['summary']}")


def test_numbers_spoken_cn_shorthand_and_qianwan_idiom():
    """回归 #28(c): 口语中文数字缩略准确解析；成语「千万」不误转 1000万。"""
    cases = [
        ("一百五", "150"),
        ("一千五", "1500"),
        ("两万五", "25000"),
        ("三千二", "3200"),
        ("十二万五", "125000"),
        ("两点五万", "25000"),
        ("三亿五", "350000000"),
        ("一百零五", "105"),
        ("一千零五", "1005"),
        ("两万零五", "20005"),
        ("一千万", "10000000"),
        ("千万", "千万"),
    ]
    for src, exp in cases:
        got = mc._cn_to_num(src)
        check(got == exp, f"_cn_to_num({src!r}) == {exp!r} (got {got!r})")

    norm_idiom = mc._norm_nums("这个需求大家千万别漏了")
    check("1000" not in norm_idiom and "千万" in norm_idiom, f"成语千万不能被转成 1000：{norm_idiom!r}")

    paras = [
        {"start": 0, "end": 8000, "spk": 0,
         "text": "报价大概两万五，差旅费一千五，餐饮一百五，设备三千二，另外这个需求千万别漏了"},
        {"start": 10000, "end": 15000, "spk": 1,
         "text": "对比了2个方案，转化率3.5%，去年营收15%，预算区间十五到二十万"},
    ]
    summary = "报价2.5万（25000元）、差旅1500元、餐饮150元、设备3200元，区间15万到20万，另编造1000万与2万与3%与5%。"
    built, checks = mc.build(doc([], summary=summary), paras)
    s = built["summary"]
    for ok_tok in ("2.5万", "25000元", "1500元", "150元", "3200元", "15万", "20万"):
        check(f"{ok_tok}（待确认）" not in s, f"{ok_tok} 有口语原文支撑不应误标：{s}")
    for bad_tok in ("1000万", "2万", "3%", "5%"):
        check(f"{bad_tok}（待确认）" in s, f"无支撑的 {bad_tok} 必须标待确认：{s}")

    # 真正说「一千万」时，1000万应通过
    real_paras = [{"start": 0, "end": 5000, "spk": 0, "text": "今年总预算一千万，单价2.5万"}]
    real_built, real_checks = mc.build(doc([], summary="总预算1000万，单价25000元。"), real_paras)
    check("待确认" not in real_built["summary"], f"一千万/2.5万应支撑 1000万/25000元：{real_built['summary']}")
    check(not [c for c in real_checks if c["kind"] == "number"], f"不应有数字告警：{real_checks}")


if __name__ == "__main__":
    _STANDALONE = True
    fails = 0
    test_invented_due_becomes_pending()
    test_timestamp_snap_and_miss()
    test_due_rules_and_parse()
    test_duplicate_summary_heading()
    test_prompt_keeps_overview_out_of_sections()
    test_auto_refresh_decision()
    test_unknown_owner()
    test_numbers_narrative_counters_and_dates_not_flagged()
    test_numbers_multibullet_section_not_truncated_by_first_timestamp()
    test_numbers_spoken_cn_shorthand_and_qianwan_idiom()
    if fails:
        print(f"{fails} 项失败")
        sys.exit(1)
    print("全部通过")
