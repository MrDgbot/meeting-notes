# 状态机清单

这份文档列出会议记录里所有“隐式状态机”：哪些变量 / 文件组合起来表示一个状态、怎么跳转、谁触发。
排查时先看 **GET /api/state**（只读，不触发任何动作），它把下面每个状态机此刻的状态、最近的跳转和状态表一起返回。

约定：显式化之后，**不合法的跳转只记一条 warning 日志并照样执行**，不抛错、不改原来的行为；
磁盘格式（data/meetings/*/meta.json、settings.json）和现有接口的字段都没有变，只多了字段。

---

## 1. 会议生命周期（meta.json 的 `status`）—— 已显式化

代码：`meeting_state.py`（状态、跳转表、`transition()`、最近 200 次跳转）。app.py 里所有改 status 的地方都走 `ms.transition()`。

| 状态 | 含义 |
|---|---|
| new | 建好了，还没有录音 / 录音太短且没有实时稿 |
| recording | 网页在录（source=mic），或全天模式正在写这段（source=ambient） |
| queued | 已交给转写线程（单线程，按顺序） |
| transcribing | 正在精准转写 + 区分说话人 |
| ready | 有转写（或只有实时稿） |
| error | 转写失败，`error` 字段写原因 |

| 从 → 到 | 触发点 |
|---|---|
| new → recording | `ws_live` 开始录音 |
| ready / error → recording | `ws_live` 续录 |
| recording → recording | 断线重连（`live_resume`） |
| recording → queued | `_live_finalize`（停止、超时、在别的设备结束）；全天模式一段对话结束（`Ambient._worker` → `on_closed`）；`finalize_stuck` |
| recording → ready / new | 录音不到 1 秒：有实时稿 ready，否则 new |
| new → queued | 上传录音 `upload_meeting` |
| ready / error → queued | 重新转写 `retranscribe`；模型加载成功后自动重排 `load_models`（只重排因模型失败出错的） |
| queued → transcribing | `run_transcribe` 开始（模型就绪后） |
| transcribing → ready | 转写写完 |
| queued / transcribing → error | 转写出错（含模型加载失败） |
| recording / queued / transcribing → queued / new | 服务重启恢复：有录音就重新排队，没有就回 new |
| recording → （回收站） | 全天对话发言太短：整个目录挪到 data/discarded/，见第 6 节 |

**创建时直接是 recording 的**：全天模式新开一段对话（`store.create(status="recording")`），不经过 transition。

**转写排队去重**（`app._inflight`）：同一场会议已经交给转写线程、还没写完时，再调用 `queue_transcribe` 直接跳过。
以前网页连点“重新转写”、自动收尾和卡住检测同时触发时会转写两遍。转写写完（进入 ready）就放开，之后自动刷新纪要期间可以再排队。

---

## 2. 全天模式采集（`Ambient.state`）—— 已显式化

代码：`ambient.py` 顶部 `STATES` / `TRANSITIONS`，`Ambient._set_state()`，`Ambient.state_info()`。

状态是采集线程每一轮按这些标志**推导**出来的：`enabled`、`holds`（网页手动录音占用）、`paused_until`（>now 暂停，inf=直到手动恢复，存在 settings.json 的 `ambient.paused_until`，-1 表示 inf）、`engine.ready/error`、VAD 是否在一句话中间。

| 状态 | 条件 |
|---|---|
| off | 没开（采集线程退出时设置） |
| starting | 开了，语音模型还没就绪 |
| listening | 麦克风开着，没人说话 |
| speech | 有人在说话 |
| paused | 暂停中，麦克风已关 |
| held | 网页正在手动录音，全天采集让路 |
| error | 模型加载失败，或麦克风打不开 / 意外结束（指数退避 2→60 秒重试） |

优先级：held > paused > 模型未就绪 > 采集。表里唯一不合法的是 listening/speech → starting（模型加载好以后不会再卸载）。
`/api/ambient` 多了 `state_since`（进入当前状态的时间）。`/api/state` 里的 `ambient` 还有 holds、是否开着麦克风、当前对话、等收尾的对话、识别队列长度、最近 20 次跳转。

**对话（Conv）子状态**：无对话 →（第一句话）写入中（`self.conv`）→（静音超过 split_min / 超过 max_conv_min / 手动“分段” / 暂停 / 占用 / 出错）等收尾（`_pending_close`）→ 识别线程处理 close：发言够长 → 排队精准转写；太短且用户没写过东西 → 回收站。用户删除正在写的对话 → `discard()`，直接丢弃。

**临时文字**：`_seq`（每次开口 +1）、`_done_seq`（已出最终文字的最大编号）、`partial`。临时文字只在 `seq > _done_seq` 时显示，最终文字出来就撤掉。没改。

---

## 3. 实时录音（`LiveRec`，一次 rec 跨多条 WebSocket）—— 加了可查询的 `phase`

散落在：内存 `LIVE[mid]`、`live_active[mid]`、`LiveRec.ws / done / timer / detached_at`、`ambient.holds`，磁盘 `meta.live_rec`、`meta.live_state`、`meta.rec_health`。

| phase | 条件 |
|---|---|
| recording | `ws` 不为空：有连接在送音频 |
| reconnecting | `ws` 为空、没收尾：等 `LIVE_GRACE_S`（默认 15 分钟）内带同一个 rec 重连 |
| ended | `done=True`：已收尾（stop / timeout / ended_by_user / takeover） |

跳转：新建 → recording；断线 `_live_detach` → reconnecting（起计时器）；重连 → recording；
`stop`、计时器到点、`/live/end`、另一个 rec 接管 → ended（`_live_finalize`，只执行一次）。
服务重启：meta 里有 `live_rec` 的 mic 会议 → `_restore_orphan` 直接建成 reconnecting。

---

## 4. 语音模型加载（`Engine`）—— 加了 `state_info()`，修了并发加载

| 主模型 main | 条件 |
|---|---|
| idle | 还没开始 |
| loading | `loading=True` |
| ready | `ready=True`（之后不会回退） |
| error | 加载失败，`error` 有原因；网页“重试”→ loading |

Nano（Fun-ASR-Nano）：unloaded → loading → ready / failed。failed 后不再自动重试（避免每句话都占着 GPU 锁重载），切换识别模型或手动重试时 `force=True` 重载。

修复：以前“检查 loading → 置 loading”不是原子的，网页连点“重试”会并发加载两遍模型（`reload_asr` 里还靠 `sleep(0.2)` 等标志置上）。现在用 `_state_lock` 保护。

---

## 5. 每日自动汇总（`AUTO_DAILY`）—— 挪到模块级，能查到

每个日期一条 `{"tries", "next", "done"}`：到点前不动 → 到点后生成 → 成功 done；没配 Key 每分钟再看；接口出错隔 30 分钟重试，最多 3 次后 done。
有会议在 recording / queued / transcribing 时等它们结束（23:40 后不等）。失败原因写 `data/daily/<日期>.auto.json`。
以前这个字典是 `_housekeeping` 的局部变量，外面看不到；现在 `/api/state` 的 `auto_daily` 能看到。

---

## 6. 回收站（目录位置就是状态）—— 未改

`data/meetings/<id>/`（正常） ↔ `data/discarded/<id>/`（自动丢弃，带 `discard.json`），7 天后删除。
恢复时有录音就排队精准转写；**新修**：没有录音的恢复后不再一直挂在 recording（有实时稿 ready，否则 new）。

---

## 7. 其他（只记录，未改）

| 状态机 | 散落位置 | 说明 |
|---|---|---|
| 纪要新鲜度 | minutes.json 的 `src_hash / notes_hash / from_live / edited` | 推导：新鲜 / 转写变了 / 笔记变了 / 手改过。`_minutes_stale`、`minutes_check.should_auto_refresh` |
| 本地大模型进程 | `_llm["proc"]` + 探测 `/models` | stopped / starting（我们起的、还没响应）/ running / exited（exit_code）/ 外部启动的 |
| 局域网 HTTPS | `lan.server.server/task/error` | running / error / 关闭；`apply()` 有 asyncio 锁 |
| 前端录音 `REC` | static/app.js：`active / paused / stopping / conn / retry / lost` | 网页端的录音、传输、重连状态 |
| 前端纪要生成 `GEN[id]`、`mdEditOrig`、`notesDirty` | static/app.js | 生成中 / 编辑中 / 笔记未保存 |

---

## 建议但未改

这些地方有改进空间，但改动面大或没法在不加载模型、不上真机的情况下验证，先不动：

1. **`live_active` 和 `LIVE` 是重复状态**：两者总是一起增删，`live_active` 可以改成从 `LIVE` 推导。涉及十几处读取和 test_live_resume 的接口字段，收益小。
2. **全天模式 stop→start 很快连按**：旧采集线程 5 秒没退出时，它退出时会把状态写回 off，新线程下一轮（≤1 秒）再改回来。只影响显示，没修。
3. **`_set_pause` 先写内存再加锁写设置**，和 `start()` 同时调用时理论上会覆盖；实际都由网页点击触发，没遇到。
4. **前端状态机**（`REC`、`GEN`）没动：没有浏览器端自动化测试，改了没法验证不破坏手机录音续传。
5. **会议状态没有记录“进入当前状态的时间”**（只有 transcribing 有 `job_started`）。要加需要往 meta.json 写新字段，等确有需要再加。
6. **重启恢复时 queued/transcribing 的会议被重新排队，顺序按 list_all（创建时间倒序）**，新的先转。是否要改成旧的先转，需要产品上决定。

---

## 附：打点与要点的存储（不是状态机，只记格式）

- 打点：`data/meetings/<id>/marks.json`，列表，每条 `{id, t_ms, label, created}`；`t_ms` 是录音的音频时间。没有这个文件就是没有打点，老会议不受影响。接口：`POST /api/meetings/{id}/marks`、`DELETE /api/meetings/{id}/marks/{mark_id}`，`GET /api/meetings/{id}` 多一个 `marks`。
- 要点：`minutes.json` 多一个 `highlights` 列表，每条 `{text, start_ms, end_ms, quote, verified}`；老纪要没有这个字段，页面显示一句提示。`get_meeting` 返回时给每条加 `marked`（前后 30 秒内有打点）。
- 导出：`GET /api/meetings/{id}/export?fmt=zip`。
