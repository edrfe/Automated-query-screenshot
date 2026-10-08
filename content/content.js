/**
 * 内容脚本：在目标站点页面上执行查询与截图前的准备工作。
 *
 * 设计说明：
 * 1. 站点差异全部由 content/sites.js 的适配器配置描述，本文件保持站点无关；
 * 2. 页面在查询后会整体跳转，内容脚本会被重新注入，因此本脚本不保存任务状态；
 * 3. 由侧边栏面板通过 chrome.tabs.sendMessage 轮询「页面状态」来驱动流程；
 * 4. 只负责页面操作与整页内容加载，截图由面板通过 chrome.debugger 完成。
 */
(() => {
  if (window.__GSXT_HELPER_LOADED__) return;
  window.__GSXT_HELPER_LOADED__ = true;

  const SITE = window.GSXT_MATCH_SITE ? window.GSXT_MATCH_SITE(location.href) : null;
  if (!SITE) return;

  /** 站点未声明的配置项由此兜底 */
  const DEFAULTS = {
    searchInput: [],
    searchButton: [],
    searchInputHint: /企业名称|公司名|公司名称|单位名称|统一社会信用代码|注册号|请输入.*名称/,
    challenge: ['[class*="geetest"]', '[class*="captcha"]', '[id*="captcha"]', '[class*="sliderVerify"]'],
    resultLink: [],
    emptyHint: /暂无数据|暂无查询结果|未查询到|无查询结果|没有找到|无相关结果/,
    blockHint: null,
    detailUrlPattern: null,
    loginUrlPattern: null,
    resultsUrlPattern: null,
    allowNonAnchorResult: false,
    detailText: null,
    loginDialog: [],
  };
  const CFG = Object.assign({}, DEFAULTS, SITE);

  /** 简易延时 */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 判断元素是否可见 */
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  /** 按候选选择器列表查找第一个可见元素 */
  function queryFirst(selectors, filter) {
    for (const selector of selectors || []) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        continue;
      }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        if (filter && !filter(node)) continue;
        return node;
      }
    }
    return null;
  }

  /** 查找搜索输入框：先按候选选择器，再按 placeholder 特征兜底 */
  function findSearchInput() {
    const bySelector = queryFirst(CFG.searchInput, (el) => el.tagName === 'INPUT');
    if (bySelector) return bySelector;

    const hint = CFG.searchInputHint;
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    return (
      inputs.find((el) => isVisible(el) && hint.test(el.getAttribute('placeholder') || '')) || null
    );
  }

  /** 查找查询按钮：先按候选选择器，再按文案，最后按输入框相邻节点兜底 */
  function findSearchButton(input) {
    const bySelector = queryFirst(CFG.searchButton);
    if (bySelector) return bySelector;

    // 兼容用 input 实现的按钮
    const submitInput = Array.from(
      document.querySelectorAll('input[type="submit"], input[type="button"], input[type="image"]')
    )
      .filter(isVisible)
      .find((el) => /查询|搜索|查一下/.test(el.value || el.alt || ''));
    if (submitInput) return submitInput;

    const visibleNodes = Array.from(document.querySelectorAll('button, a, div, span, i')).filter(
      isVisible
    );

    // 1) 文案精确匹配
    const exact = visibleNodes.find((el) => {
      const text = (el.textContent || '').trim();
      return text === '查询' || text === '搜索';
    });
    if (exact) return exact;

    // 2) 短文案匹配（覆盖「查一下」「搜一下」等）
    const loose = visibleNodes.find((el) => {
      const text = (el.textContent || '').trim();
      return text.length > 0 && text.length <= 4 && /查|搜/.test(text);
    });
    if (loose) return loose;

    // 3) 与输入框同一容器内的可点击节点
    if (input) {
      const scope =
        input.closest('form, [class*="search"], [class*="seach"], [class*="Search"]') ||
        input.parentElement;
      if (scope) {
        const candidates = Array.from(scope.querySelectorAll('button, a, div, span, i')).filter(
          (el) => isVisible(el) && el !== input && !el.contains(input)
        );
        const hit = candidates.find((el) => /查|搜/.test(el.textContent || ''));
        if (hit) return hit;
      }
    }

    return null;
  }

  /** 查找验证码容器（过滤掉页面上的小图标） */
  function findChallenge() {
    for (const selector of CFG.challenge) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        continue;
      }
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 100 || rect.height < 30) continue;
        return el;
      }
    }
    return null;
  }

  /** 查找登录弹窗：必须是面积较大的弹层且含登录相关文案，避免误判页头的「登录」链接 */
  function findLoginDialog() {
    for (const selector of CFG.loginDialog) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector));
      } catch (error) {
        continue;
      }
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 120) continue;
        const text = (el.textContent || '').replace(/\s+/g, '');
        if (!text.includes('登录')) continue;
        if (!/手机号|扫码|验证码|账号|密码/.test(text)) continue;
        return el;
      }
    }
    return null;
  }

  /** 判断是否已进入企业详情页 */
  function isDetailPage() {
    if (CFG.detailUrlPattern && CFG.detailUrlPattern.test(location.href)) return true;

    const rule = CFG.detailText;
    if (!rule) return false;

    const text = document.body ? document.body.innerText : '';
    const hasAll = Array.isArray(rule.all) && rule.all.length > 0;
    const hasAny = Array.isArray(rule.any) && rule.any.length > 0;
    if (!hasAll && !hasAny) return false;

    if (hasAll && !rule.all.every((keyword) => text.includes(keyword))) return false;
    if (hasAny && !rule.any.some((keyword) => text.includes(keyword))) return false;
    return true;
  }

  /** 判断结果页是否为「无数据」 */
  function isEmptyResult() {
    const text = document.body ? document.body.innerText : '';
    return CFG.emptyHint.test(text);
  }

  /**
   * 结果链接必须指向详情页。
   * 站点定义了详情页地址特征时据此过滤，避免点到资讯、推荐位等干扰链接。
   */
  function isResultCandidate(el) {
    if (!CFG.detailUrlPattern) return true;
    const href = el.getAttribute('href') || '';
    if (!href) return false;
    try {
      return CFG.detailUrlPattern.test(new URL(href, location.href).href);
    } catch (error) {
      return false;
    }
  }

  /** 查找搜索结果链接，优先使用已知选择器，其次匹配包含关键词的链接 */
  function findResultLinks(name) {
    const keyword = (name || '').trim();

    for (const selector of CFG.resultLink) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector))
          .filter(isVisible)
          .filter(isResultCandidate);
      } catch (error) {
        continue;
      }
      if (!nodes.length) continue;
      // 候选节点中优先取文本包含企业名的那个，避免命中推荐位等干扰项
      if (keyword) {
        const matched = nodes.filter((el) => (el.textContent || '').trim().includes(keyword));
        if (matched.length) return matched;
      }
      return nodes;
    }

    if (!keyword) return [];

    const anchors = Array.from(document.querySelectorAll('a'))
      .filter(isVisible)
      .filter((el) => {
        // 页头页脚导航里的同名链接不是结果条目
        if (el.closest('header, nav, footer')) return false;
        if (/^javascript:/i.test(el.getAttribute('href') || '')) return false;
        const text = (el.textContent || '').trim();
        return text.length >= 4 && text.length <= 60 && text.includes(keyword);
      })
      .filter(isResultCandidate);
    if (anchors.length) return anchors;

    // 部分站点的结果条目不是 <a>，而是 SPA 用 JS 路由的可点击元素，此时按企业名定位
    if (CFG.allowNonAnchorResult) {
      const items = Array.from(document.querySelectorAll('div, span, h2, h3, p'))
        .filter(isVisible)
        .filter((el) => !el.closest('header, nav, footer'))
        .filter((el) => {
          const text = (el.textContent || '').trim();
          return text.length >= 4 && text.length <= 60 && text.includes(keyword);
        });
      if (items.length) {
        // 文本最短的元素最接近企业名本身
        return [
          items.reduce((best, el) =>
            (el.textContent || '').trim().length < (best.textContent || '').trim().length ? el : best
          ),
        ];
      }
    }

    return [];
  }

  /** 探测当前页面状态，供面板轮询 */
  function detectState(name) {
    const pageText = document.body ? document.body.innerText : '';
    // 站点拦截页优先级最高，命中后无需再判断其它状态
    if (CFG.blockHint && CFG.blockHint.test(pageText)) return 'debugblock';
    // 未登录被重定向到登录页时，页面上可能没有弹窗，靠地址判断更可靠
    if (CFG.loginUrlPattern && CFG.loginUrlPattern.test(location.href)) return 'login';
    if (findChallenge()) return 'captcha';
    if (findLoginDialog()) return 'login';
    if (isDetailPage()) return 'detail';
    if (isEmptyResult()) return 'empty';
    // 结果页地址特征明确时只在对应地址上判定，避免把资讯页里含企业名的链接误判为结果
    const resultsAllowed = !CFG.resultsUrlPattern || CFG.resultsUrlPattern.test(location.href);
    if (resultsAllowed && findResultLinks(name).length) return 'results';
    if (findSearchInput()) return 'home';
    return 'unknown';
  }

  /** 页面内提示条 */
  let tipElement = null;
  function showTip(title, desc) {
    if (!tipElement) {
      tipElement = document.createElement('div');
      tipElement.id = 'gsxt-helper-tip';
      document.body.appendChild(tipElement);
    }
    tipElement.innerHTML = '<div class="tip-title"></div><div class="tip-desc"></div>';
    tipElement.querySelector('.tip-title').textContent = title;
    tipElement.querySelector('.tip-desc').textContent = desc || '';
  }
  function hideTip() {
    if (tipElement) {
      tipElement.remove();
      tipElement = null;
    }
  }

  /** 向输入框派发回车事件，作为查询按钮缺失时的兜底提交方式 */
  function pressEnter(input) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
        })
      );
    }
  }

  /** 抓取企业名所在元素的容器 HTML，用于确认结果条目的真实结构 */
  function collectNameHtml(keyword) {
    if (!keyword) return '';

    const hits = Array.from(document.querySelectorAll('a, div, span, h2, h3, p'))
      .filter((el) => {
        if (!isVisible(el)) return false;
        const text = (el.textContent || '').trim();
        return text.length >= 4 && text.length <= 60 && text.includes(keyword);
      });
    if (!hits.length) return '';

    // 文本最短的那个最接近企业名本身，再向上取整条结果条目
    const target = hits.reduce((best, el) =>
      (el.textContent || '').trim().length < (best.textContent || '').trim().length ? el : best
    );
    const node = target.closest('a') || target.closest('[class]') || target;
    return (node.outerHTML || '').replace(/\s+/g, ' ').slice(0, 800);
  }

  /** 收集页面诊断信息，用于选择器失效时快速定位问题 */
  function collectDiagnostics(name) {
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: typeof el.className === 'string' && el.className ? el.className.slice(0, 60) : undefined,
      text: (el.textContent || '').trim().slice(0, 20) || undefined,
      placeholder: (el.getAttribute && el.getAttribute('placeholder')) || undefined,
      visible: isVisible(el),
    });

    const keyword = (name || '').trim();

    return {
      site: CFG.id,
      url: location.href,
      title: document.title,
      // 页面可见文本样本，用于判断站点实际返回了什么内容
      bodySample: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 300),
      inputs: Array.from(document.querySelectorAll('input')).slice(0, 8).map(describe),
      // 与目标企业名相关的元素样本，用于定位结果条目的真实结构
      nameMatches: keyword
        ? Array.from(document.querySelectorAll('a, div, span, h2, h3, p, li'))
            .filter((el) => {
              if (!isVisible(el)) return false;
              const text = (el.textContent || '').trim();
              return text.length >= 4 && text.length <= 60 && text.includes(keyword);
            })
            .slice(0, 8)
            .map((el) => {
              const anchor = el.closest('a');
              return {
                tag: el.tagName.toLowerCase(),
                cls: typeof el.className === 'string' ? el.className.slice(0, 60) : undefined,
                href: el.getAttribute('href') || undefined,
                anchorHref: anchor ? anchor.getAttribute('href') : undefined,
                text: (el.textContent || '').trim().slice(0, 30),
              };
            })
        : [],
      // 详情页链接样本：结果页找不到条目时，用它判断页面上到底有没有详情页链接
      detailLinks: CFG.detailUrlPattern
        ? Array.from(document.querySelectorAll('a'))
            .filter((el) => isVisible(el) && isResultCandidate(el))
            .slice(0, 5)
            .map((el) => ({
              href: el.getAttribute('href'),
              text: (el.textContent || '').trim().slice(0, 30),
              target: el.getAttribute('target') || undefined,
            }))
        : [],
      // 企业名所在元素及其容器 HTML，用于直接确认结果条目的真实结构
      nameHtml: collectNameHtml(keyword),
      actions: Array.from(document.querySelectorAll('button, a, div, span, i, li'))
        .filter((el) => /查询|搜索|查一下|检索/.test((el.textContent || '').trim().slice(0, 6)))
        .slice(0, 8)
        .map(describe),
    };
  }

  /** 填入企业名称并提交查询 */
  async function fillAndSearch(name) {
    const input = findSearchInput();
    if (!input) throw new Error('未找到搜索输入框，请校准 content/sites.js');

    input.focus();
    // 使用原生 value setter 赋值，兼容 Vue/React 的双向绑定
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    valueSetter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    valueSetter.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(400);

    const button = findSearchButton(input);
    if (button) {
      button.click();
    } else {
      // 找不到按钮时不直接失败，先退化为回车提交
      console.warn('[gsxt-helper] 未找到查询按钮，改用回车提交');
      pressEnter(input);
    }

    // 兜底：若页面仍停留在首页，再用回车提交一次
    await sleep(1500);
    if (!findChallenge() && detectState(name) === 'home') {
      pressEnter(input);
    }
  }

  /** 打开第一条搜索结果，返回实际打开的地址供日志追踪 */
  async function openFirstResult(name) {
    const links = findResultLinks(name);
    if (!links.length) throw new Error('未找到搜索结果条目，请校准 content/sites.js');

    const link = links[0];
    const href = link.getAttribute('href') || '';
    const absolute = href && !/^javascript:/i.test(href) ? new URL(href, location.href).href : '';
    const opensNewTab = (link.getAttribute('target') || '') === '_blank';

    // 结果条目标记了新标签页打开时，直接点击会让原页面停滞，改为在当前标签页跳转
    if (opensNewTab && absolute) {
      // 延后跳转，确保指令响应先返回面板，避免消息通道因页面卸载而中断
      setTimeout(() => {
        window.location.href = absolute;
      }, 50);
      return { url: absolute };
    }

    link.click();
    return { url: absolute || '(由页面脚本跳转)' };
  }

  /** 滚动到底部触发懒加载，再回到顶部，确保整页内容完整 */
  async function scrollPrepare() {
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    let offset = 0;
    let guard = 0;

    while (guard++ < 300) {
      const total = document.documentElement.scrollHeight;
      if (offset >= total) break;
      offset += step;
      window.scrollTo(0, offset);
      await sleep(220);
    }

    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(700);

    // 等待懒加载导致的高度变化趋于稳定
    let lastHeight = -1;
    for (let i = 0; i < 8; i += 1) {
      const height = document.documentElement.scrollHeight;
      if (height === lastHeight) break;
      lastHeight = height;
      await sleep(300);
    }

    window.scrollTo(0, 0);
    await sleep(500);
  }

  // 监听面板下发的指令
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.cmd) return undefined;

    (async () => {
      try {
        switch (message.cmd) {
          case 'PING':
            sendResponse({ ok: true, site: CFG.id, href: location.href });
            break;
          case 'GET_STATE':
            sendResponse({ state: detectState(message.name) });
            break;
          case 'FILL_AND_SEARCH':
            await fillAndSearch(message.name);
            sendResponse({ ok: true });
            break;
          case 'OPEN_FIRST_RESULT': {
            const opened = await openFirstResult(message.name);
            sendResponse({ ok: true, url: opened.url });
            break;
          }
          case 'SCROLL_PREPARE':
            await scrollPrepare();
            sendResponse({ ok: true });
            break;
          case 'DIAGNOSE':
            sendResponse({ ok: true, data: collectDiagnostics(message.name) });
            break;
          case 'SHOW_TIP':
            showTip(message.title || '提示', message.desc);
            sendResponse({ ok: true });
            break;
          case 'HIDE_TIP':
            hideTip();
            sendResponse({ ok: true });
            break;
          default:
            sendResponse({ ok: false, error: `未知指令：${message.cmd}` });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error && error.message ? error.message : String(error) });
      }
    })();

    // 保持消息通道打开以支持异步响应
    return true;
  });
})();
