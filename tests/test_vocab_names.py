"""疑似认错的热词、推测姓名的证据核对（不联网、不加载语音模型，几秒）。

  .venv/bin/python tests/test_vocab_names.py
"""
import os
import sys
import tempfile
from pathlib import Path

os.environ["MEETING_DATA"] = tempfile.mkdtemp(prefix="mn-vn-")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prompts  # noqa: E402
import vocab  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += not cond


def P(text, start=0, spk=0, end=None):
    return {"text": text, "start": start, "end": end if end is not None else start + 5000, "spk": spk}


# ---- 疑似认错的热词 ----
vocab.save({"hotwords": "长尾词 以图搜图 预算池", "fixes": []})
ps = [P("他说的以陈伟驰打流量的这种策略", 1000), P("对。常伟奇那块，你现在是怎么选的", 9000),
      P("你不说图比他贵吗？", 20000), P("这个预算是多少，常委会那边定", 30000), P("长尾词本身没问题", 40000)]
s = {(x["text"], x["hotword"]): x for x in vocab.suspects(ps)}
check(("陈伟驰", "长尾词") in s and ("常伟奇", "长尾词") in s, f"读音像热词的生僻组合找出来了（长 是多音字：chang / zhang）：{sorted(s)}")
check(("你不说图", "以图搜图") in s, "四个字的热词也能找到")
check(not any(t in ("预算是", "常委会") for t, _ in s), "常用词、跨词边界的组合不报（预算是、常委会）")
check(s[("陈伟驰", "长尾词")]["at"] == [1000], "记下出现的位置，页面上点了能跳过去")
vocab.add_fix("陈伟驰", "长尾词")
s2 = {x["text"] for x in vocab.suspects(vocab.apply_paras(ps))}
check("陈伟驰" not in s2 and "常伟奇" in s2, "加了纠错规则的不再提示，其他照旧")
check(vocab.suspects(ps, "") and not vocab.suspects([P("随便说点什么")]), "没有可疑的就是空列表")
vocab.save({"hotwords": "", "fixes": []})
check(vocab.suspects(ps) == [], "没有热词时不提示")
check(vocab.suspects(ps, "长尾词") != [], "本场热词也算")

# ---- 推测姓名：证据核对 ----
tr = [P("小李你说一下竞品这块", 60000, 0), P("好，我这边竞品已经收尾了", 66000, 3), P("我是小王，负责质检", 120000, 2),
      P("嗯嗯", 130000, 1)]
raw = [{"spk": 4, "name": "小李", "confidence": "高", "reason": "点名后回应", "evidence": [{"ts": "01:00", "quote": "小李你说一下"}, {"ts": "1:06", "quote": "我这边竞品已经收尾了"}]},
       {"spk": 3, "name": "小王", "confidence": "高", "reason": "自我介绍", "evidence": [{"ts": "02:00", "quote": "我是小王，负责质检"}]},
       {"spk": 2, "name": "老李", "confidence": "中", "reason": "编的", "evidence": [{"ts": "02:10", "quote": "我是老李负责财务"}]},
       {"spk": 1, "name": "小李", "confidence": "低", "reason": "重名", "evidence": [{"ts": "01:00", "quote": "小李你说一下"}]},
       {"spk": 9, "name": "不存在", "evidence": [{"ts": "01:00", "quote": "小李你说一下"}]},
       {"spk": 2, "name": "说话人2", "evidence": [{"ts": "02:10", "quote": "嗯嗯嗯嗯"}]},
       {"spk": 1, "name": "远处", "evidence": [{"ts": "30:00", "quote": "我是小王，负责质检"}]}]
raw.append({"spk": 2, "name": "转述", "confidence": "中", "reason": "别人提到", "evidence": [{"ts": "01:00", "quote": "小李你说一下竞品"}]})
ok = {c["name"]: c for c in prompts.check_name_candidates(raw, tr)}
check(set(ok) == {"小李", "小王"}, f"只留下摘句在转写里逐字出现、且有一句是本人说的候选：{sorted(ok)}")
check(ok["小李"]["spk"] == 3 and len(ok["小李"]["evidence"]) == 2, "编号从“说话人N”换回内部编号；同名只留证据多的那个")
check(ok["小王"]["evidence"][0]["ts"] == "02:00" and ok["小王"]["evidence"][0]["spk"] == 2, "证据带上原话所在段的时间和说话人")
check(prompts.check_name_candidates("不是列表", tr) == [] and prompts.check_name_candidates([{"spk": "x"}], tr) == [], "模型乱答也不报错")

print("全部通过" if not fails else f"{fails} 项失败")
sys.exit(1 if fails else 0)
