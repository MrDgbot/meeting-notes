# 核对造出的陈述（固定提示，见 docs/prereg-claims.md 第 8 节）

输入：一场会议的人工标准转写（`u编号 [分:秒] 说话人字母: 原话`），以及一个 JSON 数组，每个元素有 claim、cite 和若干错误版本（mut_number、mut_negate、mut_entity、fab_todo，可能为 null）。
对每个元素判断（可以看全场转写，不只看 cite）：
- claim_ok：真陈述是否被原话明确证实（true/false）。
- 每个非 null 的错误版本是否“明确与原话不符或原话里没有”：number_bad、negate_bad、entity_bad、fab_bad（true 表示确实是错的；如果改完以后仍然成立或说不清，填 false）。
输出 JSON 数组，与输入一一对应：`{"i": 序号从0开始, "claim_ok": bool, "number_bad": bool|null, "negate_bad": bool|null, "entity_bad": bool|null, "fab_bad": bool|null, "note": "不超过30字，可空"}`。只输出 JSON。
