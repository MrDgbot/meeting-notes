# 平板、手机：证据表

日期 2026-10-24 ～ 25。环境：
- Mac：Xcode 26.4.1，iOS 26.4.1 模拟器（iPhone 17、iPad Air）。
- Playwright 1.64.1：Chromium、WebKit 27.2。
- 被测服务：临时实例 `127.0.0.1:8772` + 局域网 `8773`，数据是 `data/` 的副本。

所有测试都能复跑，命令见 README 的“测试”一节。**真机还没测**，清单见 [real-device-checklist.md](real-device-checklist.md)。

## 结论一览

| 结论 | 证据 | 第三方判定 |
|---|---|---|
| 断网后录音不停，恢复后补传，字节逐块一致 | `tests/test_live_resume.py` 6/6；`tests/mobile/rec-resume.mjs` 13/13：页面产生 1,907,200 字节 = Mac 收到 = pcm 文件 | pcm 逐块核对块号（服务端测试）；文件大小对账 |
| 连接“假活”能察觉 | 黑洞 10 秒，7.4 秒后主动重连 | 测试代理真的不转发数据 |
| 服务被杀掉重启后接着录 | SIGKILL 后在 pcm 末尾人为多写半块：重启后截到整块，从第 25 块续上，内容一致 | 同上 |
| 打断能记缺口，消息晚到不误报 | 音频挂起 5 秒 → 缺口 4989ms（interrupted）；主线程卡 4 秒 → 0 个缺口 | 音频时钟（AudioWorklet currentFrame）对照真实时间 |
| 降采样不丢样本、不失真 | `tests/audio/resampler.mjs` 19/19：44.1k 连续 10 分钟误差 1 个样本；通带误差 ≤ 0.43dB；9kHz 折叠残留 -51.8dB | Goertzel 频谱测量 |
| 320–1600px 两个引擎没有布局问题 | `tests/mobile/sweep.mjs`：Chromium、WebKit 各 1469 个状态，溢出、遮挡、WCAG 2.5.8 点击区域、裁字、JS 报错全为 0 | WebKit 是 Safari 的内核 |
| 可访问性 | axe-core（WCAG 2.2 AA）serious/critical：改前 54 次（对比度、控件无名称）→ 改后 0 | axe-core 4.x |
| 真 iPhone/iPad Safari 渲染正常 | iOS 26.4 模拟器截图（docs/evidence/ios26-*.png）：刘海、底部工具栏、iPad 竖屏都正常 | Mobile Safari 本身 |
| DNS rebinding、跨站请求被挡住 | `tests/test_lan_security.py` 35/35：伪造 Host → 421，跨站 POST / 跨站 WebSocket / 登录 CSRF → 403，正向对照全部 200 | curl 等价请求、websockets |
| 证书被滥用也冒充不了公网网站 | 根证书带名称限制（critical）。iOS 26.4 模拟器信任根证书后：192.168.5.246 的证书正常打开，127.0.0.1 的证书显示“此连接非私人连接” | **iOS 本身**、OpenSSL（permitted subtree violation）、curl |
| 只有局域网端口对外 | nmap 扫本机局域网 IP：只开放局域网端口，本机端口不对外 | nmap 7.x |
| 微信 / 飞书里打开有提示、后退关弹窗、缺口能看到、断线时能从别处结束 | `tests/mobile/ui-checks.mjs` 8/8 | WebKit |

## 改代码前（基线）

### 安全探测
| 探测 | 结果（改前） | 结果（改后） |
|---|---|---|
| `curl -H 'Host: evil.test:8770' http://127.0.0.1:8770/api/meetings`（真实实例） | **200，返回全部会议** | 421 |
| 伪造 Host + 跨站 Origin `PUT /api/lan` 改口令，再用新口令从局域网登录 | **200 / 303：攻击者能拿到局域网访问权** | 421 |
| 跨站“简单请求”（text/plain）`POST /api/asr/reload` | 处理函数被执行 | 403 |
| 跨站 WebSocket `/ws/ambient` | **被接受** | 拒绝 |
| 根证书 | 10 年，无名称限制 | 5 年，名称限制 critical：local、ts.net、10/8、172.16/12、192.168/16、100.64/10 |
| 局域网接口响应缓存 | 无 Cache-Control | no-store |
| 换着 IP 猜口令 | 只有按 IP 锁定 | 再加全局：10 分钟 20 次 → 全部暂停 10 分钟 |

顺带发现的回归：`POST /api/asr/reload` 一直返回 500（上一轮给 `health()` 加了 request 参数，这里漏传）。已修。

### 录音链路（读代码）
- 网络一断，前端就停止录音，服务端马上收尾转写。
- 断开期间产生的音频直接丢掉（`ws.readyState !== 1` 时不发送）。
- iOS 的 interrupted 状态没处理。

### 环境事实
- Mac 的局域网 IP 一天内从 192.168.5.211 变成了 192.168.5.246：用 IP 收藏的地址会失效，这不是假设。
- Mac 锁屏、显示器睡眠时，无头浏览器拿不到系统音频输出，AudioContext 时钟不走。浏览器测试改用 `--disable-audio-output`，用假的输出时钟，这和产品代码无关。
- 模拟器和 Mac 共用同一个 IP：在模拟器里输错口令会和 Mac 上的测试共用同一个锁定计数。

## 威胁模型（同一个 Wi-Fi 下有谁、能做什么）

