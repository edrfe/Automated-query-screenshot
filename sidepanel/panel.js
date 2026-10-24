/**
 * 侧边栏面板：多站点批量任务编排器。
 *
 * 架构说明：
 * - Manifest V3 的 Service Worker 会因空闲被回收，因此把「编排逻辑」放在常驻的侧边栏页面中；
 * - 队列的最小单元是「企业 × 站点」，界面上按企业分组展示；
 * - 页面操作通过 chrome.tabs.sendMessage 下发给内容脚本；
 * - 页面状态由面板轮询获取，天然兼容查询过程中的整页跳转；
 * - 整页截图使用 chrome.debugger 的 CDP 接口，一次生成完整长图。
 */

const POLL_INTERVAL_MS = 1000; // 页面状态轮询间隔
const SEARCH_TIMEOUT_MS = 40000; // 单次查询等待结果超时
const RESUBMIT_GRACE_MS = 5000; // 阻塞解除后确认仍停留在首页的观察时长
const BLOCK_TIMEOUT_MS = 300000; // 等待人工过验证码 / 登录的超时
const MAX_CAPTURE_HEIGHT = 16384; // Chrome 单张截图的高度上限

const SITES = window.GSXT_SITES;
const SITE_ORDER = window.GSXT_SITE_ORDER;

const dom = {
  singleNameInput: document.getElementById('singleNameInput'),
  singleQueryBtn: document.getElementById('singleQueryBtn'),
  fileInput: document.getElementById('fileInput'),
  hasHeader: document.getElementById('hasHeader'),
  columnRow: document.getElementById('columnRow'),
  columnSelect: document.getElementById('columnSelect'),
  taskCount: document.getElementById('taskCount'),
  siteList: document.getElementById('siteList'),
  pickFolderBtn: document.getElementById('pickFolderBtn'),
  clearFolderBtn: document.getElementById('clearFolderBtn'),
  folderLabel: document.getElementById('folderLabel'),
  exportToggle: document.getElementById('exportToggle'),
  shotToggle: document.getElementById('shotToggle'),
  startBtn: document.getElementById('startBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  retryBtn: document.getElementById('retryBtn'),
  progressBar: document.getElementById('progressBar'),
  progressText: document.getElementById('progressText'),
  statusText: document.getElementById('statusText'),
  hintBanner: document.getElementById('hintBanner'),
  taskList: document.getElementById('taskList'),
  logView: document.getElementById('logView'),
};

/** 运行状态 */
const state = {
  rawRows: [], // Excel 原始行数据
  items: [], // 队列：{ name, siteId, status, note }
  records: [], // 详情页提取结果，汇总后统一导出
  running: false,
  paused: false,
  tabId: null,
  folderHandle: null, // 用户选定的截图保存目录句柄
  config: {
    folder: '企业截图',
    minDelayMs: 3000,
    maxDelayMs: 8000,
  },
};

/** 任务状态文案 */
const STATUS_LABEL = {
  pending: '待处理',
  running: '查询中',
  done: '已完成',
  failed: '失败',
};

/** 汇总表的固定列，顺序与业务方约定一致 */
const EXPORT_COLUMNS = [
  '企业名称',
  '站点',
  '统一社会信用代码',
  '法定代表人',
  '注册资本',
  '成立日期',
  '登记状态',
  '企业类型',
  '注册地址',
  '经营范围',
  '详情页地址',
  '所属行业',
  '营业期限',
  '登记机关',
  '核准日期',
  '联系电话',
  '电子邮箱',
  '网址',
  '行政区划',
  '实缴资本',
  '曾用名',
  '工商注册号',
  '组织机构代码',
  '纳税人识别号',
  '纳税人资质',
  '参保人数',
  '分支机构参保人数',
];

/** 简易延时 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 生成 [min, max] 之间的随机数，用于模拟人工操作间隔 */
function randomBetween(min, max) {
  const low = Math.max(0, Number(min) || 0);
  const high = Math.max(low, Number(max) || low);
  return low + Math.random() * (high - low);
}

/** 按时间戳生成文件名后缀 */
function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** 过滤文件名中的非法字符 */
function sanitizeFileName(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .trim()
      .slice(0, 80) || '未命名'
  );
}

/** 追加一条日志 */
function log(message) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  dom.logView.textContent += `[${time}] ${message}\n`;
  dom.logView.scrollTop = dom.logView.scrollHeight;
}

