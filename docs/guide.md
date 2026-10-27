# 使用说明

[README](../README.md) 讲这是什么、为什么做；这里写每个功能的具体行为、参数和边界，以及怎么测试。

## 启动

都要先装 [uv](https://docs.astral.sh/uv/) 和 ffmpeg（含 ffprobe）。第一次启动会下载约 4GB 语音模型到 `~/.cache/modelscope`（`MODELSCOPE_CACHE` 可以改位置）。

### macOS

```bash
brew install ffmpeg
./start.sh                        # 打开 http://127.0.0.1:8770
./scripts/start-local-llm.sh      # 可选：本地大模型（完全离线纪要）；也可以在“设置”里点“启动本地模型”
```

### Linux

```bash
sudo apt install ffmpeg           # Debian / Ubuntu；全天模式用 PulseAudio / PipeWire 采音，桌面系统一般已经有了
./start.sh                        # 有 NVIDIA 显卡：uv 按 uv.lock 装带 CUDA 的 torch，自动用 GPU
bash scripts/install-linux-cpu.sh && UV_NO_SYNC=1 ./start.sh   # 没有显卡：装 CPU 版 torch（少下载 3GB 多），以后都这样启动
```

`UV_NO_SYNC=1` 不能省：不加的话 `uv run` 会按 uv.lock 把 CUDA 版 torch 装回来。

### Windows

PowerShell 里：

```powershell
winget install astral-sh.uv Gyan.FFmpeg    # 装完重开 PowerShell，让 PATH 生效
.\start.ps1                                # 打开 http://127.0.0.1:8770；提示“禁止运行脚本”时用 powershell -ExecutionPolicy Bypass -File start.ps1
```

`start.ps1` 会设 `PYTHONUTF8=1`（中文文件名、设备名按 UTF-8 处理），自己用 `uv run uvicorn …` 启动时也请设上。
Windows 上的 torch 是 CPU 版；要用 NVIDIA 显卡，需要自己把 torch 换成 CUDA 版（见 pytorch.org 的安装说明）。

### Docker（Linux 容器，CPU）

```bash
docker build -t meeting-notes .
docker run -d --name meeting-notes -p 127.0.0.1:8770:8770 -e MN_LOCAL_CLIENTS=172.17.0.1 \
  -v ~/.cache/modelscope:/models:ro -v ~/meeting-data:/data meeting-notes
```

- 模型目录挂宿主机的 `~/.cache/modelscope`（只读也行，前提是模型都已经下载好），不挂的话每次新建容器都要重新下载。数据在 `/data`。
- 端口映射进来的请求来源是 Docker 网桥网关（默认 `172.17.0.1`），不是 127.0.0.1，会被当成局域网设备要求登录。
  `MN_LOCAL_CLIENTS`（逗号分隔的 IP 或网段）把这些来源当作本机。**只在端口映射到 `127.0.0.1` 时这样设**，否则局域网里谁都能免口令进来。
  网关地址用 `docker network inspect bridge` 查。
- 全天模式要用宿主机的 PulseAudio / PipeWire：把宿主机的声音服务套接字挂进来，
  `-v /run/user/$(id -u)/pulse/native:/run/pulse.sock -e PULSE_SERVER=unix:/run/pulse.sock`。
  容器里没有声音服务时，全天模式会退回 ALSA，再打不开就在网页上显示“无法打开麦克风”。
- 局域网访问（手机、平板）在容器里要再映射 8771 端口，网页上显示的访问地址是容器内的地址，要换成宿主机的 IP。

## 识别、纪要和数据

- 语音识别：FunASR（Paraformer-zh + FSMN-VAD + CT-Punc + CAM++），有 NVIDIA 显卡时用 CUDA，Apple Silicon 用 MPS，否则用 CPU；模型缓存在 `~/.cache/modelscope`。
  加载失败时左下角显示“语音模型加载失败 · 重试”，点一下重新加载（不用重启服务）；加载好后，之前因此转写失败的记录自动重新转写。
  Fun-ASR-Nano 加载失败会暂用 Paraformer，不会每句话都重试，在“设置 · 语音识别”里可以“重试加载”。
- 会后精准转写的几个处理（选法和测试结果见 [docs/improvements.md](improvements.md)）：
  - 音量归一：整段录音偏小声时，先按 RMS 放大到 -30 dBFS（只放大、最多 +30 dB、峰值软限幅）再检测语音和识别。离麦克风远、说话小声的人不再被整段当成静音。
    录音本来就够响时不做任何处理。实时转写不受影响。开关是 `asr_engine.LEVEL_USE`。
  - 按说话人拆句：Nano 常把两个人的话识别成一句；按逐字时间戳看声纹，句中换了人、而且换过去的人连续说了 1 秒以上，就在那里切开（`SPLIT_MIN_MS`）。
  - 区分说话人（“设置 · 语音识别 · 区分说话人”）：
    - 标准（默认）：CAM++ 声纹聚类。笔记本、手机放在桌上录，或线上会议，用这个。
      总共说话不到 30 秒的人会被并进声音最像的人；语音不到 5 分钟的短录音，这个门槛按语音时长的 10% 放低（`SPK_MIN_FRAC`），不然一两分钟的录音全成了一个人。
    - 会议室远场：多人围坐、离麦克风远、经常抢话的会议室录音。用 [pyannote](https://github.com/pyannote/pyannote-audio) community-1（自带重叠检测），再用 CAM++ 声纹合并太像的说话人。
      第一次用时从 ModelScope 下载约 31 MB 模型；在单独的子进程里用 GPU 跑（`diarize_worker.py`），不占实时转写的 GPU 锁；出错时自动退回标准方式。
      pyannote 默认会发用法统计，这里强制关掉，断网也能跑。近场录音别选它：它会把说得最多的人拆成两个。
- 憨包云端识别（实验性，默认没有）：会后转写的文字交给云端识别，说话人分离仍在本机，失败的段用本机模型补。
  它用的是非公开接口，仓库里不带服务地址、应用标识和设备参数；要用就自己准备 `data/hanbao.json`
  （或用环境变量 `HANBAO_CONFIG` 指定文件，字段见 `hanbao_asr.py` 的 `config()`），没有这个文件时设置里不出现这一项。
  录音会上传到对方服务器；是否有权这样调用、是否符合对方服务条款，由使用者自己确认，接口随时可能失效。
  这个接口不接受热词（试过的几种传法都没有效果），热词只在它没出字、改用本机补识别时才用得上，所以要靠下面的“可能认错的热词”提示。
- AI 纪要：OpenAI 兼容接口，在网页“设置”中配置（默认阿里百炼 qwen-plus，可选 DeepSeek / 本地 llama-server）。
  API Key 也可用环境变量 `DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` 提供。
  接口删多了可以点“恢复默认接口”；已保存的 Key 可以“清除”。
  推理模型（Gemini 2.5、DeepSeek V4 等）的思考也算在 `max_tokens` 里，产品各处默认的上限（纪要 6000）不够用，会只写一半，甚至只思考、不出正文：
  在这个接口的“额外请求参数”里填 `{"max_tokens": 32000}`（会覆盖各处的上限）。输出被截断、或者一个字正文都没有时，会报错并说明原因，不保存半截内容。
  开着思考时，模型往往要先想一两分钟才出第一个字，页面上会显示“正在思考，已 N 秒”。支持关掉思考的接口可以在额外请求参数里加 `"reasoning": {"enabled": false}`：
  在一场 95 分钟的周会上，DeepSeek V4.1 Flash 关掉思考后纪要 30 秒写完（开着要 70–100 秒），要点不比开着少（比法见 [docs/improvements.md](improvements.md) 第二轮）。
- 纪要提示词要求：数字照抄转写、不改成范围；每个时间戳单独一对方括号（写成 `[16:21, 17:31]` 的也能点，两个时间分别可点）；读音像热词、上下文说不通的，按热词写。
- 可能认错的热词：转写页顶上列出读音和热词很像、又不是常用词的说法（比如“陈伟驰”→“长尾词”），点“改”加一条纠错规则，所有记录立即生效；不点就什么都不改。
  只看 3–8 个汉字的热词（`vocab.suspects`，条件和检验见代码注释和 `tests/eval/hotword_suspects.py`）。
- 推测姓名：转写页说话人一栏的“推测姓名”，让 AI 从转写里找自我介绍、“某某你说一下”之后开口的人这类直接线索。
  模型给的原话会逐字核对（必须在它说的时间前后 90 秒内出现，且至少有一句是这个人自己说的），核对不上的丢掉；只给建议，勾选后才改名。会把转写文字发给所选的大模型接口。
- 纪要生成时记下所用转写和笔记的指纹（`minutes.json` 的 `src_hash` / `notes_hash`）；之后改字、改说话人名、加纠错规则、重新转写或续录，
  纪要页会提示“可能已过期”，问答和当日汇总也不再引用这份旧纪要。当日汇总同理（新增记录或内容有改动时提示）。
- 手动改过的段落不再套纠错规则（用户改成什么就是什么）。
- 侧栏搜索同时搜标题、转写、笔记和纪要（`/api/search`）。左上角“会议记录”回到首页。
- 数据保存在 `data/meetings/<id>/`：audio.pcm/wav/mp3、live.json（实时稿）、transcript.json、minutes.json、notes.md、qa.json。

## 平板、手机

网页按宽度自动换布局：

- 宽度 ≥ 900px（电脑、iPad 横屏）：左侧栏常驻；主区域 ≥ 1100px 时可以分屏（左纪要、右转写稿）。
- 900px 以下（iPad 竖屏、手机横屏）：侧栏收成抽屉，点左上角菜单拉出，点遮罩、向左滑或按 Esc 收起；顶栏显示录音时长，菜单按钮上的小圆点是全天模式状态。
- 700px 以下：首页表单、录音页、当日页、设置都改成一栏。
- 600px 以下（手机竖屏）：播放器进度条换到第二行；录音控制条吸顶；弹窗改成从底部升起的面板；纪要里的宽表格可以横向滑动。
- 触屏：
  - 靠悬停才出现的入口（转写段落的改字铅笔、日期旁的“当日汇总”）常显。
  - 主要按钮、输入框按 Apple HIG 做到 44pt；时间戳、“当日汇总”等小目标用看不见的扩大点击区。
  - 输入框字号 16px，iOS 聚焦时不会放大页面。
  - 返回手势或后退会先关掉弹窗。
- 文字对比度满足 WCAG AA：灰字 `--muted` 是 #646464，红色是 #ce2c31，标签用更深的红、琥珀色。
- 在微信、飞书、钉钉、QQ、支付宝里打开时，页面底部和登录页都会提示“在浏览器打开”。

### 手机、平板录音

能力边界（每条都标了实测或一手资料出处）和替代方案见 [docs/mobile-limits.md](mobile-limits.md)，真机验收步骤见 [docs/real-device-checklist.md](real-device-checklist.md)。

- **断网不停录**：
  - 音频按 100ms 一块顺序发送，Mac 每秒回一次“已落盘多少字节”；没确认的块留在网页内存里，最多 15 分钟。
  - 断线后网页带同一个录音编号（`rec`）自动重连，Mac 告诉它 pcm 已经写到哪里，网页从那里补发，不丢也不重。
  - 8 秒没收到确认就当连接“假活”，主动重连。
  - Mac 等重连的时间默认 15 分钟（环境变量 `LIVE_GRACE_S`），超时才收尾转写。这段时间里别的设备上能看到“正在等它连回来”，可以点“现在结束”。
  - 服务被重启时也一样：正在录的会议先不转写，等网页连回来接着录。
  - 结束录音时如果连不上，先把剩下的传完再结束，也可以点“不等了”。
- **缺口记账**：
  - 音频时钟停了（来电、Siri、页面被挂起）或者麦克风静音（被占用、切到后台）超过 1.5 秒，就记一个缺口，写明位置、时长和原因。
  - 消息只是晚到（主线程卡、后台节流）时不算缺口。
  - 缺口会标在实时稿和转写稿里；会议头部显示“录音完整 / 录音有 N 处缺口”。
  - 明细在 `meta.json` 的 `rec_health`：网页产生的字节、Mac 收到的字节、因缓存满丢掉的字节、重连次数、缺口。
- 录音时会申请不让屏幕自动锁上。手机浏览器录不了电脑声音，“麦克风 + 电脑声音”会灰掉。

### 平板、手机访问（局域网，默认关闭）

在 Mac 上打开“设置 · 平板、手机访问”，设好访问口令（至少 6 位）后打开开关：

- 另开一个 HTTPS 端口（默认 8771，监听所有网卡），原来的 `127.0.0.1:8770` 不变。在这台 Mac 上访问不要口令；从别的设备来的请求要先登录（Cookie 30 天）。
- 设置页显示访问地址（Wi-Fi IP、`xxx.local`、Tailscale）和二维码，还有“手机、平板打不开？”的排查清单（同一 Wi-Fi、客户端隔离、.local、IP 变了、睡眠、防火墙、微信）。
  可以“让所有已登录的设备退出”。开关、口令、端口只能在 Mac 上改。
- 证书：
  - 第一次开启时在 `data/lan/` 生成这台 Mac 专用的根证书（5 年）和服务器证书（800 天），IP 变了会自动重签，根证书不变。
  - **根证书带名称限制**：只能给私网 IP（10/8、172.16/12、192.168/16、Tailscale 100.64/10）和 `.local` / `.ts.net` 签证书。手机信任它以后，就算 `ca.key` 被人拿走，也冒充不了任何公网网站（iOS 26.4 模拟器、OpenSSL、curl 都实测拒绝越界证书）。
  - 旧版没有名称限制的根证书会被自动作废（删掉私钥）并重新生成；之前装过旧证书的设备要删掉旧描述文件后重新安装，设置页会提示 30 天。
  - 手机第一次打开会提示“不安全”，点“继续访问”即可登录。建议装上并信任根证书（登录页有“下载证书”和步骤）：不装的话每次都有警告，部分 iOS 版本上实时转写连接会连不上。
- 防 DNS rebinding 和跨站请求（两个端口都生效）：
  - Host 必须是本机地址：127.0.0.1、localhost、本机 IP、`xxx.local`、Tailscale 名字，另外可以用 `MN_ALLOWED_HOSTS` 加。不符合时返回 421。
  - 改数据的请求和所有 WebSocket，Origin 必须和 Host 一致，否则返回 403。
- 局域网设备拿到的接口响应都带 `Cache-Control: no-store`，会议内容不留在手机缓存里。
- 口令只存 PBKDF2 哈希（`data/lan/config.json`）。
  - 同一 IP 输错 5 次后锁定，时间逐次翻倍（30 秒起，最长 1 小时）。
  - 所有来源合计 10 分钟内错 20 次，全部暂停登录 10 分钟，防止换着 IP 猜。
- Mac 睡眠时手机连不上；开着全天模式时 Mac 不会自动睡眠。

## 全天模式

侧栏打开“全天模式”开关后，服务在后台直接用电脑的麦克风持续监听（不需要开着网页）：

- 采音用 ffmpeg，按系统选输入：macOS 用 avfoundation；Linux 有 PulseAudio / PipeWire（pipewire-pulse）时用 `-f pulse`，
  没有就用 ALSA；Windows 用 DirectShow（`-f dshow`）。“设置 · 全天模式”的麦克风列表也按系统列出
  （Linux 列 PulseAudio 的 source 名，含 `xxx.monitor` 这种“录电脑正在放的声音”的设备）。
  选“系统默认输入”时，macOS、Linux 用系统默认设备；Windows 的 DirectShow 没有“默认设备”，用列表里第一个。
  选好的设备不在了（如外接麦克风拔掉）先用默认设备录，每 30 秒看一次，回来后自动切回。

- 只有 VAD 检测到有人说话才录音和识别；没人说话时只跑 ffmpeg + FSMN-VAD（每 0.3 秒一块，VAD 约占单核 3%）。
- 收音灵敏度（标准 / 高 / 很高，对应 VAD `speech_noise_thres` 0.6 / 0.4 / 0.2）默认“高”：离得远、小声的人也能录到；杂音触发的片段识别不出字，不计入有效发言。
- 网页开着时通过 `/ws/ambient` 推送：开口约 0.4 秒显示“有人在说话”，说话过程中每秒出临时文字（灰色），说完约 1 秒定稿；网页在后台时退回轮询，且不出临时文字。
- 静音超过 N 分钟（默认 5）结束一段对话 → 精准转写 + 说话人区分；单段最长 120 分钟。
  有效发言不足 20 秒的片段丢弃，但写过笔记、改过标题/文字、生成过纪要或问答的保留；正在看的那段被丢弃时网页会说明原因。
  自动记录的标题“自动记录 HH:MM”只是占位，生成纪要后自动换成纪要的标题。
- 对话内的长静音压缩到 1.5 秒；转写稿显示真实钟点时间（`segmap.json` 记录对话时间 → 墙钟的映射）。
- 精准转写后只保留 mp3；自动记录的录音默认保留 30 天（文字永久保留；转写失败的不删，留着重新转写）。调小保留天数时会先提示要删几段。
- 每天 21:30 自动生成当日汇总（需配置 AI 接口），也可在侧栏日期旁的“当日汇总”页手动生成；汇总存于 `data/daily/<日期>.json`。
  到点时还有对话在记录/转写会等它结束（最晚 23:40）；到点前手动生成过、之后又有新内容的会重新生成。
  没配 Key 时每分钟再检查一次（配好后自动补上），接口出错隔 30 分钟重试、最多 3 次；失败原因写在 `data/daily/<日期>.auto.json`，当日页面会显示。
- 暂停时立即关闭麦克风；暂停状态存在设置里，服务或电脑重启后仍保持暂停（手动打开开关才清掉）。网页里手动录音时自动让出麦克风。
  开启期间阻止空闲休眠：macOS 用 `caffeinate`（合盖用电池仍会休眠），Linux 用 `systemd-inhibit`（没有 systemd 时不阻止），
  Windows 用 `SetThreadExecutionState`；屏幕照常熄灭。
- 所有参数在“设置 · 全天模式”中调整，保存在 `data/settings.json` 的 `ambient` 字段；服务重启后按上次开关状态自动恢复。
- 测试：`MEETING_DATA=/tmp/xx AMBIENT_TEST_FILE=xx.wav AMBIENT_TEST_READRATE=4 ./start.sh` 用音频文件代替麦克风，数据写到临时目录、不碰真实记录。

## 测试

```bash
.venv/bin/python tests/test_platform.py         # 各系统的采音设备列表解析、ffmpeg 采音参数、本机地址、阻止休眠（不加载模型）
.venv/bin/python tests/smoke_e2e.py             # 端到端：自己起临时服务，上传一段普通话录音，paraformer / nano 各转写一次
.venv/bin/python tests/smoke_e2e.py --modes "" --ambient-play "paplay -d mn {wav}"   # Linux：全天模式从 PulseAudio 采音（见下）
.venv/bin/python tests/test_live_resume.py      # 断网补发、半开连接、抢录、换人续录、等不到重连、服务重启（自己起临时服务）
.venv/bin/python tests/test_lan_security.py     # 伪造 Host、跨站请求/WebSocket、登录限速、no-store、开放端口（有 nmap 用 nmap）、证书名称限制（OpenSSL 验证）
.venv/bin/python tests/test_diarize_cluster.py  # 说话人聚类后处理：短录音的小簇门槛按比例放低；噪声块归属、小簇并入、合并阈值、指定人数不变（几秒）
.venv/bin/python tests/test_split_level.py      # 音量归一、逐字时间、按说话人拆句、pyannote 说话人合并、区分说话人的设置（几秒）
.venv/bin/python tests/test_diarize_offline.py  # pyannote 子进程：断网能跑完、一次网络连接都不发起、用法统计已关闭
.venv/bin/python tests/test_cloud_asr_config.py # 云端识别没配置时不可用、不出现在选项里、不发请求
.venv/bin/python tests/test_llm_stream.py       # 大模型输出被截断、只思考没正文时报错；额外请求参数覆盖 max_tokens（假接口，几秒）
.venv/bin/python tests/test_vocab_names.py      # 可能认错的热词（多音字、词边界、常用词不报）；推测姓名的原话核对（几秒）
node tests/audio/resampler.mjs                  # 浏览器端降采样：样本数、通带、抗混叠
cd tests/mobile && npm install && npx playwright install chromium webkit
MN_URL=http://127.0.0.1:8772 node sweep.mjs     # 320–1600px 每 10px × Chromium/WebKit：溢出、遮挡、点击区域、裁字、axe（WCAG 2.2 AA）
MN_URL=... MN_WAV=会议录音.wav MN_DATA=数据目录 node rec-resume.mjs   # 真浏览器 + 假麦克风：断网、黑洞、卡顿、打断、断网时结束
MN_URL=... MN_LAN=https://<IP>:<端口> node ui-checks.mjs            # 微信/飞书提示、后退关弹窗、缺口标记、断线等重连
.venv/bin/python tests/audio/cer.py 标准文本.txt <会议ID> --from 10:00 --to 12:00  # 字错率
```

`.github/workflows/ci.yml` 在 Ubuntu、Windows、macOS 上跑上面的 Python 测试，在 Ubuntu、Windows 上跑端到端转写（GitHub 的 macOS 虚拟机上 MPS 结果不对）；Ubuntu 上另外建一个
PulseAudio 虚拟声卡（`pactl load-module module-null-sink sink_name=mn`，默认输入设成 `mn.monitor`），把录音放进去测全天模式。
Windows 上（Python 测试里的 `.venv/bin/python` 换成 `uv run python`）没有真实麦克风可测，DirectShow 采音只测了设备列表解析。

在 Mac 上验证 Linux 版：按上面的 Docker 步骤起容器（端口换成 8780 之类，数据目录用临时目录），然后
`python3 tests/smoke_e2e.py --url http://127.0.0.1:8780 --wav <录音>`；全天模式在容器里装 `pulseaudio`、起 null sink 后用
`--ambient-play "docker exec <容器> paplay -d mn /tmp/s.wav"`。

浏览器测试要连一个用临时数据目录起的服务（`PORT=8772 MEETING_DATA=/tmp/xx .venv/bin/python -m uvicorn app:app --port 8772`），不要对着真实数据跑。证据和结果汇总在 [docs/mobile-evidence.md](mobile-evidence.md)。
