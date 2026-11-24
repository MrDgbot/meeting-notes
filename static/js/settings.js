// 设置弹窗（AI 模型、语音识别、词库、全天模式、自学习中心、局域网访问）
import { $, $$, S, esc, hooks, ic } from "./utils.js";
import { api } from "./api.js";
import { closeModal, confirmAction, copyText, linkLabels, modal, toast } from "./ui.js";
import { REC } from "./recorder.js";
import { startLocalLlm } from "./meeting.js";
import { getResolvedTheme, getThemeMode, setThemeMode } from "./palette.js";

let settingsOpening = false;

export async function openSettings() {
  if (settingsOpening) return;
  settingsOpening = true;
  let s, asr, vocab, rsi;
  try {
    [s, asr, vocab, rsi] = await Promise.all([
      api("/api/settings"),
      api("/api/asr").catch(() => null),
      api("/api/vocab").catch(() => ({ hotwords: "", fixes: [] })),
      api("/api/rsi").catch(() => null),
    ]);
  } finally {
    settingsOpening = false;
  }
  S.settings = s;
  let rsiVocabChanged = false;
  const ac = (S.amb && S.amb.cfg) || {};
  const fixRow = f => `<div class="row fx-row" style="gap:6px;margin-bottom:6px"><input class="fx-from grow" aria-label="错误写法" placeholder="识别成" value="${esc(f.from)}"><span class="muted">${ic("right")}</span>
    <input class="fx-to grow" aria-label="正确写法" placeholder="应为" value="${esc(f.to)}"><button class="sm ghost danger fx-del" title="删除" aria-label="删除规则">${ic("x")}</button></div>`;
  const card = (p, i) => `<div class="prov ${p.id === s.active ? "on" : ""}" data-i="${i}">
    <div class="row"><label class="row grow" style="gap:6px;cursor:pointer"><input type="radio" name="active" title="设为默认" aria-label="设为默认模型" ${p.id && p.id === s.active ? "checked" : ""}>
      <input class="p-name" aria-label="接口名称" value="${esc(p.name)}" style="font-weight:500;background-color:transparent;width:70%"></label>
      <button class="sm p-test">测试连接</button><button class="sm ghost danger p-del">删除</button></div>
    <div class="grid">
      <div><label class="f">接口地址（OpenAI 兼容）</label><input class="p-url" value="${esc(p.base_url)}"></div>
      <div><label class="f">模型名</label><input class="p-model" value="${esc(p.model)}"></div>
      <div><label class="f">API Key ${p.api_key_from_env ? `<span class="tag">已从环境变量 ${esc(p.env_key)} 读取</span>` : ""}
          ${p.api_key_masked ? `<a class="p-clr small" style="float:right;cursor:pointer;color:var(--muted)">清除已保存的 Key</a>` : ""}</label>
        <input class="p-key" type="password" placeholder="${p.api_key_masked ? "已设置 " + esc(p.api_key_masked) + "（留空不修改）" : "未设置"}"></div>
      <div><label class="f">单次最多输入字数（超出则分段总结）</label><input class="p-max" type="number" value="${esc(p.max_input_chars)}"></div>
    </div>
    <details class="steps" style="margin-top:8px"><summary>高级参数（可选）</summary>
      <div style="margin-top:8px"><label class="f">附加请求参数（JSON）</label><input class="p-extra" style="width:100%" value="${esc(JSON.stringify(p.extra_body || {}))}"></div>
    </details>
    ${p.id === "local" ? `<div class="row small p-llm" style="margin-top:8px;gap:8px"><span class="muted">本地模型状态：检查中…</span></div>` : ""}
    <div class="small p-res" style="margin-top:6px"></div></div>`;

  const curTheme = getThemeMode();
  const resTheme = getResolvedTheme(curTheme);
  const themeHint = curTheme === "auto"
    ? `跟随系统偏好自动切换（当前为${resTheme === "dark" ? "深色" : "浅色"}）`
    : curTheme === "dark" ? "始终使用深色外观" : "始终使用浅色外观";
  const dlg = modal(`<div class="theme-row">
      <div class="theme-meta">
        <b id="themeLbl">外观主题</b>
        <span class="muted small" id="themeHint">${esc(themeHint)}</span>
      </div>
      <div class="theme-seg" role="group" aria-labelledby="themeLbl">
        <button type="button" class="t-opt${curTheme === "auto" ? " on" : ""}" data-theme-set="auto" aria-pressed="${curTheme === "auto" ? "true" : "false"}">${ic("contrast")}跟随系统</button>
        <button type="button" class="t-opt${curTheme === "light" ? " on" : ""}" data-theme-set="light" aria-pressed="${curTheme === "light" ? "true" : "false"}">${ic("sun")}浅色</button>
        <button type="button" class="t-opt${curTheme === "dark" ? " on" : ""}" data-theme-set="dark" aria-pressed="${curTheme === "dark" ? "true" : "false"}">${ic("moon")}深色</button>
      </div>
    </div>
    <div class="set-tabs" role="tablist" aria-label="设置分类">
      <button type="button" role="tab" class="set-tab on" data-set-tab="ai" aria-selected="true">AI 模型</button>
      <button type="button" role="tab" class="set-tab" data-set-tab="asr" aria-selected="false">语音识别</button>
      <button type="button" role="tab" class="set-tab" data-set-tab="vocab" aria-selected="false">词库与声纹</button>
      <button type="button" role="tab" class="set-tab" data-set-tab="ambient" aria-selected="false">全天模式</button>
      <button type="button" role="tab" class="set-tab" data-set-tab="lan" aria-selected="false">多端与集成</button>
    </div>

    <div class="set-panel" data-set-panel="ai">
      <h2>AI 纪要模型</h2>
      <p class="muted small">纪要、问答和当日汇总会使用下面选中的模型。选“本地”时可点击“启动本地模型”完全离线运行。</p>
      <div id="provs">${s.providers.map(card).join("") || `<div class="muted small" style="padding:8px 0">还没有模型接口：点“恢复默认接口”加回默认配置，或添加自定义接口。</div>`}</div>
      <div class="row"><button class="lt" id="addProv">${ic("plus")}添加其他接口</button><button class="lt" id="restoreProv">${ic("refresh")}恢复默认接口</button></div>
    </div>

    <div class="set-panel" data-set-panel="asr" hidden>
      <h2>语音识别</h2>
      ${asr ? `<label class="f">识别模型（对之后的录音生效；已有记录可点“重新转写”）</label>
      <select id="asrModel" style="width:100%">${Object.entries(asr.options).map(([k, v]) => `<option value="${esc(k)}" ${k === asr.model ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <div class="small row" id="asrSt" style="margin-top:6px;gap:8px"></div>
      ${asr.diarizers ? `<label class="f" style="margin-top:10px">区分说话人（对之后的转写生效）</label>
      <select id="asrDiar" style="width:100%">${Object.entries(asr.diarizers).map(([k, v]) => `<option value="${esc(k)}" ${k === asr.diarizer ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>` : ""}
      <label class="small" id="asrDdcRow" style="display:block;margin-top:10px" ${asr.model === "doubao" ? "" : "hidden"}><input type="checkbox" id="asrDdc" ${asr.doubao_ddc !== false ? "checked" : ""}> 豆包语义顺滑（自动过滤重复与语气词）</label>`
      : `<div class="muted small">加载语音识别配置失败</div>`}
    </div>

    <div class="set-panel" data-set-panel="vocab" hidden>
      <h2>词库</h2>
      <p class="muted small">常用热词帮助识别（同事姓名、项目名、术语），所有录音都会用；只填真正常说的词，太多反而干扰。
        纠错规则把固定认错的写法替换成正确的，对已有记录也立即生效，删掉即恢复原文。</p>
      <label class="f">常用热词（空格分隔）</label><input id="vHot" style="width:100%" value="${esc(vocab.hotwords)}">
      <label class="f" style="margin-top:10px">纠错规则（<span id="vFixCnt">${vocab.fixes.length}</span> 条）</label>
      <div id="vFix">${vocab.fixes.map(fixRow).join("")}</div><button class="sm lt" id="vAdd">${ic("plus")}添加规则</button>
      <div class="sec rsi-section" id="rsiSec"></div>
    </div>

    <div class="set-panel" data-set-panel="ambient" hidden>
      <h2>全天模式</h2>
      <div class="grid2">
        <div><label class="f">麦克风</label><select id="aDev" style="width:100%"><option value="">系统默认输入</option>
          ${ac.device ? `<option value="${esc(ac.device)}" selected>${esc(ac.device)}</option>` : ""}</select></div>
        <div><label class="f">收音灵敏度</label><select id="aSens" style="width:100%">${[["normal", "标准：嘈杂环境（办公室、背景声），只录近处清楚的人声"], ["high", "高（默认）：安静房间，人离得远也能录到"], ["max", "很高：再远也录，旁边的说话和杂音也会进来"]]
          .map(([k, t]) => `<option value="${k}" ${k === (ac.sensitivity || "high") ? "selected" : ""}>${t}</option>`).join("")}</select>
          <p class="muted small" style="margin:6px 0 0">有键盘声、背景音乐或旁边有人聊天时选「标准」。默认仍是「高」，适合安静、人离麦克风远的时候。</p></div>
        <div><label class="f">静音多少分钟算一段对话结束</label><input id="aSplit" type="number" min="1" max="60" step="0.5" value="${esc(ac.split_min ?? 5)}"></div>
        <div><label class="f">发言少于多少秒就放进回收站</label><input id="aMin" type="number" min="0" max="600" value="${esc(ac.min_speech_s ?? 20)}"></div>
        <div><label class="f">单段对话最长（分钟，超出自动切开）</label><input id="aMax" type="number" min="10" max="240" value="${esc(ac.max_conv_min ?? 120)}"></div>
        <div><label class="f">每天自动生成汇总的时间（留空不自动）</label><input id="aSum" type="time" value="${esc(ac.summary_time || "")}"></div>
        <div><label class="f">自动记录的录音保留天数（0 = 永久；文字一直保留）</label><input id="aKeep" type="number" min="0" value="${esc(ac.audio_keep_days ?? 30)}"></div>
        <div style="align-self:end"><label class="small"><input type="checkbox" id="aAwake" ${ac.keep_awake !== false ? "checked" : ""}> 开启期间阻止电脑空闲休眠（屏幕照常熄灭）</label></div>
        <div style="grid-column:1/-1"><label class="small"><input type="checkbox" id="aKeepSil" ${ac.keep_silence ? "checked" : ""}> 不跳过静音：对话中的停顿不管多长都原样录下（默认关：超过 3 秒的静音不存，只在播放器上标跳点）</label>
          <p class="muted small" id="aSilEst" style="margin:4px 0 0 22px">只影响之后的新录音。空间估算加载中…</p></div>
      </div>
      <div id="discBox" style="margin-top:12px"><p class="muted small">最近丢弃的片段：加载中…</p></div>
      <div id="trashBox" style="margin-top:14px"><label class="f">废纸篓（30 天内可找回）</label><p class="muted small">加载中…</p></div>
    </div>

    <div class="set-panel" data-set-panel="lan" hidden>
      <h2>平板、手机访问</h2>
      <p class="muted small">打开后，同一 Wi-Fi 下的 iPad 或手机可以通过浏览器查看会议、整理纪要并直接录音（本机访问无需口令）。</p>
      <div id="lanBox" class="small muted">检查中…</div>
      <div class="sec" id="mcpSec">
        <details class="steps">
          <summary>桌面 AI 助手只读接入（MCP 配置）</summary>
          <p class="muted small" style="margin-top:8px">通过本机直连为支持 MCP 的桌面 AI 工具提供会议检索与待办查询能力，数据不经过第三方云。</p>
          <div id="mcpBox" class="small muted">加载配置…</div>
        </details>
      </div>
    </div>

    <div class="set-foot"><span class="grow"></span><button type="button" data-close-modal>取消</button><button type="button" class="pri" id="saveSet">保存</button></div>`, () => {
    if (rsiVocabChanged && S.cur && !REC.active && !REC.stopping && hooks.showMeeting) {
      hooks.showMeeting(S.cur.meta.id, { keepPlayer: true });
    }
  });

  $$("[data-set-tab]", dlg).forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.setTab;
      $$("[data-set-tab]", dlg).forEach(b => {
        const on = b.dataset.setTab === target;
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
      $$("[data-set-panel]", dlg).forEach(p => { p.hidden = p.dataset.setPanel !== target; });
    });
  });

  const asrSel = $("#asrModel", dlg), asrDdcRow = $("#asrDdcRow", dlg);
  if (asrSel && asrDdcRow) {
    asrSel.addEventListener("change", () => { asrDdcRow.hidden = asrSel.value !== "doubao"; });
  }

  const themeToast = { auto: "已切换为跟随系统", light: "已切换为浅色主题", dark: "已切换为深色主题" };
  $$("[data-theme-set]", dlg).forEach(btn => {
    btn.addEventListener("click", () => {
      const m = btn.dataset.themeSet;
      if (!m || m === getThemeMode()) return;
      setThemeMode(m);
      toast(themeToast[m] || "已切换外观主题");
    });
  });

  api("/api/mcp/config").then(r => {
    const box = $("#mcpBox", dlg);
    if (!box || !dlg.isConnected || !r || !r.config) return;
    const snippet = JSON.stringify(r.config, null, 2);
    box.innerHTML = `<pre class="mcp-pre"><code>${esc(snippet)}</code></pre>
      <div class="row" style="margin-top:8px;gap:8px">
        <button type="button" class="sm" id="copyMcpBtn">${ic("copy")}复制 MCP 配置</button>
        <span class="muted small">加 <code>--exclude-private</code> 参数可跳过隐私会议</span>
      </div>`;
    $("#copyMcpBtn", box).onclick = () => copyText(snippet, "已复制本机 MCP 配置");
  }).catch(() => {
    const box = $("#mcpBox", dlg);
    if (box && dlg.isConnected) box.textContent = "加载 MCP 配置失败";
  });

  api("/api/discarded").then(r => {
    if (!dlg.isConnected) return;
    hooks.renderDiscarded && hooks.renderDiscarded($("#discBox", dlg), (r && r.items) || []);
    linkLabels($("#discBox", dlg));
  }).catch(() => {
    const box = $("#discBox", dlg); if (box) box.innerHTML = `<p class="muted small">最近丢弃的片段加载失败。</p>`;
  });
  api("/api/trash").then(r => {
    if (!dlg.isConnected) return;
    const box = $("#trashBox", dlg);
    if (!box) return;
    box.innerHTML = `<label class="f">废纸篓（30 天内可找回）</label><div class="trash-list-inner"></div>`;
    hooks.renderTrashList && hooks.renderTrashList($(".trash-list-inner", box), (r && r.items) || []);
  }).catch(() => {
    const box = $("#trashBox", dlg); if (box) box.innerHTML = `<label class="f">废纸篓（30 天内可找回）</label><p class="muted small">废纸篓加载失败。</p>`;
  });
  api("/api/ambient/devices").then(r => {
    const sel = $("#aDev", dlg); if (!sel || !dlg.isConnected) return;
    const off = ac.device && !r.devices.includes(ac.device);
    sel.innerHTML = `<option value="">系统默认输入</option>` + r.devices.map(n => `<option ${n === ac.device ? "selected" : ""}>${esc(n)}</option>`).join("")
      + (off ? `<option value="${esc(ac.device)}" selected>${esc(ac.device)}（未连接，暂用系统默认）</option>` : "");
  }).catch(() => {});

  const asrStatus = async () => {
    const box = $("#asrSt", dlg); if (!box || !dlg.isConnected) return;
    const a = await api("/api/asr").catch(() => null); if (!a || !dlg.isConnected) return;
    const wantNano = ["nano", "doubao"].includes(a.model);
    box.innerHTML = a.nano_loading ? `<span class="muted">正在加载高精度离线模型（约 15 秒），这期间实时文字会暂停…</span>`
      : wantNano && a.nano_error ? `<span style="color:var(--red)" class="grow">高精度离线模型加载失败，暂用兼容模式：${esc(a.nano_error.slice(0, 120))}</span><button class="sm" id="asrRetry">重试加载</button>`
      : wantNano && a.nano_loaded ? `<span class="muted">✓ 高精度离线模型已就绪</span>` : "";
    $("#asrRetry", dlg) && ($("#asrRetry", dlg).onclick = async () => { await api("/api/asr", { method: "PUT", body: { model: a.model } }).catch(e => toast(e.message)); asrStatus(); });
    if (a.nano_loading) setTimeout(asrStatus, 2000);
  };
  asrStatus();

  const llmStatus = async () => {
    const box = $(".p-llm", dlg); if (!box || !dlg.isConnected) return;
    const st = await api("/api/llm/local").catch(() => null); if (!st || !dlg.isConnected) return;
    box.innerHTML = st.running ? `<span style="color:var(--green)">✓ 本地模型正在运行</span>${st.ours ? `<button class="sm" id="llmStop">停止（释放约 38GB 内存）</button>` : ""}`
      : st.starting ? `<span class="muted">本地模型启动中…（加载约 38GB，需要几十秒）</span>`
      : `<span class="muted grow">本地模型没有运行${st.exit_code != null && st.log ? `，上次启动失败：${esc(st.log.split("\n").pop().slice(0, 100))}` : ""}</span>
         ${st.script ? `<button class="sm" id="llmGo">启动本地模型</button>` : `<span class="muted">（找不到启动脚本 scripts/start-local-llm.sh）</span>`}`;
    $("#llmGo", dlg) && ($("#llmGo", dlg).onclick = async e => { await startLocalLlm(e.currentTarget); llmStatus(); });
    $("#llmStop", dlg) && ($("#llmStop", dlg).onclick = async () => {
      try { await api("/api/llm/local", { method: "POST", body: { action: "stop" } }); } catch (e) { toast(e.message, 5000); }
      llmStatus();
    });
    if (st.starting) setTimeout(llmStatus, 3000);
  };
  llmStatus();

  let lanLast = null, lanGenPin = "";
  const lanPut = async body => {
    const st = $("#lanSt", dlg);
    st && (st.innerHTML = `<span class="muted">${body.enabled ? "正在开启…（第一次要生成证书，几秒钟）" : "正在保存…"}</span>`);
    try {
      const res = await api("/api/lan", { method: "PUT", body: { port: +$("#lanPort", dlg).value, password: $("#lanPw", dlg).value, ...body } });
      if (res && res.generated_password) lanGenPin = res.generated_password;
      lanRender(res);
      return true;
    } catch (e) { toast(e.message, 5000); lanRender(await api("/api/lan").catch(() => lanLast)); return false; }
  };
  const lanRender = st => {
    const box = $("#lanBox", dlg); if (!box || !st || !dlg.isConnected) return;
    lanLast = st; box.className = "";
    if (st.generated_password) lanGenPin = st.generated_password;
    if (!st.local) {
      // /lan/logout 改为 POST 防止跨站登出 CSRF
      box.innerHTML = `<p class="small" style="margin-top:0">你正在通过局域网访问这台电脑。开关和访问口令只能在电脑上修改。</p><form method="post" action="/lan/logout" style="display:inline"><button type="submit" class="btn">退出登录</button></form>`;
      return;
    }
    const sel = Math.min(S.lanSel || 0, Math.max(0, st.urls.length - 1));
    box.innerHTML = `
      <label class="row" style="gap:10px;cursor:pointer;flex-wrap:nowrap"><span class="switch"><input type="checkbox" id="lanOn" ${st.enabled ? "checked" : ""}><i></i></span><b>允许同一网络里的设备访问</b></label>
      ${lanGenPin ? `<div class="banner info small" style="margin:10px 0 0"><span class="grow">已自动生成 6 位访问口令：<b class="num">${esc(lanGenPin)}</b>（建议记住或修改）</span><button type="button" class="sm" id="lanCopyPin">${ic("copy")}复制口令</button></div>` : ""}
      <div class="grid2" style="margin-top:12px">
        <div><label class="f">访问口令（至少 6 位，留空自动生成）</label><input id="lanPw" type="password" autocomplete="new-password" style="width:100%" placeholder="${st.has_password ? "已设置（留空不修改）" : "留空将自动生成 6 位数字口令"}"></div>
        <div><label class="f">端口</label><div class="row" style="gap:8px;flex-wrap:nowrap"><input id="lanPort" type="number" min="1024" max="65535" class="grow" style="min-width:0" value="${esc(st.port)}">
          <button class="sm" id="lanSave">保存口令和端口</button></div></div>
      </div>
      ${st.ca_replaced ? `<div class="banner warn small" style="margin:12px 0 0">证书在 ${new Date(st.ca_replaced * 1000).toLocaleDateString()} 换成了带“名称限制”的新证书：就算证书文件被人拿走，也冒充不了任何公网网站。
        <b>之前在手机上装过旧证书的</b>：到“设置 → 通用 → VPN 与设备管理”删掉旧的“会议记录 本机根证书”，再从登录页重新下载安装、打开信任开关。</div>` : ""}
      <div class="small" id="lanSt" style="margin-top:10px">${st.running ? `<span style="color:var(--green)">✓ 已开启</span>`
        : st.error ? `<span style="color:var(--red)">没有开启：${esc(st.error)}</span>` : `<span class="muted">未开启</span>`}</div>
      ${st.running && st.urls.length ? `<div class="lan-urls"><div class="lan-qr" id="lanQr">${st.urls[sel].qr}</div>
        <div class="lan-list">${st.urls.map((u, i) => `<a class="lan-url${i === sel ? " on" : ""}" data-i="${i}"><b>${esc(u.url)}</b><small>${esc(u.label)}</small></a>`).join("")}
          <span class="muted small">用手机相机扫二维码，或者在浏览器里输入地址；点地址可以复制</span></div></div>
        <details class="steps"><summary>第一次在手机、平板上打开</summary><ol>
          <li>手机连上和这台电脑同一个 Wi-Fi，扫上面的二维码。</li>
          <li>浏览器提示“不是私密连接 / 不安全”：这是电脑自己签发的证书。iPhone 点“显示详细信息 → 访问此网站”，安卓 Chrome 点“高级 → 继续前往”。</li>
          <li>输入访问口令登录，这台设备 30 天内不用再输。</li>
          <li><b>建议装上证书</b>（不装每次都有警告，部分 iOS 版本上录音会连不上）：在登录页点“下载证书”，按页面上的步骤安装并信任。证书指纹：<span class="fp">${esc(st.ca_sha256 || "")}</span></li>
          ${st.firewall ? `<li>电脑的防火墙开着：第一次有设备连进来时，电脑可能弹窗问是否允许“python”接受传入连接，请点“允许”。</li>` : ""}
          <li>电脑睡眠时手机连不上；开着全天模式时电脑不会自动睡眠。</li></ol></details>
        <details class="steps"><summary>手机、平板打不开？按这个顺序查</summary><ol>
          <li>手机是不是连着<b>同一个 Wi-Fi</b>：用 4G/5G、连着“访客网络”都连不上电脑。</li>
          <li>公司、酒店、商场的 Wi-Fi 常开着<b>客户端隔离</b>（同一个 Wi-Fi 里的设备互相看不见）：让电脑连手机热点，或者两边都装 Tailscale 后用 Tailscale 地址。</li>
          <li><b>用名字（.local）打不开</b>：部分安卓手机和路由器不支持，改用上面的 IP 地址。</li>
          <li><b>用 IP 打不开</b>：电脑换过网络或重连 Wi-Fi 后 IP 会变，收藏的旧地址就失效了，重新扫这里最新的二维码。</li>
          <li>电脑睡眠或合上盖子时连不上。${st.firewall ? "电脑的防火墙开着：到“系统设置 → 网络 → 防火墙 → 选项”里允许 python 接受传入连接。" : ""}</li>
          <li><b>用微信扫的码</b>：会在微信里打开，证书提示和录音都可能不正常，点右上角“…”选“在浏览器打开”。</li></ol></details>
        <div class="row" style="margin-top:10px"><button class="sm ghost danger" id="lanKick">让所有已登录的设备退出</button></div>` : ""}`;
    linkLabels(box);
    $("#lanOn", dlg).onchange = e => lanPut({ enabled: e.target.checked });
    $("#lanSave", dlg).onclick = () => lanPut({ enabled: st.enabled }).then(ok => ok && toast("已保存"));
    $$(".lan-url", dlg).forEach(a => a.onclick = () => {
      S.lanSel = +a.dataset.i; $("#lanQr", dlg).innerHTML = st.urls[S.lanSel].qr;
      $$(".lan-url", dlg).forEach(x => x.classList.toggle("on", x === a));
      copyText(st.urls[S.lanSel].url, "已复制地址");
    });
    $("#lanCopyPin", dlg) && ($("#lanCopyPin", dlg).onclick = () => copyText(lanGenPin, "已复制访问口令"));
    $("#lanKick", dlg) && ($("#lanKick", dlg).onclick = async () => {
      if (!(await confirmAction({
        title: "让所有外部设备退出登录？",
        message: "手机和平板下次打开时需要重新输入访问口令。",
        confirmText: "全部退出",
        danger: true,
      }))) return;
      try { lanRender(await api("/api/lan/logout-all", { method: "POST" })); toast("已让所有设备退出"); } catch (e) { toast(e.message, 5000); }
    });
  };
  api("/api/lan").then(lanRender).catch(() => { const b = $("#lanBox", dlg); b && (b.textContent = "读取局域网访问状态失败"); });

  api("/api/ambient/storage").then(e => {
    const el = $("#aSilEst", dlg); if (!el || !dlg.isConnected) return;
    const gb = mb => mb >= 1000 ? (mb / 1000).toFixed(1) + "GB" : Math.round(mb) + "MB", k = e.keep_days;
    const keep = (a, b) => k > 0 ? `；按保留 ${k} 天算，共约 ${gb(a * k)} → ${gb(b * k)}` : "";
    el.textContent = `只影响之后的新录音。录音按 64kbps 存，约 ${e.mb_per_hour}MB/小时。` + (e.days
      ? `按最近 ${e.days} 天的录音：跳过静音约 ${e.skip_h_day} 小时/天 ≈ ${gb(e.skip_mb_day)}/天，不跳过约 ${e.cont_h_day} 小时/天 ≈ ${gb(e.cont_mb_day)}/天${keep(e.skip_mb_day, e.cont_mb_day)}。`
      : `比如一天录满 8 小时约 ${gb(e.mb_per_hour * 8)}。`);
  }).catch(() => {});

  const confirmPurge = async () => {
    const nk = +$("#aKeep", dlg).value, ok = ac.audio_keep_days ?? 30;
    if (!(nk > 0 && (ok === 0 || nk < ok))) return true;
    const r = await api("/api/ambient/purge-preview?days=" + nk).catch(() => ({ count: 0 }));
    return !r.count || confirmAction({
      title: `清理 ${r.count} 段旧录音？`,
      message: `保留天数改成 ${nk} 天后，会删除 ${r.count} 段超过期限的自动记录录音文件（转写文字和纪要保留，删后不可恢复）。`,
      confirmText: "确认删除旧录音",
      danger: true,
    });
  };
  const saveAmb = async () => {
    S.amb = await api("/api/ambient/config", {
      method: "PUT",
      body: {
        device: $("#aDev", dlg).value, sensitivity: $("#aSens", dlg).value, split_min: +$("#aSplit", dlg).value,
        min_speech_s: +$("#aMin", dlg).value, max_conv_min: +$("#aMax", dlg).value, summary_time: $("#aSum", dlg).value,
        audio_keep_days: +$("#aKeep", dlg).value, keep_awake: $("#aAwake", dlg).checked, keep_silence: $("#aKeepSil", dlg).checked,
      },
    });
    hooks.renderAmb && hooks.renderAmb();
  };
  const updateFixCnt = () => {
    const cnt = $("#vFixCnt", dlg);
    if (cnt) cnt.textContent = String($$(".fx-row", dlg).length);
  };
  const bindFix = () => $$(".fx-del", dlg).forEach(b => b.onclick = () => { b.closest(".fx-row").remove(); updateFixCnt(); });
  bindFix();
  $("#vAdd", dlg).onclick = () => { $("#vFix", dlg).insertAdjacentHTML("beforeend", fixRow({ from: "", to: "" })); bindFix(); updateFixCnt(); $$(".fx-from", dlg).pop().focus(); };
  const syncVocabRow = (from, to, addHotword) => {
    const fixBox = $("#vFix", dlg);
    if (fixBox && from) {
      const existing = $$(".fx-row", fixBox).find(r => ($(".fx-from", r)?.value || "").trim() === from);
      if (existing) {
        const toInp = $(".fx-to", existing);
        if (toInp) toInp.value = to;
      } else {
        fixBox.insertAdjacentHTML("beforeend", fixRow({ from, to }));
        bindFix();
        updateFixCnt();
      }
    }
    const hotInp = $("#vHot", dlg);
    if (addHotword && hotInp && to) {
      const cur = hotInp.value.trim();
      const words = cur ? cur.split(/\s+/) : [];
      if (!words.includes(to)) hotInp.value = cur ? `${cur} ${to}` : to;
    }
  };

  const fmtRegTime = at => {
    if (!at) return "";
    if (typeof at === "number") return new Date(at * 1000).toLocaleString("zh-CN", { hour12: false });
    return String(at).replace("T", " ").slice(0, 16);
  };
  const refreshRsi = async () => {
    const next = await api("/api/rsi").catch(() => null);
    if (dlg.isConnected) renderRsi(next);
  };
  const renderRsi = data => {
    const box = $("#rsiSec", dlg);
    if (!box || !dlg.isConnected) return;
    if (!data || typeof data !== "object") {
      box.innerHTML = `<h2>自学习中心</h2>
        <p class="muted small">全部自学习数据仅保存在本机，永不联网上传。</p>
        <p class="muted small">自学习状态暂不可用。</p>`;
      return;
    }
    const cfg = data.config || {};
    const vp = data.voiceprints || {};
    const persons = Array.isArray(vp.persons) ? vp.persons : [];
    const conflicts = Array.isArray(vp.conflicts) ? vp.conflicts : [];
    const tauAuto = Number.isFinite(Number(vp.tau_auto)) ? Number(vp.tau_auto).toFixed(2) : "0.68";
    const tauSuggest = Number.isFinite(Number(vp.tau_suggest)) ? Number(vp.tau_suggest).toFixed(2) : "0.54";
    const vb = data.vocab || {};
    const candidates = Array.isArray(vb.candidates) ? vb.candidates : [];
    const demotedRules = Array.isArray(vb.demoted_rules) ? vb.demoted_rules : [];
    const ctcDemoted = Array.isArray(vb.ctc_demoted) ? vb.ctc_demoted : [];
    const dismissedCount = Number(vb.dismissed_count || 0);
    const hasVocabItems = candidates.length || demotedRules.length || ctcDemoted.length || dismissedCount > 0;
    const amb = data.ambient || {};
    const devices = Array.isArray(amb.devices) ? amb.devices : [];
    const ds = amb.discard_stats || {};
    const advice = amb.advice || {};
    const registry = Array.isArray(data.registry) ? data.registry : [];

    box.innerHTML = `<h2>自学习中心</h2>
      <p class="muted small">全部自学习数据仅保存在本机，永不联网上传。</p>
      <div class="rsi-toggles">
        <label class="rsi-toggle small" for="rsiPaused"><input type="checkbox" id="rsiPaused" ${cfg.paused ? "checked" : ""}><span>暂停自学习（保留已有数据，停止新增学习）</span></label>
        <label class="rsi-toggle small" for="rsiAutoName"><input type="checkbox" id="rsiAutoName" ${cfg.auto_name !== false ? "checked" : ""}><span>跨会声纹自动认人（同一人满 2 场确认后生效）</span></label>
      </div>

      <div class="rsi-block">
        <div class="rsi-head"><h3>跨会声纹库</h3><span class="muted small num">自动阈值 ${esc(tauAuto)} · 建议阈值 ${esc(tauSuggest)}</span></div>
        ${conflicts.length ? `<div class="banner warn small rsi-callout">检测到 ${conflicts.length} 条声纹冲突已自动隔离，防止误认</div>` : ""}
        ${persons.length
          ? `<div class="rsi-list">${persons.map(p => `<div class="rsi-row">
              <span class="grow small"><b>${esc(p.name)}</b> <span class="muted num">${esc(p.sessions ?? 0)} 场 · ${Math.round(Number(p.voiced_s || 0))}s</span></span>
              <button type="button" class="sm ghost danger" data-rsi-vp-del="${esc(p.name)}" title="删除 ${esc(p.name)} 的声纹">删除</button>
            </div>`).join("")}</div>`
          : `<p class="muted small rsi-empty">还没有已记忆的声纹。在转写稿里把「说话人」改成真实姓名后，满 2 场且发言时长达标即可跨会认人。</p>`}
      </div>

      <div class="rsi-block">
        <div class="rsi-head"><h3>词库自进化</h3></div>
        ${candidates.length ? `<div class="rsi-sub muted small">候选纠错</div>
          <div class="rsi-list">${candidates.map((c, i) => `<div class="rsi-row">
            <span class="grow small"><b>${esc(c.from)}</b> <span class="muted">→</span> <b>${esc(c.to)}</b> <span class="muted num">(${esc(c.count ?? 0)}次)</span></span>
            <div class="rsi-acts">
              <button type="button" class="sm" data-rsi-cand-ok="${i}">采纳</button>
              <button type="button" class="sm ghost" data-rsi-cand-no="${i}">忽略</button>
            </div>
          </div>`).join("")}</div>` : ""}
        ${demotedRules.length ? `<div class="rsi-sub muted small">已自动降级规则（改为仅提示，不再自动替换）</div>
          <div class="rsi-list">${demotedRules.map((r, i) => `<div class="rsi-row">
            <span class="grow small"><b>${esc(r.from)}</b> <span class="muted">→</span> <b>${esc(r.to)}</b> <span class="muted num">命中 ${esc(r.hits ?? 0)} · 撤销 ${esc(r.reverts ?? 0)}</span></span>
            <button type="button" class="sm" data-rsi-rule-restore="${i}">恢复生效</button>
          </div>`).join("")}</div>` : ""}
        ${ctcDemoted.length ? `<div class="rsi-sub muted small">CTC 降权热词</div>
          <div class="rsi-pills">${ctcDemoted.map(w => `<span class="rsi-pill" title="拦截 ${esc(w.rejects ?? 0)} 次 · 通过 ${esc(w.accepts ?? 0)} 次">${esc(w.word)}<span class="muted num">${esc(w.rejects ?? 0)}</span></span>`).join("")}</div>` : ""}
        ${dismissedCount > 0 ? `<p class="muted small rsi-meta">已忽略 ${dismissedCount} 条疑似热词误报提示</p>` : ""}
        ${!hasVocabItems ? `<p class="muted small rsi-empty">暂无词库自进化记录。日常改错字或忽略热词误报后会自动沉淀在这里。</p>` : ""}
      </div>

      <div class="rsi-block">
        <div class="rsi-head"><h3>全天声学建议</h3></div>
        ${devices.length ? `<div class="rsi-list">${devices.map(dev => `<div class="rsi-row">
            <span class="grow small">${esc(dev.device || "系统默认麦克风")}</span>
            <span class="muted small num">底噪 ${Number.isFinite(Number(dev.noise_floor_p20_db)) ? Number(dev.noise_floor_p20_db).toFixed(1) + " dB" : "—"} · VAD 误触率 ${Number.isFinite(Number(dev.vad_false_ratio)) ? Math.round(Number(dev.vad_false_ratio) * 100) + "%" : "—"}</span>
          </div>`).join("")}</div>` : ""}
        <p class="muted small rsi-meta num">回收站统计：7 天已清理 ${Number(ds.purged_7d || 0)} · 找回 ${Number(ds.restored || 0)}${Number(ds.restored_7d || 0) > 0 ? `（近 7 天 ${Number(ds.restored_7d)}）` : ""} · 误录删除 ${Number(ds.user_deleted_short || 0)}</p>
        ${advice.warning ? `<div class="banner warn small rsi-callout">${esc(advice.warning)}</div>` : ""}
        ${advice.suggested_min_speech_s != null ? `<div class="rsi-row rsi-advice">
          <span class="grow small">${esc(advice.reason || `建议将最短有效发言调整为 ${advice.suggested_min_speech_s} 秒`)}</span>
          <button type="button" class="sm pri" id="rsiApplyMin" data-val="${esc(advice.suggested_min_speech_s)}">应用建议 (${esc(advice.suggested_min_speech_s)}s)</button>
        </div>` : ""}
      </div>

      ${registry.length ? `<details class="steps rsi-reg"><summary>自学习保护记录（${registry.length} 条）</summary>
        <ul class="rsi-reg-list">${registry.slice(0, 15).map(it => `<li class="small"><span class="muted num">${esc(fmtRegTime(it.at))}</span> <span class="tag">${esc(it.kind || "event")}</span> <span>${esc(it.detail || "")}</span></li>`).join("")}</ul></details>` : ""}

      <div class="rsi-block rsi-reset">
        <div class="row" style="gap:8px">
          <button type="button" class="sm ghost danger" id="rsiResetVp">清空声纹库</button>
          <button type="button" class="sm ghost danger" id="rsiResetAll">重置全部自学习</button>
        </div>
      </div>`;

    const pausedEl = $("#rsiPaused", box);
    if (pausedEl) {
      pausedEl.addEventListener("change", async () => {
        const val = pausedEl.checked;
        pausedEl.disabled = true;
        try {
          await api("/api/rsi/config", { method: "PUT", body: { paused: val } });
          toast(val ? "已暂停自学习" : "已恢复自学习");
        } catch (err) {
          pausedEl.checked = !val;
          toast("保存失败：" + err.message, 5000);
        } finally {
          if (pausedEl.isConnected) pausedEl.disabled = false;
        }
      });
    }
    const autoEl = $("#rsiAutoName", box);
    if (autoEl) {
      autoEl.addEventListener("change", async () => {
        const val = autoEl.checked;
        autoEl.disabled = true;
        try {
          await api("/api/rsi/config", { method: "PUT", body: { auto_name: val } });
          toast(val ? "已开启跨会声纹自动认人" : "已关闭跨会声纹自动认人");
        } catch (err) {
          autoEl.checked = !val;
          toast("保存失败：" + err.message, 5000);
        } finally {
          if (autoEl.isConnected) autoEl.disabled = false;
        }
      });
    }
    $$("[data-rsi-vp-del]", box).forEach(btn => btn.addEventListener("click", async () => {
      const name = btn.dataset.rsiVpDel;
      if (!name) return;
      btn.disabled = true;
      try {
        await api(`/api/rsi/voiceprints/${encodeURIComponent(name)}`, { method: "DELETE" });
        toast(`已删除「${name}」的声纹`);
        await refreshRsi();
      } catch (err) {
        if (btn.isConnected) btn.disabled = false;
        toast("删除失败：" + err.message, 5000);
      }
    }));
    $$("[data-rsi-cand-ok]", box).forEach(btn => btn.addEventListener("click", async () => {
      const c = candidates[+btn.dataset.rsiCandOk];
      if (!c) return;
      btn.disabled = true;
      try {
        await api("/api/rsi/vocab/candidate/accept", { method: "POST", body: { from: c.from, to: c.to, hotword: true } });
        syncVocabRow(c.from, c.to, true);
        rsiVocabChanged = true;
        toast(`已采纳纠错规则：${c.from} → ${c.to}`);
        await refreshRsi();
      } catch (err) {
        if (btn.isConnected) btn.disabled = false;
        toast("采纳失败：" + err.message, 5000);
      }
    }));
    $$("[data-rsi-cand-no]", box).forEach(btn => btn.addEventListener("click", async () => {
      const c = candidates[+btn.dataset.rsiCandNo];
      if (!c) return;
      btn.disabled = true;
      try {
        await api("/api/rsi/vocab/candidate/dismiss", { method: "POST", body: { from: c.from, to: c.to } });
        toast(`已忽略候选：${c.from} → ${c.to}`);
        await refreshRsi();
      } catch (err) {
        if (btn.isConnected) btn.disabled = false;
        toast("忽略失败：" + err.message, 5000);
      }
    }));
    $$("[data-rsi-rule-restore]", box).forEach(btn => btn.addEventListener("click", async () => {
      const r = demotedRules[+btn.dataset.rsiRuleRestore];
      if (!r) return;
      btn.disabled = true;
      try {
        await api("/api/rsi/vocab/rule/restore", { method: "POST", body: { from: r.from } });
        rsiVocabChanged = true;
        toast(`已恢复规则生效：${r.from} → ${r.to}`);
        await refreshRsi();
      } catch (err) {
        if (btn.isConnected) btn.disabled = false;
        toast("恢复失败：" + err.message, 5000);
      }
    }));
    const applyBtn = $("#rsiApplyMin", box);
    if (applyBtn) {
      applyBtn.addEventListener("click", async () => {
        const val = Number(applyBtn.dataset.val);
        if (!Number.isFinite(val)) return;
        applyBtn.disabled = true;
        try {
          S.amb = await api("/api/ambient/config", { method: "PUT", body: { min_speech_s: val } });
          hooks.renderAmb && hooks.renderAmb();
          const aMin = $("#aMin", dlg);
          if (aMin) aMin.value = String(val);
          toast(`已应用全天最短发言建议：${val}s`);
          await refreshRsi();
        } catch (err) {
          if (applyBtn.isConnected) applyBtn.disabled = false;
          toast("应用建议失败：" + err.message, 5000);
        }
      });
    }
    const doReset = (btn, scope, title, msg, okMsg) => {
      if (!btn) return;
      btn.addEventListener("click", async () => {
        if (!(await confirmAction({ title, message: msg, confirmText: "确认清空", danger: true }))) return;
        btn.disabled = true;
        try {
          const res = await api("/api/rsi/reset", { method: "POST", body: { scope } });
          if (scope === "all" || scope === "vocab") rsiVocabChanged = true;
          toast(okMsg);
          if (res && typeof res === "object" && (res.config || res.voiceprints)) renderRsi(res);
          else await refreshRsi();
        } catch (err) {
          if (btn.isConnected) btn.disabled = false;
          toast("重置失败：" + err.message, 5000);
        }
      });
    };
    doReset($("#rsiResetVp", box), "voiceprints", "清空跨会声纹库？", "已有的会议发言人姓名不受影响，之后需要重新积累声纹。", "已清空声纹库");
    doReset($("#rsiResetAll", box), "all", "重置全部自学习数据？", "会重置声纹库、词库统计与记录，不会影响已有会议记录和手动词库。", "已重置全部自学习数据");
  };
  renderRsi(rsi);
  const saveVocab = () => api("/api/vocab", {
    method: "PUT",
    body: {
      hotwords: $("#vHot", dlg).value,
      fixes: $$(".fx-row", dlg).map(r => ({ from: $(".fx-from", r).value, to: $(".fx-to", r).value })),
    },
  });
  const collect = () => ({
    active_index: $$(".prov", dlg).findIndex(el => $("input[name=active]", el).checked),
    providers: $$(".prov", dlg).map(el => {
      const p = s.providers[+el.dataset.i] || {};
      return {
        id: p.id, env_key: p.env_key, name: $(".p-name", el).value, base_url: $(".p-url", el).value, model: $(".p-model", el).value,
        api_key: $(".p-key", el).value, keep_key: !el.dataset.clearKey, max_input_chars: +$(".p-max", el).value, extra_body: $(".p-extra", el).value,
      };
    }),
  });
  const save = async () => {
    const saved = S.settings = await api("/api/settings", { method: "PUT", body: collect() });
    s.providers = saved.providers; s.active = saved.active;
    $$(".prov", dlg).forEach((el, i) => { el.dataset.i = i; delete el.dataset.clearKey; });
    return saved;
  };
  const syncActiveClass = () => {
    const provs = $$(".prov", dlg);
    const radios = $$("input[name=active]", dlg);
    if (radios.length && !radios.some(r => r.checked)) radios[0].checked = true;
    provs.forEach(el => el.classList.toggle("on", $("input[name=active]", el).checked));
  };
  $("#addProv", dlg).onclick = () => {
    s.providers.push({ id: "", name: "自定义接口", base_url: "https://", model: "", max_input_chars: 60000, extra_body: {} });
    const box = $("#provs", dlg); $(".muted", box) && !$(".prov", box) && (box.innerHTML = "");
    box.insertAdjacentHTML("beforeend", card(s.providers[s.providers.length - 1], s.providers.length - 1));
    linkLabels(box);
    bind();
    syncActiveClass();
  };
  $("#restoreProv", dlg).onclick = async e => {
    e.currentTarget.disabled = true;
    try { await save(); const r = await api("/api/settings/restore-providers", { method: "POST" }); toast(r.restored ? `已加回 ${r.restored} 个默认接口` : "默认接口都在，没有需要恢复的"); }
    catch (err) { e.currentTarget.disabled = false; return toast(err.message, 5000); }
    openSettings();
  };
  const bind = () => {
    $$(".prov", dlg).forEach(el => {
      $(".p-del", el).onclick = async () => {
        const name = $(".p-name", el).value.trim() || "该接口";
        if (!(await confirmAction({ title: "删除模型接口？", message: `将移除「${name}」配置（点击底部「保存」后生效）。`, confirmText: "删除", danger: true }))) return;
        el.remove();
        syncActiveClass(); // 删除当前默认接口后，自动回落选中第一个剩余接口
      };
      $(".p-clr", el) && ($(".p-clr", el).onclick = e => {
        el.dataset.clearKey = 1; const k = $(".p-key", el); k.value = ""; k.placeholder = "保存后清除已保存的 Key";
        e.currentTarget.textContent = "保存后清除"; e.currentTarget.style.color = "var(--red)";
      });
      $(".p-test", el).onclick = async e => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        const res = $(".p-res", el); res.textContent = "测试连接中…"; res.style.color = "";
        try {
          const p = s.providers[+el.dataset.i] || {};
          const body = {
            id: p.id,
            base_url: $(".p-url", el).value,
            model: $(".p-model", el).value,
            api_key: $(".p-key", el).value,
            keep_key: !el.dataset.clearKey,
            extra_body: $(".p-extra", el).value,
          };
          const r = await api("/api/settings/test", { method: "POST", body, timeout: 60000 });
          res.textContent = r.ok ? `✓ 连接成功（${r.latency}s）：${r.reply}` : "✗ " + r.msg;
          res.style.color = r.ok ? "var(--green)" : "var(--red)";
        } catch (err) {
          res.textContent = "✗ " + err.message; res.style.color = "var(--red)";
        } finally {
          btn.disabled = false;
        }
      };
    });
    $$("input[name=active]", dlg).forEach(r => r.onchange = syncActiveClass);
  };
  bind();
  const saveAsr = async () => {
    const sel = $("#asrModel", dlg), dz = $("#asrDiar", dlg), ddc = $("#asrDdc", dlg);
    const body = {};
    if (dz && asr && dz.value !== asr.diarizer) body.diarizer = dz.value;
    if (sel && asr && sel.value !== asr.model) body.model = sel.value;
    if (ddc && asr && ddc.checked !== (asr.doubao_ddc !== false)) body.doubao_ddc = ddc.checked;
    if (Object.keys(body).length) await api("/api/asr", { method: "PUT", body });
  };
  let savingAll = false;
  $("#saveSet", dlg).onclick = async e => {
    if (savingAll) return;
    const btn = e.currentTarget;
    savingAll = true; btn.disabled = true;
    try {
      if (!(await confirmPurge())) return;
      const lanPw = $("#lanPw", dlg), lanPort = $("#lanPort", dlg);
      if (lanLast && ((lanPw && lanPw.value) || (lanPort && +lanPort.value !== lanLast.port))) {
        if (!(await lanPut({ enabled: lanLast.enabled }))) return;
      }
      const nano = $("#asrModel", dlg) && asr && $("#asrModel", dlg).value !== asr.model && ["nano", "doubao"].includes($("#asrModel", dlg).value) && !asr.nano_loaded;
      await save(); await saveVocab(); await saveAmb(); await saveAsr();
      closeModal(false);
      toast(nano ? "已保存，正在后台加载高精度离线模型（约 15 秒）" : "已保存", 4000);
      hooks.pollHealth && hooks.pollHealth();
      if (S.cur && !REC.active && !REC.stopping && hooks.showMeeting) hooks.showMeeting(S.cur.meta.id, { keepPlayer: true });
    } catch (err) {
      toast(err.message, 5000);
    } finally {
      savingAll = false;
      if (btn.isConnected) btn.disabled = false;
    }
  };
}