/** 更新顶部状态文案 */
function setStatusText(text) {
  dom.statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// 站点选择
// ---------------------------------------------------------------------------

/** 渲染站点复选框，默认全部不勾选，避免误触发查询 */
function renderSiteOptions() {
  const fragment = document.createDocumentFragment();
  for (const id of SITE_ORDER) {
    const site = SITES[id];
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.checked = false;
    label.append(input, document.createTextNode(` ${site.label}`));
    fragment.appendChild(label);
  }
  dom.siteList.innerHTML = '';
  dom.siteList.appendChild(fragment);
}

/** 读取当前勾选的站点 id 列表 */
function selectedSiteIds() {
  return SITE_ORDER.filter((id) => {
    const input = dom.siteList.querySelector(`input[value="${id}"]`);
    return input && input.checked;
  });
}

// ---------------------------------------------------------------------------
// Excel 解析与队列构建
// ---------------------------------------------------------------------------

/** 读取并解析上传的表格文件 */
async function handleFile(file) {
  if (typeof XLSX === 'undefined') {
    throw new Error('SheetJS 库未加载，请确认 lib/xlsx.full.min.js 存在');
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  if (!rows.length) throw new Error('表格内容为空');

  state.rawRows = rows;
  buildColumnOptions();
  log(`已读取文件：${file.name}，共 ${rows.length} 行`);
}

/** 生成列选择下拉框，并自动猜选名称列 */
function buildColumnOptions() {
  const rows = state.rawRows;
  const useHeader = dom.hasHeader.checked;
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const labels = [];
  for (let index = 0; index < columnCount; index += 1) {
    const header = useHeader ? rows[0][index] : null;
    const text = header == null ? '' : String(header).trim();
    labels.push(text || `第 ${index + 1} 列`);
  }

  dom.columnSelect.innerHTML = '';
  labels.forEach((label, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = label;
    dom.columnSelect.appendChild(option);
  });

  // 自动匹配疑似企业名称列
  const guessIndex = labels.findIndex((label) =>
    /企业名称|公司名称|单位名称|名称|集团|企业/.test(label)
  );
  dom.columnSelect.value = String(guessIndex >= 0 ? guessIndex : 0);
  dom.columnRow.hidden = false;
  buildItems();
}

/** 依据当前列构建队列（读取表格中的企业名称，去重后交给 applyNames） */
function buildItems() {
  const rows = state.rawRows;
  const useHeader = dom.hasHeader.checked;
  const columnIndex = Number(dom.columnSelect.value) || 0;
  const dataRows = useHeader ? rows.slice(1) : rows;

  const seen = new Set();
  const names = [];
  for (const row of dataRows) {
    const value = row[columnIndex];
    const name = value == null ? '' : String(value).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  applyNames(names);
}

/** 依据企业名列表与勾选站点构建队列（站点按顺序展开为多条任务） */
function applyNames(names) {
  const siteIds = selectedSiteIds();
  const items = [];
  for (const name of names) {
    for (const siteId of siteIds) {
      items.push({ name, siteId, status: 'pending', note: '' });
    }
  }

  state.items = items;
  state.records = []; // 新一批任务重新累积提取结果
  dom.taskCount.textContent = `共 ${names.length} 家企业 / ${items.length} 个任务`;
  renderTasks();
  updateProgress();
  updateButtons();
}

/** 单个企业名称查询：构建单条队列并立即开始执行 */
async function querySingleName() {
  if (state.running) return;

  const name = dom.singleNameInput.value.trim();
  if (!name) {
    log('请先输入企业名称');
    dom.singleNameInput.focus();
    return;
  }
  if (!selectedSiteIds().length) {
    log('请至少勾选一个查询站点');
    return;
  }

  applyNames([name]);
  log(`单个企业查询：${name}`);
  await runLoop();
}

// ---------------------------------------------------------------------------
// 界面渲染
// ---------------------------------------------------------------------------

/** 渲染队列：按企业名分组，组内显示各站点状态标签 */
function renderTasks() {
  const fragment = document.createDocumentFragment();
  let index = 0;

  while (index < state.items.length) {
    const { name } = state.items[index];
    const group = [];
    while (index < state.items.length && state.items[index].name === name) {
      group.push(state.items[index]);
      index += 1;
    }

    const row = document.createElement('li');
    const nameEl = document.createElement('span');
    nameEl.className = 'task-name';
    nameEl.textContent = name;
    nameEl.title = name;

    const tags = document.createElement('span');
    tags.className = 'task-tags';
    for (const entry of group) {
      const site = SITES[entry.siteId];
      const tag = document.createElement('span');
      tag.className = `tag ${entry.status}`;
      tag.textContent = site.short;
      tag.title = `${site.label}：${STATUS_LABEL[entry.status]}${
        entry.note ? ` — ${entry.note}` : ''
      }`;
      tags.appendChild(tag);
    }

    row.append(nameEl, tags);
    fragment.appendChild(row);
  }

  dom.taskList.innerHTML = '';
  dom.taskList.appendChild(fragment);
}

/** 更新进度条 */
function updateProgress() {
  const total = state.items.length;
  const finished = state.items.filter(
    (item) => item.status === 'done' || item.status === 'failed'
  ).length;
  dom.progressText.textContent = `${finished} / ${total}`;
  dom.progressBar.style.width = total ? `${(finished / total) * 100}%` : '0%';
}

/** 更新按钮与表单可用状态 */
function updateButtons() {
  const hasItems = state.items.length > 0;
  const hasFailed = state.items.some((item) => item.status === 'failed');

  dom.startBtn.disabled = !hasItems || state.running;
  dom.pauseBtn.disabled = !state.running;
  dom.pauseBtn.textContent = state.paused ? '继续' : '暂停';
  dom.stopBtn.disabled = !state.running;
  dom.retryBtn.disabled = state.running || !hasFailed;

  // 运行中禁止改动输入源
  dom.fileInput.disabled = state.running;
  dom.columnSelect.disabled = state.running;
  dom.hasHeader.disabled = state.running;
  dom.singleNameInput.disabled = state.running;
  dom.singleQueryBtn.disabled = state.running;
  dom.shotToggle.disabled = state.running;
  dom.exportToggle.disabled = state.running;
  // 导出与截图都会用到保存位置，任一开启都可选择文件夹
  const needFolder = dom.shotToggle.checked || dom.exportToggle.checked;
  dom.pickFolderBtn.disabled = state.running || !needFolder;
  dom.clearFolderBtn.disabled = state.running || !needFolder;
  dom.siteList.querySelectorAll('input').forEach((input) => {
    input.disabled = state.running;
  });
}

// ---------------------------------------------------------------------------
// 阻塞提示（验证码 / 登录）
// ---------------------------------------------------------------------------

/** 向页面下发提示条指令 */
async function sendTipToPage(info) {
  if (state.tabId == null) return;
  try {
    await chrome.tabs.sendMessage(
      state.tabId,
      info
        ? { cmd: 'SHOW_TIP', title: info.title, desc: info.desc }
        : { cmd: 'HIDE_TIP' }
    );
  } catch (error) {
    // 页面可能正在跳转，忽略
  }
}

/** 更新阻塞提示：kind 为 null / 'captcha' / 'login' */
async function updateBlockHint(kind) {
  const next = kind || '';
  if (dom.hintBanner.dataset.kind === next) return;
  dom.hintBanner.dataset.kind = next;

  if (!next) {
    dom.hintBanner.hidden = true;
    await sendTipToPage(null);
    return;
  }

  const hints = {
    captcha: { title: '需要人工验证', desc: '请在页面中拖动滑块完成验证，通过后会自动继续。' },
    login: { title: '需要登录', desc: '请在该站点完成登录，登录成功后会自动继续。' },
  };
  const info = hints[next] || hints.captcha;
  dom.hintBanner.textContent = `${info.title}：${info.desc}`;
  dom.hintBanner.hidden = false;
  await sendTipToPage(info);
}

// ---------------------------------------------------------------------------
// 标签页与页面状态
// ---------------------------------------------------------------------------

/** 激活标签页并聚焦窗口（截图要求标签页处于前台） */
async function activateTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    // 置顶失败通常不影响截图，忽略
  }
}

/** 复用同一个标签页，必要时新建 */
async function ensureTab(site) {
  if (state.tabId != null) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && tab.id != null) {
        await activateTab(tab);
        return tab.id;
      }
    } catch (error) {
      state.tabId = null;
    }
  }

  let tabId;
  const tabs = await chrome.tabs.query({ url: site.matchPattern });
  if (tabs.length > 0) {
    tabId = tabs[0].id;
  } else {
    // 先建空标签页，由 navigateAndWait 统一发起一次导航，避免连续两次跳转
    const created = await chrome.tabs.create({ active: true });
    tabId = created.id;
  }

  state.tabId = tabId;
  await activateTab(await chrome.tabs.get(tabId));
  return tabId;
}

