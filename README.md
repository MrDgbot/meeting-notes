<div align="center">

# meeting-notes

**录音不出本机的 AI 会议记录**

实时转写 · 说话人区分 · AI 纪要 · 会议问答 · 全天自动记录 · 手机当麦克风

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20%C2%B7%20Apple%20Silicon-lightgrey)
![Python](https://img.shields.io/badge/python-3.11-3776AB)

</div>

![会议详情：左边纪要，右边带说话人的转写稿](docs/images/desktop-meeting.png)

## 为什么做

会议占掉团队大量时间，会后留下来的却常常只有几行零散笔记。主流 AI 会议记录产品（飞书妙记、通义听悟、Otter.ai 等）都要把录音传到云端处理，这带来三个问题：

- **不能用**：客户、财务、人事、未发布产品相关的会议，很多公司和行业（律所、咨询、投研、医疗）对上传录音有严格限制。
- **不放心**：录音一旦上传，存多久、给谁看、拿不拿去训练模型，用户控制不了。
- **离不开网络**：断网、弱网、出差路上都用不了。

meeting-notes 把整条链路搬到用户自己的电脑上。语音识别、说话人区分都在本机完成，录音不出本机。纪要可以交给云端大模型（只发文字），也可以用本地大模型，全程离线。

## 能做什么

| 功能 | 说明 |
|---|---|
| **实时转写** | 边开会边出字。可以只录麦克风，也可以同时录电脑声音（线上会议），也能上传已有的录音、视频文件 |
| **会后精准转写** | 录音结束后自动用更大的模型整段重转：分段、补标点，按说话人整理成段落 |
| **说话人区分** | 自动判断有几个人，也可以手动指定；给发言人改名，全篇同步 |
| **AI 纪要** | 6 种会议模板：通用、周会、客户访谈、招聘面试、头脑风暴、讲座。输出概要、议题、决议、待办（负责人、截止时间）、各人观点、待跟进问题，每条都带可点击的时间戳出处 |
| **纪要过期提醒** | 改了转写稿、发言人名或笔记之后，纪要会提示“可能已过期”，问答也不再引用旧纪要 |
| **会议问答** | 针对一场会追问细节，只依据会议内容回答，并注明时间和发言人 |
| **全天模式** | 不用开网页，后台持续监听麦克风。有人说话才录音，静音 5 分钟自动切成一段对话并精准转写；每晚 21:30 自动生成当日汇总 |
| **手机、平板当麦克风** | 局域网 HTTPS 访问。断网照录，连回来自动补传，不丢也不重；锁屏、来电造成的空白会标在转写稿里 |
| **词库** | 常用热词提高专有名词的识别率；纠错规则把固定认错的词自动改对，对已有记录立即生效 |
| **搜索与导出** | 全文搜索标题、转写、笔记和纪要；导出 Markdown、TXT、SRT 字幕 |

<table>
<tr>
<td width="50%"><img src="docs/images/desktop-recording.png" alt="录音中"><br><sub>录音中：边说边出字，旁边记笔记，一键插入时间点</sub></td>
<td width="50%"><img src="docs/images/desktop-transcript.png" alt="转写稿"><br><sub>转写稿：按说话人着色，时间戳可点，跟随播放</sub></td>
</tr>
<tr>
<td><img src="docs/images/desktop-qa.png" alt="会议问答"><br><sub>会议问答：回答带时间戳出处</sub></td>
<td><img src="docs/images/day-summary.png" alt="当日汇总"><br><sub>当日汇总：一天的会议串成时间线，汇总决定和待办</sub></td>
</tr>
</table>

<p align="center">
<img src="docs/images/mobile-minutes.png" width="300" alt="手机上看纪要">&nbsp;&nbsp;&nbsp;<img src="docs/images/mobile-transcript.png" width="300" alt="手机上看转写稿">
<br><sub>手机、平板上用同一套页面：看纪要、看转写稿，也能直接录音</sub>
</p>

<sub>截图里的会议、人名、公司都是虚构的演示数据。</sub>

## 和云端会议记录产品的区别

| | meeting-notes | 云端会议记录产品 |
|---|---|---|
| 录音存在哪 | 自己的电脑（`data/` 目录） | 服务商的服务器 |
| 语音识别、说话人区分 | 本机 | 云端 |
| AI 纪要 | 云端大模型（只发文字），或本地大模型（全程离线） | 云端 |
| 断网能不能用 | 能 | 不能 |
| 使用成本 | 识别不花钱；纪要用云端大模型时只付 token 费（按 qwen-plus 公开价估算，一小时会议几分钱） | 一般按时长额度或订阅收费 |
| 源码 | 开源（AGPL-3.0），可以自己审计 | 闭源 |

## 效果：公开数据集实测

用 [AliMeeting](https://www.openslr.org/119/)（M2MeT 挑战赛的中文会议语料）测试。取会议室桌上麦克风阵列的一路远场录音：多人围坐、频繁抢话，是公认难做的场景。全部用产品自己的转写流程、全自动（不告诉它有几个人），用 dscore、pyannote、sclite、jiwer、MeetEval 等多套独立打分器交叉核对。

**AliMeeting Test 集：20 场，10.8 小时**

| 指标 | 结果 |
|---|---|
| 两人会议的字错率（8 场） | **8.8%** |
| 说话人人数判对 | **13 / 20 场** |
| 说话人分离错误率 DER（collar 0.25 秒，含重叠） | **27.3%** |
| 处理速度（Apple M5 Pro） | 1 小时录音约 3–9 分钟转完 |

**改进都有数据支撑。** 改算法之前，先写下评测方案和判定标准，再在开发集上选方案，最后在留出集上只测一次，不回头调参数。最近一次是改说话人聚类：留出集上人数判对从 9 场升到 13 场，DER 从 28.2% 降到 27.3%。评测脚本都在 [tests/eval](tests/eval/README.md)，可以复现。

## 工作原理

```mermaid
flowchart LR
  A["电脑浏览器<br/>麦克风 / 电脑声音"] -->|"16 kHz PCM · WebSocket"| S["本机服务<br/>FastAPI"]
  B["手机、平板<br/>局域网 HTTPS"] -->|"断线自动补传"| S
  C["全天模式<br/>后台监听麦克风"] --> S
  S --> L["实时转写<br/>流式 VAD + Paraformer / Fun-ASR-Nano"]
  S --> F["会后精准转写<br/>VAD + Fun-ASR-Nano + CAM++ 声纹聚类 + 标点"]
  F --> M["AI 纪要 · 问答 · 当日汇总<br/>云端大模型 或 本地 llama-server"]
  F --> D[("本机文件<br/>data/meetings")]
  M --> D
```

- **语音**：[FunASR](https://github.com/modelscope/FunASR) 的 Paraformer-zh、Fun-ASR-Nano、FSMN-VAD、CT-Punc、CAM++，在 Mac 上用 Apple GPU（MPS）运行。
- **大模型**：任何 OpenAI 兼容接口，默认阿里百炼 qwen-plus，也可以选 DeepSeek，或本地 llama-server。
- **前端**：原生 JavaScript，没有构建步骤。用 AudioWorklet 在浏览器里降采样到 16 kHz。电脑、平板、手机共用一套页面，按屏幕宽度自动换布局。

## 快速开始

**环境**

- macOS + Apple Silicon（目前只在这个平台上验证过）
- [uv](https://docs.astral.sh/uv/) 和 ffmpeg：`brew install uv ffmpeg`
- 内存：语音模型常驻约 9–10 GB（实测），建议 16 GB 以上；本地大模型另需约 38 GB，用云端纪要就不需要
- 磁盘：第一次启动会自动从 ModelScope 下载约 4 GB 语音模型

**运行**

```bash
git clone https://github.com/MrDgbot/meeting-notes.git
cd meeting-notes
./start.sh                 # 自动安装依赖、下载模型，然后打开 http://127.0.0.1:8770
```

![首页：新建会议，选模板、人数、热词和音频来源](docs/images/desktop-home.png)

AI 纪要要配一个大模型接口：在网页“设置”里填 API Key，或者用环境变量 `DASHSCOPE_API_KEY` / `DEEPSEEK_API_KEY` 提供。不配也能录音和转写。

手机、平板访问、全天模式、各项参数和测试方法，见 [使用说明](docs/guide.md)。

## 隐私：什么会离开你的电脑

| 功能 | 离开本机的数据 |
|---|---|
| 录音、实时转写、精准转写、说话人区分、全天模式 | 无 |
| AI 纪要、问答、当日汇总，用云端大模型 | 转写文字和笔记，只发给你自己配置的接口 |
| AI 纪要、问答、当日汇总，用本地大模型 | 无 |
| 手机、平板访问 | 只在局域网内传输：HTTPS 加密，要输访问口令 |
| 憨包云端识别（实验性，默认没有，要自己配置） | 录音片段 |

局域网访问默认关闭。打开后用的是这台 Mac 自己签发的根证书，并带名称限制：只能给内网地址签证书，就算证书私钥泄露，也冒充不了任何公网网站。此外还防 DNS rebinding 和跨站请求，口令只存哈希，输错多次会锁定。这些都有对抗测试覆盖（`tests/test_lan_security.py`）。

## 已知短板

说清楚现在做不好的地方：

- **多人同时说话会漏字**：AliMeeting 上重叠发言约占说话时间的 20%，目前每个时刻只认一个人。3–4 人、频繁抢话的会议，字错率在 33%–47%。下一步是做重叠检测。
- **4 人的会议，人数容易判少**：知道人数时手动填上，效果明显更好。
- **平台**：目前只在 macOS（Apple Silicon）上验证过。全天模式依赖 macOS 的录音接口，Windows、Linux 还没有适配。

## 文档

- [使用说明](docs/guide.md)：每个功能的具体行为、参数、数据存放位置、测试命令
- [手机、平板能力边界](docs/mobile-limits.md)，[真机验收步骤](docs/real-device-checklist.md)，[手机端测试证据](docs/mobile-evidence.md)
- [评测脚本](tests/eval/README.md)：AliMeeting 数据准备、转写、打分

## 许可证

Copyright (C) 2026 MrDgbot

本项目以 [GNU AGPL-3.0](LICENSE)（或更高版本）发布：可以自由使用、修改、再发布；改过的版本只要发给别人，或者部署成服务让别人通过网络使用，就必须以同样的许可证公开完整源码。
语音模型（FunASR、Fun-ASR-Nano 等）运行时从 ModelScope 下载，不在本仓库里，各自遵守其模型许可证。
