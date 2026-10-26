# 手机、平板录音：能力边界和替代方案

浏览器在手机上录音有一些做不到的事。这里每一条都标了依据：**实测**（这台 Mac 上跑过的测试）、**一手资料**（WebKit / Apple / MDN 官方页面或 bug 记录），或者**未实测**（还要在真机上确认）。

## 能力边界

| 情况 | iPhone / iPad Safari | 微信、飞书等应用里打开 | 安卓 Chrome | 依据 |
|---|---|---|---|---|
| 网络断开（Wi-Fi 抖动、换网络、Mac 重启服务） | 录音不停：先存在手机内存里（最多 15 分钟），连上后自动补传，Mac 那边逐字节对上 | 同左 | 同左 | **实测**：tests/test_live_resume.py、tests/mobile/rec-resume.mjs（Chromium） |
| 连接“假活”（换网络后旧连接成了黑洞） | 8 秒没收到 Mac 的确认就主动重连 | 同左 | 同左 | **实测**：rec-resume.mjs 黑洞 10 秒，7.3 秒察觉 |
| 切到后台 / 锁屏 | 正在用麦克风的 Safari 页面在后台一般不会被挂起，但不保证；停了的话转写稿里会标出缺口 | **一定会停**：iOS 上非 Safari 应用切到后台时，WebKit 会把麦克风静音 | 未实测 | 一手资料：[WebKit bug 204681 评论](https://bugs.webkit.org/show_bug.cgi?id=204681)、[WebKit changeset 268791](https://trac.webkit.org/changeset/268791/webkit)；真机**未实测** |
| 来电、Siri、别的应用占用麦克风 | 录音会被打断（音频进入 interrupted 状态），回到页面后可能要点一下“继续录音” | 同左 | 未实测 | 一手资料：[MDN BaseAudioContext.state](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)；**实测**：模拟打断 5 秒，记下 4989ms 缺口 |
| 屏幕常亮（不让手机自动锁屏） | Safari 16.4 起支持；“添加到主屏幕”的网页 iOS 18.4 起支持 | 看宿主应用，未实测 | 支持 | 一手资料：[WebKit：Safari 18.4 新特性](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)、[WebKit bug 254545](https://bugs.webkit.org/show_bug.cgi?id=254545)；真机**未实测** |
| 录电脑（手机）声音 | iOS 26 及以前不支持屏幕共享；iOS 27 起 Safari 支持，能不能带声音未实测 | 不支持 | 不支持带声音 | 一手资料：[caniuse getDisplayMedia](https://caniuse.com/mdn-api_mediadevices_getdisplaymedia)、[MDN BCD #30654](https://github.com/mdn/browser-compat-data/issues/30654) |
| 自签证书 | 不装证书：显示“此连接非私人连接”，可以点“访问此网站”进入；装好并信任后不再提示 | 证书提示和下载都可能不正常 | 点“继续前往”可进入 | **实测**：iOS 26.4 模拟器截图 docs/evidence/ios-untrusted-warning.png |
| 不装证书时的实时转写连接（wss） | 旧版 iOS（≤14）会拒绝；有报告说 iOS 15 起修好了、iOS 26 测试版一度回退。所以界面说的是“部分 iOS 版本会连不上”，建议装证书 | — | 可用 | 一手资料：[Cockpit：Safari on iOS](https://cockpit-project.org/running/safari)、[Apple 开发者论坛 iOS 26 wss](https://developer.apple.com/forums/thread/792842)；真机**未实测** |
| 证书被滥用 | 根证书带名称限制：只能签私网 IP 和 .local / .ts.net。iPhone 拒绝越界证书 | — | 未实测 | **实测**：iOS 26.4 模拟器信任根证书后，界内证书正常打开，127.0.0.1 证书被拒（docs/evidence/ios-nameconstraint-*.png）；OpenSSL 和 curl 同样拒绝 |
| AirPods 等蓝牙耳机 | 开麦后会切到通话音质，Safari 里还有不稳定的报告 | — | 未实测 | 一手资料：[WebKit bug 252175](https://bugs.webkit.org/show_bug.cgi?id=252175)；建议录会议时不用蓝牙耳机 |
| 远处的人说话（手机放在桌子中间） | 浏览器默认开着降噪、自动增益、回声消除，可能压低远处人声 | 同左 | 同左 | **未实测**：需要同场 Mac 和 iPhone 一起录，再用 tests/audio/cer.py 比 |

## 怎么选

1. **Mac 在会议室里**：用 Mac 录（全天模式或 Mac 上的录音页），手机、平板只用来看实时文字、记笔记、会后看纪要。这条最稳。
2. **只有手机在场**：用 Safari 打开（不要在微信、飞书里打开），插上电源，页面保持在前台。断网不要紧，会自动补传；锁屏、来电时没录到的部分会在转写稿里标出来。
3. **要录很久、又没法保证页面一直在前台**：用 iPhone 自带的“语音备忘录”录，会后在网页里点“上传录音 / 视频文件”（m4a 可以直接传）。
4. **路由器开着客户端隔离（公司、酒店 Wi-Fi）**：让 Mac 连手机热点，或者两边都装 Tailscale。

## 每场录音的健康记录

每次录音都在 `data/meetings/<id>/meta.json` 的 `rec_health` 里留一条记录：

- 设备：`device`。
- 网页产生的字节：`produced`。
- Mac 收到的字节：`received`。
- 因为缓存满了丢掉的字节：`dropped`。
- 断线重连次数：`reconnects`。
- 服务重启次数：`restarts`。
- 每一段没录到的位置、时长和原因：`gaps`。

会议页头部会汇总显示：“录音完整（断网重连 N 次，已补传）”，或者“录音有 N 处缺口，共 X”。