/** 跳转到指定地址并等待加载完成 */
async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });

  // 先等待进入 loading，避免把上一次的 complete 状态误判为本次加载完成
  const loadingDeadline = Date.now() + 5000;
  while (Date.now() < loadingDeadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading') break;
    await sleep(150);
  }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(300);
  }
  throw new Error('页面加载超时');
}

/** 查询当前页面状态 */
async function getPageState(tabId, name) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { cmd: 'GET_STATE', name });
    return response && response.state ? response.state : 'unknown';
  } catch (error) {
    return 'loading'; // 页面尚未注入内容脚本，或正在跳转
  }
}

/** 读取标签页地址与加载状态，标签页已关闭时返回占位信息 */
async function getTabInfo(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url || '', status: tab.status || '' };
  } catch (error) {
    return { url: '(标签页已关闭)', status: '' };
  }
}

/** 记录当前所有标签页 id，用于识别点击结果后新开的标签页 */
async function listTabIds() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => tab.id).filter((id) => id != null);
}

/**
 * 等待进入详情页。
 * 兼容两种情况：原标签页直接跳转到详情页；站点在新标签页打开详情页。
 * @returns {Promise<number>} 详情页所在的标签页 id
 */
async function waitDetailPage(tabId, site, name, previousTabIds) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!state.running) throw new Error('已停止');

    if ((await getPageState(tabId, name)) === 'detail') return tabId;

    // 站点用新标签页打开详情时，接管该标签页继续后续提取与截图
    const tabs = await chrome.tabs.query({});
    const opened = tabs.find((tab) => {
      if (tab.id == null || previousTabIds.includes(tab.id)) return false;
      const matched = window.GSXT_MATCH_SITE(tab.url || '');
      return Boolean(matched && matched.id === site.id);
    });
    if (opened) {
      state.tabId = opened.id;
      log(`[${site.short}] 详情页在新标签页打开，已接管该标签页`);
      return opened.id;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // 没等到新标签页时交回原标签页，由调用方继续等待并给出超时信息
  return tabId;
}