| 威胁 | 场景 | 防法 | 证明 |
|---|---|---|---|
| 偷看会议 | 同一 Wi-Fi 的陌生人（咖啡馆、酒店、公司访客网） | 口令登录；没登录时接口 401、WebSocket 拒绝 | test_lan_security：401 / 拒绝 |
| 猜口令 | 同上，脚本暴力猜，换 IP（IPv6 临时地址） | PBKDF2 20 万次；同一 IP 5 次后锁定、逐次翻倍；全局 10 分钟 20 次暂停 | 测试：401×5 → 429；20 个 IP 后第 21 个也被暂停 599 秒 |
| DNS rebinding | Mac 上打开的恶意网页把自己的域名解析到 127.0.0.1，借“本机免登录”读会议、打开局域网访问并改口令 | Host 白名单（两个端口都生效） | 改前 200 → 改后 421 |
| 跨站请求 / 跨站 WebSocket / 登录 CSRF | 恶意网页让浏览器带着 Cookie 发请求 | Origin 必须等于 Host；Cookie 是 SameSite=Lax、HttpOnly、Secure | 403 / 拒绝 |
| 中间人 | 同一 Wi-Fi 的人冒充 Mac | HTTPS；手机信任的是这台 Mac 自己的根证书 | openssl s_client 用 TLS 1.3，校验通过 |
| 根证书私钥泄露（备份、同步盘、被盗） | 拿到 `ca.key` 的人给任意网站签证书，冒充银行、邮箱 | 名称限制：只能签私网 IP 和 .local / .ts.net；旧证书作废、私钥删除 | iOS、OpenSSL、curl 都拒绝越界证书 |
| 手机丢了 | 30 天 Cookie 还有效；浏览器缓存里有会议内容 | Mac 上“让所有设备退出”（换签名密钥）；接口 no-store | no-store 测试；退出测试（上一轮） |
| 被扫端口 | 局域网扫描 | 只开局域网 HTTPS 端口；本机端口只监听 127.0.0.1 | nmap |

没做：按设备单独退出登录、登录审计日志。题目里明确不做；目前可以靠“让所有设备退出”兜底。

## 标准逐项核对

| 条目 | 要求 | 结果 |
|---|---|---|
| WCAG 2.2 · 1.4.3 对比度 | 小字 4.5:1 | 灰字 #646464：白底 5.9、#f5f5f5 底 5.4、悬停底 4.6；红 #ce2c31；标签 #b42318 / #92400e；axe 0 |
| WCAG 2.2 · 1.4.4 文字放大 200% | 不丢内容 | 浏览器放大 200% 等于视口变窄一半：1280→640、640→320 都在扫描范围内，0 溢出、0 裁字 |
| WCAG 2.2 · 1.4.10 重排 | 320px 宽不用横向滚动 | 320px 起扫描：0 横向溢出 |
| WCAG 2.2 · 2.5.8 目标尺寸（最小） | 24×24 或满足间距例外 | 0 违规 |
| WCAG 2.2 · 4.1.2 名称、角色、值 | 控件有可读名称 | 所有 label.f 自动关联；下拉框补了 aria-label；axe 0 |
| Apple HIG 点击区域 44pt | 建议值 | 主要按钮、输入框、播放器、标签页、顶栏已达到 44；还有 43 种次要小控件（主要是 38px 的 sm 按钮）低于 44，属于建议项 |
| Apple 受信任证书要求（[support.apple.com/103769](https://support.apple.com/en-us/103769)） | RSA ≥ 2048、SHA-2、DNS 名在 SAN、EKU serverAuth、≤ 825 天 | 全部满足（服务器证书 800 天） |
| OWASP ASVS · 会话管理 | Cookie 加 HttpOnly / Secure / SameSite，能作废 | 满足；“让所有设备退出”会换签名密钥 |
| OWASP ASVS · 认证 | 防暴力猜测 | 按 IP + 全局限速 |
| OWASP ASVS · 访问控制 / 防 CSRF | 改数据的请求要有来源校验 | Origin = Host |
| OWASP ASVS · 通信 | TLS 1.2+ | TLS 1.3 |

## 这次没测到、没做到的

- **真机**：所有 iPhone / iPad / 安卓上的录音行为，包括锁屏、来电、后台、AirPods、2 小时连续录音、电量和发热。
  - iOS 模拟器里本来要实测登录后录音、锁屏缺口、键盘、不装证书时实时转写能不能连。这几项需要接管屏幕操作模拟器，问你时 10 分钟没有回复，按默认跳过了。
- **键盘挡不挡笔记框**：没有证据，就没改代码（只给安卓 Chrome 加了 `interactive-widget=resizes-content`）。列在真机清单 C1。
- **CER**：还没有人工校对的标准文本，也没有同场 Mac + iPhone 的录音。工具 `tests/audio/cer.py` 已经备好；“不高于 Mac 3 个百分点”这条线还没验证。
- **麦克风降噪 / 自动增益开关的 A/B**：同上，依赖真机和标准文本，默认值没改。
- **不知情用户测试**：需要你找人。
- **2 小时漂移**：降采样器 10 分钟误差 1 个样本，按比例算 2 小时约 12 个样本（< 1ms）。设备音频时钟和墙钟之间的漂移要真机测。
- Mac 等重连的时间：计划里写的是 120 秒，网页缓存上限写的是 15 分钟，两个数字互相矛盾（Mac 先放弃，网页存着的音频就白存了）。统一成 15 分钟，并在别的设备上提供“现在结束”。