/** 等待页面进入期望状态之一，要求状态在页面加载完成后连续两次一致才算稳定 */
async function waitForState(tabId, wanted, timeoutMs, name) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 用户点击停止后立即中断等待
    if (!state.running) throw new Error('已停止');
    const pageState = await getPageState(tabId, name);
    if (pageState === 'debugblock') {
      const tab = await getTabInfo(tabId);
      throw new Error(`站点拒绝访问（检测到浏览器调试状态），当前页面：${tab.url}`);
    }
    if (wanted.includes(pageState)) {
      // 页面可能仍在跳转，确认加载完成且状态未变再返回
      await sleep(700);
      const tab = await getTabInfo(tabId);
      if (tab.status !== 'complete') continue;
      const confirm = await getPageState(tabId, name);
      if (wanted.includes(confirm)) return confirm;
      continue;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const tab = await getTabInfo(tabId);
  throw new Error(`等待页面状态超时（期望：${wanted.join(' / ')}，当前页面：${tab.url}）`);
}

/**
 * 向内容脚本下发指令。
 * 页面跳转的瞬间消息通道会断开，因此遇到通道错误时短暂等待后重试。
 */
async function sendCommand(tabId, payload, attempts = 3) {
  let response = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await chrome.tabs.sendMessage(tabId, payload);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      const tab = await getTabInfo(tabId);
      log(`指令 ${payload.cmd} 通信失败（第 ${attempt} 次）：当前页面=${tab.url}`);
      if (attempt < attempts) await sleep(700);
    }
  }

  if (lastError) {
    const message = lastError.message ? lastError.message : String(lastError);
    throw new Error(`与页面通信失败：${message}`);
  }
  if (response && response.ok === false) {
    throw new Error(response.error || '页面指令执行失败');
  }
  return response;
}

/** 采集当前页面诊断信息，选择器失效时用于排查 */
async function logPageDiagnostics(tabId, name) {
  // 先记录标签页地址，即使内容脚本已失效也能知道页面到底停在哪里
  const tab = await getTabInfo(tabId);
  log(`诊断：标签页地址 ${tab.url}（加载状态 ${tab.status || '-'}）`);

  try {
    const response = await chrome.tabs.sendMessage(tabId, { cmd: 'DIAGNOSE', name });
    const data = response && response.data;
    if (!data) {
      log('诊断：页面无响应（内容脚本未注入，或页面被风控拦截）');
      return;
    }

    log(`诊断：[${data.site}] 标题「${data.title}」 地址 ${data.url}`);
    if (data.bodySample) log(`诊断·页面文本 → ${data.bodySample}`);
    if (!data.inputs.length) log('诊断：页面中未发现任何 input 元素');

    if (Array.isArray(data.nameMatches)) {
      if (!data.nameMatches.length) log('诊断：页面中未出现包含该企业名的元素');
      for (const item of data.nameMatches) {
        log(
          `诊断·同名元素 → tag=${item.tag} class=${item.cls || '-'} ` +
            `href=${item.href || '-'} 所在链接=${item.anchorHref || '-'} 文本=${item.text}`
        );
      }
    }

    if (data.nameHtml) log(`诊断·企业名结构 → ${data.nameHtml}`);

    if (Array.isArray(data.detailLinks)) {
      if (!data.detailLinks.length) log('诊断：页面中未发现详情页链接');
      for (const item of data.detailLinks) {
        log(
          `诊断·详情页链接 → href=${item.href} 文本=${item.text || '-'} ` +
            `target=${item.target || '-'}`
        );
      }
    }

    for (const item of data.inputs) {
      log(
        `诊断·输入框 → tag=${item.tag} id=${item.id || '-'} class=${item.cls || '-'} ` +
          `placeholder=${item.placeholder || '-'} 可见=${item.visible}`
      );
    }
    for (const item of data.actions) {
      log(
        `诊断·含关键词元素 → tag=${item.tag} id=${item.id || '-'} class=${item.cls || '-'} ` +
          `文本=${item.text || '-'} 可见=${item.visible}`
      );
    }
  } catch (error) {
    log('诊断：无法与页面通信（内容脚本未注入，或页面被风控拦截）');
  }
}

// ---------------------------------------------------------------------------
// 截图与保存
// ---------------------------------------------------------------------------

/**
 * 通过 CDP 接口截取整页长图。
 *
 * 注意：不要同时使用 captureBeyondViewport 与 clip。二者叠加时 Chromium 会把
 * 当前视口内容平铺重复填满整个 clip 区域，产出「同一屏内容重复 N 次」的图。
 * 正确做法是把视口本身撑到整页尺寸，再截取视口，页面只排版一次。
 */
async function captureFullPage(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    await chrome.debugger.sendCommand(target, 'Page.enable');

    // 读取设备像素比，保证输出清晰度与页面一致
    let dpr = 1;
    try {
      const dprResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: 'window.devicePixelRatio || 1',
        returnByValue: true,
      });
      dpr = Number(dprResult && dprResult.result && dprResult.result.value) || 1;
    } catch (error) {
      dpr = 1;
    }

    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const size = metrics.cssContentSize || metrics.contentSize || {};
    const width = Math.ceil(size.width) || 1280;
    let height = Math.ceil(size.height) || 800;

    // 单张截图受纹理尺寸限制，把上限换算成 CSS 高度
    const maxCssHeight = Math.max(1, Math.floor(MAX_CAPTURE_HEIGHT / dpr));
    if (height > maxCssHeight) {
      log(`页面高度 ${height}px 超过单张截图上限，按 ${maxCssHeight}px 截取`);
      height = maxCssHeight;
    }

    // 撑大视口后页面可能重新排版导致高度变化，最多校正 3 次
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width,
        height,
        deviceScaleFactor: dpr,
        screenOrientation: { angle: 0, type: 'portraitPrimary' },
      });
      await sleep(400);

      const fresh = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
      const freshSize = fresh.cssContentSize || fresh.contentSize || {};
      const freshHeight = Math.ceil(freshSize.height || height);
      if (freshHeight <= height + 4) break;
      height = Math.min(freshHeight, maxCssHeight);
    }

    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'png',
    });
    return `data:image/png;base64,${result.data}`;
  } finally {
    try {
      await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride');
    } catch (error) {
      // 忽略视口还原失败
    }
    try {
      await chrome.debugger.detach(target);
    } catch (error) {
      // 忽略解绑失败
    }
  }
}

/** 将 dataURL 转为 Blob，便于写入本地文件夹 */
function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(',');
  const mimeMatch = /:(.*?);/.exec(meta);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeMatch ? mimeMatch[1] : 'image/png' });
}

/** 确认目录句柄的写入权限，必要时发起授权 */
async function ensureFolderPermission(handle) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  try {
    return (await handle.requestPermission(options)) === 'granted';
  } catch (error) {
    return false;
  }
}

/** 目录内已有同名文件时追加序号，返回可安全使用的文件名 */
async function uniqueFileName(dir, fileName) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';

  let candidate = fileName;
  for (let index = 1; index < 1000; index += 1) {
    try {
      // 能取到说明文件已存在，换下一个序号
      await dir.getFileHandle(candidate);
    } catch (error) {
      return candidate;
    }
    candidate = `${base} (${index})${ext}`;
  }
  return `${base} (${Date.now()})${ext}`;
}

/** 保存截图：优先写入选定文件夹的站点子目录，失败则回退到下载目录 */
async function saveScreenshot(dataUrl, fileName, siteFolder) {
  if (state.folderHandle) {
    try {
      if (await ensureFolderPermission(state.folderHandle)) {
        const dir = await state.folderHandle.getDirectoryHandle(siteFolder, { create: true });
        const finalName = await uniqueFileName(dir, fileName);
        const fileHandle = await dir.getFileHandle(finalName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(dataUrlToBlob(dataUrl));
        await writable.close();
        return {
          location: `${state.folderHandle.name}\\${siteFolder}`,
          fileName: finalName,
          fallback: false,
        };
      }
      log('保存文件夹授权已失效，本次改为保存到下载目录（可点「选择文件夹」重新授权）');
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(`写入选定文件夹失败：${message}，改为保存到下载目录`);
    }
  }

  const base = sanitizeFileName(state.config.folder || '企业截图');
  await chrome.downloads.download({
    url: dataUrl,
    filename: `${base}/${siteFolder}/${fileName}`,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { location: `下载目录/${base}/${siteFolder}`, fileName, fallback: true };
}

/** 保存二进制文件：优先写入选定文件夹根目录，失败则回退到下载目录 */
async function saveBlob(blob, fileName) {
  if (state.folderHandle) {
    try {
      if (await ensureFolderPermission(state.folderHandle)) {
        const finalName = await uniqueFileName(state.folderHandle, fileName);
        const fileHandle = await state.folderHandle.getFileHandle(finalName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { location: state.folderHandle.name, fileName: finalName };
      }
      log('保存文件夹授权已失效，本次改为保存到下载目录（可点「选择文件夹」重新授权）');
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(`写入选定文件夹失败：${message}，改为保存到下载目录`);
    }
  }

  const base = sanitizeFileName(state.config.folder || '企业截图');
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({
      url,
      filename: `${base}/${fileName}`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
  } finally {
    // 下载启动后再释放对象地址，避免链接提前失效
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  return { location: `下载目录/${base}`, fileName };
}

/** 把本次提取到的企业信息汇总导出为 xlsx */
async function exportRecords() {
  if (!state.records.length) return;

  // 同一企业同一站点重复提取时只保留最后一次，避免重试产生重复行
  const merged = new Map();
  for (const record of state.records) {
    merged.set(`${record['企业名称']}|${record['站点']}`, record);
  }
  // 按约定的固定列输出，页面没有的字段统一填「-」
  const rows = [...merged.values()].map((record) => {
    const row = {};
    for (const column of EXPORT_COLUMNS) {
      const value = record[column];
      row[column] = value === undefined || value === null || value === '' ? '-' : value;
    }
    return row;
  });

  const sheet = XLSX.utils.json_to_sheet(rows, { header: EXPORT_COLUMNS });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '企业信息');

  const buffer = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  try {
    const saved = await saveBlob(blob, `企业信息提取_${timestamp()}.xlsx`);
    log(`已导出汇总表：${saved.location}\\${saved.fileName}（${rows.length} 条记录）`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`导出汇总表失败：${message}`);
  }
}

/** 刷新保存位置文案 */
function updateFolderLabel() {
  dom.folderLabel.textContent = state.folderHandle
    ? `保存到文件夹：${state.folderHandle.name}（按站点自动建子目录）`
    : '未指定，将保存到浏览器下载目录';
}

// ---------------------------------------------------------------------------
// 单条任务处理
// ---------------------------------------------------------------------------

/** 提取当前详情页的企业信息并暂存，失败不影响后续截图 */
async function collectDetailInfo(tabId, item, site) {
  try {
    const result = await sendCommand(tabId, { cmd: 'EXTRACT_INFO', name: item.name });
    const url = (result && result.url) || '';
    const pageState = (result && result.state) || '';

    // 只有确认停在详情页才写入，避免把结果页地址和数据当成企业详情
    if (pageState !== 'detail') {
      log(`[${site.short}] 当前不在详情页（${pageState || '未知'}），跳过信息提取：${url}`);
      return;
    }
    // 独立兜底：地址仍是搜索结果页时同样视为未进入详情页
    if (site.resultsUrlPattern && site.resultsUrlPattern.test(url)) {
      log(`[${site.short}] 地址仍是结果页，跳过信息提取：${url}`);
      return;
    }

    const info = (result && result.info) || {};

    state.records.push({
      ...info,
      企业名称: item.name, // 以导入名称为准，便于与原始名单对齐
      站点: site.short,
      详情页地址: url,
    });

    log(`[${site.short}] 已提取 ${Object.keys(info).length} 个字段`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`[${site.short}] 信息提取失败：${message}`);
  }
}

/** 等待查询出结果，期间处理验证码 / 登录打断 */
async function waitForSearchOutcome(tabId, name, site) {
  let searchDeadline = Date.now() + SEARCH_TIMEOUT_MS;
  let blockDeadline = 0;
  let blockKind = '';
  let resubmitted = false;
  let pendingResubmit = false; // 阻塞解除后是否需要补一次查询
  let homeSince = 0; // 连续处于首页的起始时间
  let lastState = '';

  while (Date.now() < Math.max(searchDeadline, blockDeadline)) {
    // 用户点击停止后立即中断，避免被登录 / 验证码等待拖住数分钟
    if (!state.running) throw new Error('已停止');

    const pageState = await getPageState(tabId, name);

    // 记录状态变化，超时时能看出页面究竟停在哪个状态
    if (pageState !== lastState) {
      lastState = pageState;
      if (pageState !== 'loading') log(`[${site.short}] 页面状态：${pageState}`);
    }

    if (pageState === 'debugblock') {
      blockKind = '';
      await updateBlockHint(null);
      throw new Error('站点拒绝访问：检测到浏览器调试状态（页面提示「请关闭浏览器的调试窗口再访问页面」）');
    }

    if (pageState === 'captcha' || pageState === 'login') {
      if (blockKind !== pageState) {
        blockKind = pageState;
        blockDeadline = Date.now() + BLOCK_TIMEOUT_MS;
        log(
          pageState === 'login'
            ? `[${site.short}] 需要登录，请在页面中完成登录…`
            : `[${site.short}] 检测到验证码，等待人工验证…`
        );
        await updateBlockHint(pageState);
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (blockKind) {
      if (pageState === 'loading') {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      log(`[${site.short}] ${blockKind === 'login' ? '登录' : '验证'}已完成，继续执行`);
      blockKind = '';
      await updateBlockHint(null);

      // 登录后站点常会跳到自己的落地页而不是回到查询结果页，此时需要重新提交一次查询；
      // 但结果页渲染前也可能呈现为首页，因此先观察一段时间，确认确实停在首页再提交
      pendingResubmit = true;
      homeSince = 0;
    }

    if (pendingResubmit && !resubmitted) {
      if (pageState === 'home') {
        if (!homeSince) homeSince = Date.now();
        if (Date.now() - homeSince >= RESUBMIT_GRACE_MS) {
          pendingResubmit = false;
          resubmitted = true;
          searchDeadline = Date.now() + SEARCH_TIMEOUT_MS;
          log(`[${site.short}] 重新提交查询：${name}`);
          await sendCommand(tabId, { cmd: 'FILL_AND_SEARCH', name }).catch(() => {});
        }
      } else if (pageState !== 'loading') {
        // 已进入结果页 / 详情页等，无需再提交
        pendingResubmit = false;
      }
    }

    if (pageState === 'results' || pageState === 'detail' || pageState === 'empty') {
      await updateBlockHint(null);
      return pageState;
    }

    if (pageState === 'home' && Date.now() > searchDeadline) {
      throw new Error('查询未提交成功：页面仍停留在首页，请校准 content/sites.js');
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const timedOut = blockKind;
  blockKind = '';
  await updateBlockHint(null);
  throw new Error(timedOut === 'login' ? '等待登录超时' : '等待查询结果超时');
}

/** 处理单个任务：站点首页 → 填入查询 → 进详情 → 整页截图 → 保存 */
async function processOne(item) {
  const site = SITES[item.siteId];
  let tabId = await ensureTab(site);

  await navigateAndWait(tabId, site.home);
  await waitForState(tabId, ['home'], 30000, item.name);

  log(`[${site.short}] 填入并查询：${item.name}`);
  try {
    await sendCommand(tabId, { cmd: 'FILL_AND_SEARCH', name: item.name });
  } catch (error) {
    // 提交查询后页面可能立刻跳转（如爱企查要求登录会跳到登录页），
    // 此时指令响应会随页面卸载丢失，只要页面已进入可继续等待的状态就交给后续流程
    const pageState = await getPageState(tabId, item.name);
    const recoverable = ['login', 'captcha', 'debugblock', 'loading', 'results', 'detail', 'empty'];
    if (!recoverable.includes(pageState)) throw error;
    log(`[${site.short}] 提交查询后页面已跳转（当前状态：${pageState}），继续跟进`);
  }

  const outcome = await waitForSearchOutcome(tabId, item.name, site);
  if (outcome === 'empty') throw new Error('未查询到该企业');

  if (outcome === 'results') {
    const previousTabIds = await listTabIds();
    const opened = await sendCommand(tabId, { cmd: 'OPEN_FIRST_RESULT', name: item.name });
    if (opened && opened.url) log(`[${site.short}] 打开结果：${opened.url}`);
    // 详情页可能开在新标签页，接管后再确认状态
    tabId = await waitDetailPage(tabId, site, item.name, previousTabIds);
    await waitForState(tabId, ['detail'], 30000, item.name);
  }

  const needExport = dom.exportToggle.checked;
  const needShot = dom.shotToggle.checked;

  // 两项都没开启时，查到详情页即可结束
  if (!needExport && !needShot) {
    log(`[${site.short}] 已完成查询（未开启导出与截图）`);
    return;
  }

  // 详情页多为懒加载：先滚到底再回到顶部，确保页面上所有内容都已渲染
  try {
    await sendCommand(tabId, { cmd: 'SCROLL_PREPARE' });
    await sleep(600);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`[${site.short}] 页面预滚动失败，继续执行：${message}`);
  }

  // 页面已完整渲染，按需提取全部字段
  if (needExport) await collectDetailInfo(tabId, item, site);

  if (!needShot) {
    log(`[${site.short}] 已完成查询（截图开关已关闭，未生成图片）`);
    return;
  }

  const dataUrl = await captureFullPage(tabId);
  const fileName = `${sanitizeFileName(item.name)}_${timestamp()}.png`;
  const saved = await saveScreenshot(dataUrl, fileName, site.folder);
  log(`[${site.short}] 已保存到 ${saved.location}\\${saved.fileName}`);
}

/** 主循环：串行处理队列 */
async function runLoop() {
  state.running = true;
  state.paused = false;
  updateButtons();
  setStatusText('运行中');
  log('任务开始');

  try {
    while (state.running) {
      if (state.paused) {
        await sleep(300);
        continue;
      }

      const index = state.items.findIndex((entry) => entry.status === 'pending');
      if (index === -1) break;

      const item = state.items[index];
      item.status = 'running';
      item.note = '';
      renderTasks();
      setStatusText(`查询中：${item.name} · ${SITES[item.siteId].short}`);

      try {
        await processOne(item);
        item.status = 'done';
      } catch (error) {
        if (!state.running) {
          // 用户点击停止导致的中断不算失败，保留待处理状态
          item.status = 'pending';
          item.note = '';
          log('已停止，当前任务保持待处理');
        } else {
          item.status = 'failed';
          item.note = error && error.message ? error.message : String(error);
          log(`失败：[${SITES[item.siteId].short}] ${item.name} — ${item.note}`);
          await updateBlockHint(null);
          // 失败时自动采集页面结构，便于校准选择器
          if (state.tabId != null) await logPageDiagnostics(state.tabId, item.name);
        }
      }

      renderTasks();
      updateProgress();
      updateButtons();

      if (!state.running) break;
      if (state.items.some((entry) => entry.status === 'pending')) {
        const delay = randomBetween(state.config.minDelayMs, state.config.maxDelayMs);
        log(`等待 ${(delay / 1000).toFixed(1)}s 后继续`);
        await sleep(delay);
      }
    }
  } finally {
    state.running = false;
    state.paused = false;
    await updateBlockHint(null);
    updateButtons();
    // 无论正常结束还是中途停止，都把已提取到的信息汇总落表
    await exportRecords();
    const failedCount = state.items.filter((entry) => entry.status === 'failed').length;
    setStatusText(failedCount > 0 ? `已结束（失败 ${failedCount} 个）` : '已全部完成');
    log('任务结束');
  }
}

// ---------------------------------------------------------------------------
// 事件绑定与初始化
// ---------------------------------------------------------------------------

/** 单个企业名称查询：点击「查询」或输入框回车触发 */
dom.singleQueryBtn.addEventListener('click', () => {
  querySingleName();
});

dom.singleNameInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  querySingleName();
});

dom.shotToggle.addEventListener('change', () => {
  updateButtons();
  log(dom.shotToggle.checked ? '已开启截图' : '已关闭截图，仅执行查询');
});

dom.exportToggle.addEventListener('change', () => {
  updateButtons();
  log(dom.exportToggle.checked ? '已开启企业信息导出' : '已关闭企业信息导出');
});

dom.fileInput.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    await handleFile(file);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`读取文件失败：${message}`);
    window.alert(`读取文件失败：${message}`);
  }
});

dom.hasHeader.addEventListener('change', () => {
  if (state.rawRows.length) buildColumnOptions();
});

dom.columnSelect.addEventListener('change', () => {
  if (state.rawRows.length) buildItems();
});

dom.siteList.addEventListener('change', () => {
  if (state.running) return;
  if (state.rawRows.length) buildItems();
});

dom.startBtn.addEventListener('click', () => {
  if (state.running || !state.items.length) return;
  runLoop();
});

dom.pauseBtn.addEventListener('click', () => {
  if (!state.running) return;
  state.paused = !state.paused;
  setStatusText(state.paused ? '已暂停' : '运行中');
  log(state.paused ? '已暂停' : '已继续');
  updateButtons();
});

dom.stopBtn.addEventListener('click', () => {
  if (!state.running) return;
  state.running = false;
  state.paused = false;
  log('已请求停止，将在当前任务结束后停止');
  updateButtons();
});

dom.retryBtn.addEventListener('click', () => {
  if (state.running) return;
  let count = 0;
  for (const item of state.items) {
    if (item.status === 'failed') {
      item.status = 'pending';
      item.note = '';
      count += 1;
    }
  }
  if (!count) return;
  log(`已把 ${count} 个失败任务重置为待处理`);
  renderTasks();
  updateProgress();
  updateButtons();
});

dom.pickFolderBtn.addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') {
    log('当前浏览器不支持文件夹选择器，截图将保存到浏览器下载目录');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'gsxt-shots', mode: 'readwrite' });
    state.folderHandle = handle;
    await FolderStore.saveHandle(handle);
    updateFolderLabel();
    log(`截图保存目录已设为：${handle.name}`);
  } catch (error) {
    if (error && error.name === 'AbortError') return; // 用户取消了选择
    log(`选择文件夹失败：${error && error.message ? error.message : error}`);
  }
});

dom.clearFolderBtn.addEventListener('click', async () => {
  state.folderHandle = null;
  try {
    await FolderStore.clearHandle();
  } catch (error) {
    // 清理失败不影响使用
  }
  updateFolderLabel();
  log('已清除保存目录，截图将保存到浏览器下载目录');
});

/** 初始化：渲染站点、读取配置与保存目录 */
async function init() {
  renderSiteOptions();

  try {
    const stored = await chrome.storage.local.get('gsxt.config');
    if (stored['gsxt.config']) {
      state.config = { ...state.config, ...stored['gsxt.config'] };
    }
  } catch (error) {
    // 使用默认配置
  }

  try {
    state.folderHandle = await FolderStore.loadHandle();
  } catch (error) {
    state.folderHandle = null;
  }
  updateFolderLabel();

  log('面板已就绪，请输入单个企业名称，或导入包含企业名称的 Excel / CSV 文件');
  updateButtons();
}

init();
