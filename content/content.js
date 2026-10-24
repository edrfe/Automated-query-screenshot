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
    detailUrlHint: null,
    loginUrlPattern: null,
    resultsUrlPattern: null,
    allowNonAnchorResult: false,
    detailText: null,
    loginDialog: [],
  };
  const CFG = Object.assign({}, DEFAULTS, SITE);

  /** 简易延时 */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 判断元素是否可见：需要有实际尺寸，且未被样式隐藏 */
  function isVisible(el) {
    if (!el) return false;
    if (!el.getClientRects().length) return false;
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

  /** 元素是否位于搜索区域内，避免把页面其它位置的「查询」字样当成按钮 */
  function inSearchScope(el) {
    return Boolean(
      el.closest('form, [class*="search"], [class*="seach"], [class*="Search"], [id*="search"]')
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
      .find((el) => /查询|搜索|查一下/.test((el.value || el.alt || '').replace(/\s+/g, '')));
    if (submitInput) return submitInput;

    // 站点按钮文案常写成「查 询」，比对前先去掉空白
    const compact = (el) => (el.textContent || '').replace(/\s+/g, '');
    const isQueryText = (text) =>
      text === '查询' || text === '搜索' || text === '查一下' || text === '搜一下';

    // 可点击标签优先，避免点到没有事件绑定的内层文字
    const clickables = Array.from(
      document.querySelectorAll('button, a, [role="button"]')
    ).filter(isVisible);
    const scoped = clickables.filter(inSearchScope);

    // 1) 文案精确匹配：搜索区域内的元素优先
    const exact =
      scoped.find((el) => isQueryText(compact(el))) ||
      clickables.find((el) => isQueryText(compact(el)));
    if (exact) return exact;

    // 2) 短文案匹配（覆盖「查」「搜」等单字按钮）
    const loose = (scoped.length ? scoped : clickables).find((el) => {
      const text = compact(el);
      return text.length >= 1 && text.length <= 2 && /查|搜/.test(text);
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

    // 4) 按位置兜底：输入框右侧紧邻、且垂直方向有重叠的可点击元素（按钮可能无文字或是图片）
    if (input) {
      const base = input.getBoundingClientRect();
      const candidates = Array.from(
        document.querySelectorAll(
          'button, a, [role="button"], input[type="button"], input[type="submit"], input[type="image"]'
        )
      ).filter((el) => isVisible(el) && el !== input && !el.contains(input) && !input.contains(el));

      let nearest = null;
      let nearestGap = Infinity;
      for (const el of candidates) {
        const text = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim();
        // 输入框右侧的清除按钮不是查询按钮
        if (/清空|清除|close|reset/i.test(text)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.left < base.right - 10) continue;
        if (rect.bottom < base.top || rect.top > base.bottom) continue;
        const gap = rect.left - base.right;
        if (gap < nearestGap) {
          nearestGap = gap;
          nearest = el;
        }
      }
      if (nearest) return nearest;
    }

    // 5) 最后才退到普通容器（部分站点用 div 做按钮）
    const container = Array.from(document.querySelectorAll('div, span, i'))
      .filter(isVisible)
      .find((el) => isQueryText(compact(el)));
    if (container) return container;

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

  /** 结果列表是否仍显示在页面上（存在则说明还没进入详情页） */
  function hasResultList() {
    if (!Array.isArray(CFG.resultLink)) return false;
    return CFG.resultLink.some((selector) => {
      try {
        return Array.from(document.querySelectorAll(selector)).some(isVisible);
      } catch (error) {
        return false;
      }
    });
  }

  /**
   * 是否位于企业详情页。
   * 判定顺序：详情页 URL 特征 → 详情页 URL 提示 → 排除结果页地址；
   * 都不成立时要求：结果列表已消失、详情页特有文案齐全，且页面展示的确实是目标企业。
   */
  function isDetailPage(name) {
    // 详情页 URL 特征最可靠，先认它
    if (CFG.detailUrlPattern && CFG.detailUrlPattern.test(location.href)) return true;
    // URL 提示只用于判定、不参与结果链接过滤，命中即认定已进入详情页
    if (CFG.detailUrlHint && CFG.detailUrlHint.test(location.href)) return true;
    // 明确停留在结果页地址时一律不算详情页，避免把结果卡片里展示的信用代码当成详情数据
    if (CFG.resultsUrlPattern && CFG.resultsUrlPattern.test(location.href)) return false;

    const rule = CFG.detailText;
    if (!rule) return false;

    // 结果列表仍在，说明停留在结果页（gsxt 的结果条目同样展示信用代码等字段）
    if (hasResultList()) return false;

    const text = document.body ? document.body.innerText : '';
    const hasAll = Array.isArray(rule.all) && rule.all.length > 0;
    const hasAny = Array.isArray(rule.any) && rule.any.length > 0;
    if (!hasAll && !hasAny) return false;

    if (hasAll && !rule.all.every((keyword) => text.includes(keyword))) return false;
    // 允许站点要求命中多个特征文案，结果页通常只会零星出现一个词
    if (hasAny) {
      const hits = rule.any.filter((keyword) => text.includes(keyword)).length;
      if (hits < (rule.minAny || 1)) return false;
    }

    // 详情页必须展示目标企业，避免停在别的页面
    const keyword = String(name || '').trim();
    if (keyword && !text.includes(keyword)) return false;

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

  /** 结果条目的文本是否像企业名（排除分页、操作按钮等干扰项） */
  function isResultText(text) {
    const value = normalizeText(text);
    if (!value || value.length > 60) return false;
    return !/^(上一页|下一页|首页|末页|尾页|确定|取消|查看更多|更多)$/.test(value);
  }

  /** 查找搜索结果链接，优先使用已知选择器，其次匹配包含关键词的链接 */
  function findResultLinks(name) {
    const keyword = (name || '').trim();
    let fallback = []; // 选择器命中但没有一条包含企业名时的兜底候选

    for (const selector of CFG.resultLink) {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll(selector))
          .filter(isVisible)
          .filter((el) => isResultText(el.textContent))
          .filter(isResultCandidate);
      } catch (error) {
        continue;
      }
      if (!nodes.length) continue;
      // 候选节点中优先取文本包含企业名的那个，避免命中推荐位等干扰项
      if (keyword) {
        const matched = nodes.filter((el) => (el.textContent || '').trim().includes(keyword));
        if (matched.length) return matched;
        // 该选择器命中的都不是目标企业，继续尝试下一个选择器
        if (!fallback.length) fallback = nodes;
        continue;
      }
      return nodes;
    }

    // 所有选择器都没匹配到企业名时，仍取第一个选择器的结果，保证默认点击第一条
    if (fallback.length) return fallback;
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
      const items = Array.from(document.querySelectorAll('div, span, h1, h2, h3, p, strong, b'))
        .filter(isVisible)
        .filter((el) => !el.closest('header, nav, footer'))
        .filter((el) => {
          const text = (el.textContent || '').trim();
          return text.length >= 4 && text.length <= 60 && text.includes(keyword);
        });
      if (items.length) {
        // 按页面顺序取第一个，即结果列表里的第一条企业
        return [items[0]];
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
    if (isDetailPage(name)) return 'detail';
    // 结果页地址特征明确时只在对应地址上判定，避免把资讯页里含企业名的链接误判为结果
    const resultsAllowed = !CFG.resultsUrlPattern || CFG.resultsUrlPattern.test(location.href);
    // 先判有结果：结果页的侧栏、页脚常出现「暂无数据」等文案，先判空结果会误报
    if (resultsAllowed && findResultLinks(name).length) return 'results';
    if (isEmptyResult()) return 'empty';
    // 地址已确认是结果页但条目还没渲染出来时，按加载中处理，
    // 否则结果页顶部的搜索框会让页面被误判为首页，触发重复查询
    if (CFG.resultsUrlPattern && CFG.resultsUrlPattern.test(location.href)) return 'loading';
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

  /**
   * 提交后确认页面是否真的离开了首页。
   * 只用于判断「这次提交是否生效」，未生效才补一次，避免重复搜索。
   */
  async function waitSubmitted(name, timeoutMs) {
    const startHref = location.href;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      if (location.href !== startHref) return true;
      const state = detectState(name);
      if (state !== 'home' && state !== 'unknown') return true;
    }
    return false;
  }

  /** 用完整鼠标事件序列再点一次，兼容只监听 mousedown / mouseup 的按钮 */
  function dispatchClick(el) {
    const rect = el.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.dispatchEvent(new MouseEvent('mousedown', options));
    el.dispatchEvent(new MouseEvent('mouseup', options));
    el.dispatchEvent(new MouseEvent('click', options));
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
    if (!button) {
      // 找不到按钮时不直接失败，先退化为回车提交
      console.warn('[gsxt-helper] 未找到查询按钮，改用回车提交');
      pressEnter(input);
      return;
    }

    // 先正常点击，确认页面确实有反应；没反应才补一次鼠标事件与回车，
    // 已提交的情况下不再补，避免重复搜索刷新已出的结果。
    button.click();
    if (await waitSubmitted(name, 2500)) return;

    dispatchClick(button);
    if (await waitSubmitted(name, 1500)) return;

    console.warn('[gsxt-helper] 点击查询按钮未生效，改用回车提交');
    pressEnter(input);
  }

  /** 打开第一条搜索结果，返回实际打开的地址供日志追踪 */
  async function openFirstResult(name) {
    const links = findResultLinks(name);
    if (!links.length) throw new Error('未找到搜索结果条目，请校准 content/sites.js');

    // 命中的可能只是企业名文字节点，点击事件绑定在最近的链接 / 行容器上
    const link = links[0];
    const target = link.closest('a, button, [onclick], li, tr') || link;
    const href = target.getAttribute('href') || link.getAttribute('href') || '';
    const absolute = href && !/^javascript:/i.test(href) ? new URL(href, location.href).href : '';
    const opensNewTab =
      (target.getAttribute('target') || link.getAttribute('target') || '') === '_blank';

    // 先滚动到可视区域，避免懒加载列表中的条目点击无效
    try {
      target.scrollIntoView({ block: 'center' });
      await sleep(200);
    } catch (error) {
      /* 滚动失败不影响后续点击 */
    }

    // 结果条目标记了新标签页打开时，直接点击会让原页面停滞，改为在当前标签页跳转
    if (opensNewTab && absolute) {
      // 延后跳转，确保指令响应先返回面板，避免消息通道因页面卸载而中断
      setTimeout(() => {
        window.location.href = absolute;
      }, 50);
      return { url: absolute };
    }

    target.click();
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

  // -------------------------------------------------------------------------
  // 详情页信息提取
  // -------------------------------------------------------------------------

  /** 详情页常见字段与别名，用于按标签定位取值 */
  const FIELD_LABELS = [
    ['企业名称', ['企业名称', '公司名称', '单位名称']],
    ['统一社会信用代码', ['统一社会信用代码', '社会统一信用代码', '信用代码', '统一代码']],
    ['法定代表人', ['法定代表人', '法人代表', '经营者', '负责人']],
    ['注册资本', ['注册资本', '注册资金']],
    ['成立日期', ['成立日期', '成立时间', '注册时间']],
    ['登记状态', ['登记状态', '经营状态', '企业状态']],
    ['企业类型', ['企业类型', '企业(机构)类型', '企业（机构）类型', '公司类型', '主体类型', '类型']],
    ['工商注册号', ['工商注册号', '注册号']],
    ['组织机构代码', ['组织机构代码', '组织机构编码', '组织代码']],
    ['纳税人识别号', ['纳税人识别号', '纳税人识别码', '税号']],
    ['纳税人资质', ['纳税人资质', '纳税人资格', '纳税人类型']],
    ['注册地址', ['注册地址', '住所', '企业地址', '地址']],
    ['经营范围', ['经营范围', '许可经营项目', '一般经营项目']],
    ['所属行业', ['所属行业', '所属门类', '行业', '行业代码', '国民经济行业分类']],
    ['营业期限', ['营业期限', '经营期限']],
    ['登记机关', ['登记机关', '登记机构']],
    ['核准日期', ['核准日期', '核准时间', '发照日期']],
    ['联系电话', ['联系电话', '电话号码', '电话']],
    ['电子邮箱', ['电子邮箱', '邮箱']],
    ['网址', ['网址', '官网']],
    ['行政区划', ['行政区划', '所属地区', '所在地区']],
    ['实缴资本', ['实缴资本', '实缴出资额', '实缴金额']],
    ['曾用名', ['曾用名', '曾用名称', '原名称', '旧名称', '历史名称']],
    ['参保人数', ['参保人数', '参保职工人数']],
    ['分支机构参保人数', ['分支机构参保人数', '分支参保人数']],
  ];

  const ALL_LABEL_TEXTS = new Set(FIELD_LABELS.flatMap((entry) => entry[1]));

  /** 合并空白字符，便于比对与落表 */
  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim();
  }

  /** 去掉结尾的冒号与问号提示图标文本，仅用于标签比对 */
  function trimLabel(value) {
    return normalizeText(value).replace(/[\s:：?？]+$/, '');
  }

  /** 一次扫描建立「标签文本 → 元素列表」索引，同名字段保留全部候选 */
  function buildLabelIndex() {
    const index = new Map();
    const nodes = document.querySelectorAll('span,div,dt,th,td,label,p,li,em,b,strong');
    for (const node of nodes) {
      const text = trimLabel(node.textContent);
      // 标签都很短，过长的文本直接跳过，减少无效比对
      if (!text || text.length > 24) continue;
      if (!index.has(text)) index.set(text, []);
      index.get(text).push(node);
    }
    return index;
  }

  /** 统一社会信用代码兜底：按 18 位编码规则从文本中直接匹配 */
  function matchCreditCode(text) {
    // 字符集不含 I O S V Z，前后不能紧邻字母数字，避免截取到更长的串
    const match = text.match(/(?<![0-9A-Z])[0-9A-HJ-NPQRTUWXY]{18}(?![0-9A-Z])/);
    return match ? match[0] : '';
  }

  /** 提示气泡、图标等不是字段值的元素 */
  const SKIP_VALUE_NODE = /tooltip|popover|popper|help|tip|icon|caret|badge/i;

  /** 值末尾紧贴的按钮 / 操作文案，需要逐层剥离 */
  const VALUE_TAIL = /(复制|查看地图|附近企业|更多|展开|收起|详情|查看)$/;

  /**
   * 清洗取到的原始值。
   * 站点常把「复制」「查看地图」「更多」等按钮文字拼进同一个节点，
   * 也会附带「关联企业 25」「(2025年报)」「（邮编100176）」等说明，统一剔除。
   */
  function cleanValue(raw) {
    let text = normalizeText(raw);
    if (!text) return '';

    // 按钮文字可能连续出现（如「xxx复制更多」），最多剥离三层
    for (let i = 0; i < 3; i += 1) {
      const next = text.replace(VALUE_TAIL, '').trim();
      if (next === text) break;
      text = next;
    }

    text = text
      .replace(/关联企业\s*\d+/g, '') // 企查查：法人姓名后跟「关联企业 25」
      .replace(/[（(]\s*邮编\s*[:：]?\s*\d{5,6}\s*[)）]/g, '') // 地址后的邮编
      .replace(/[（(]\s*(查看地图|地图|更多|详情)\s*[)）]/g, '') // 地址后的操作按钮
      .replace(/[（(]\s*\d{4}\s*年报\s*[)）]/g, '') // 参保人数后的年报年份
      .replace(/信息来源\s*[:：]?[^，,。;；]*/g, '') // 图表下方的数据来源说明
      .replace(/趋势图/g, '')
      .replace(/^企查查行业\s*/, ''); // 企查查行业前缀

    return normalizeText(text);
  }

  /**
   * 判断清洗后的值是否仍是「不是字段值」的内容。
   * 典型来源：筛选下拉项、页脚备案信息、营销引导文案、脱敏占位符。
   */
  function isJunkValue(field, value) {
    if (!value) return true;

    // 清洗后只剩下字段名本身，说明取到的是标签而不是值
    if (ALL_LABEL_TEXTS.has(trimLabel(value))) return true;
    // 全为 * / - / 下划线的脱敏占位，如「****-**-**」
    if (/^[\s*\-—_]+$/.test(value)) return true;
    // 筛选下拉项被当成值：以「全部」开头的枚举串
    if (/^全部[\s\S]+/.test(value)) return true;
    // 页脚备案、邮政编码等站点自身信息
    if (/ICP备|备案号|邮政编码|公网安备/.test(value)) return true;
    // 营销引导文案
    if (/解锁|登录后查看|立即查看|升级会员|快速定位|开通会员/.test(value)) return true;
    // 取到了下一个字段的「标签：值」，说明本字段其实没有值（如工商注册号取到「法定代表人：张奇」）。
    // 跳过本字段自己的别名，避免把「经营范围」值里的「许可经营项目：…」误判成垃圾值。
    const ownAliases = (FIELD_LABELS.find(([name]) => name === field) || [])[1] || [];
    for (const label of ALL_LABEL_TEXTS) {
      if (ownAliases.includes(label)) continue;
      if (value.startsWith(`${label}：`) || value.startsWith(`${label}:`)) return true;
    }

    switch (field) {
      case '统一社会信用代码':
        // 只接受符合 18 位编码规则的值
        return !/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(value.replace(/\s/g, ''));
      case '登记状态':
        return !/存续|在营|在业|开业|注销|吊销|迁出|停业|清算|撤销|设立/.test(value);
      case '成立日期':
      case '核准日期':
        return !/\d{4}\s*[-/年.]\s*\d{1,2}/.test(value);
      case '注册资本':
      case '实缴资本':
        return value.length > 30 || !/\d/.test(value);
      case '纳税人资质':
        // 企查查这里容易取到相邻的序号「1」
        return /^\d{1,3}$/.test(value);
      case '曾用名':
        // 爱企查「曾用名」区块旁边是「历史法定代表人」等信息，不是曾用名
        return /历史|法定代表人|变更记录|主要人员/.test(value);
      case '企业名称':
      case '法定代表人':
        return value.length > 40;
      default:
        return false;
    }
  }

  /** 从标签元素所在容器取值：优先相邻单元格 / 相邻节点，其次父容器的剩余文本 */
  function readValueByLabel(labelEl, label) {
    // 标签位于表格单元格内时，值应在相邻单元格，先跳出单元格再取值
    const cell = labelEl.closest('td,th');
    if (cell && cell.nextElementSibling) {
      const cellText = normalizeText(cell.nextElementSibling.innerText);
      if (cellText && !ALL_LABEL_TEXTS.has(trimLabel(cellText))) return cellText;
    }

    let sibling = labelEl.nextElementSibling;
    while (sibling) {
      // 跳过问号图标、提示气泡等内容，避免把帮助文案当成字段值
      if (SKIP_VALUE_NODE.test(String(sibling.className || ''))) {
        sibling = sibling.nextElementSibling;
        continue;
      }
      const text = normalizeText(sibling.innerText);
      if (text) {
        // 相邻位置又是另一个字段标签时，说明本字段没有值
        return ALL_LABEL_TEXTS.has(trimLabel(text)) ? '' : text;
      }
      sibling = sibling.nextElementSibling;
    }

    const parent = labelEl.parentElement;
    if (!parent) return '';
    // 拼接父容器文本时剔除提示气泡、图标，避免把帮助文案当成字段值
    let parentText = '';
    for (const node of parent.childNodes) {
      if (node.nodeType === 1 && SKIP_VALUE_NODE.test(String(node.className || ''))) continue;
      parentText += node.textContent || '';
    }
    parentText = normalizeText(parentText);
    if (parentText.startsWith(label)) {
      return parentText.slice(label.length).replace(/^[\s:：?？]+/, '').trim();
    }
    return '';
  }

  /** 在标签附近查找 18 位信用代码，避免命中页面上其它企业的编码 */
  function findCreditCodeNearLabel(pageText, label) {
    const index = pageText.indexOf(label);
    if (index < 0) return matchCreditCode(pageText);
    return matchCreditCode(pageText.slice(index, index + 300)) || matchCreditCode(pageText);
  }

  /** 提取详情页的企业信息（仅限 FIELD_LABELS 中定义的字段） */
  function extractDetailInfo() {
    const fields = {};
    const labelIndex = buildLabelIndex();
    const pageText = document.body ? document.body.innerText : '';
    const lines = pageText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // 1) 已知字段优先：别名归一后按标签定位取值
    for (const [field, aliases] of FIELD_LABELS) {
      let value = '';
      // 逐个候选清洗并校验，命中垃圾值就继续试下一个候选，而不是直接采用
      const accept = (candidate) => {
        const cleaned = cleanValue(candidate);
        return cleaned && !isJunkValue(field, cleaned) ? cleaned : '';
      };

      for (const alias of aliases) {
        const candidates = labelIndex.get(alias) || [];
        // 可见元素优先，避免命中隐藏菜单里的同名标签
        const ordered = candidates
          .filter((node) => isVisible(node))
          .concat(candidates.filter((node) => !isVisible(node)));
        for (const labelEl of ordered) {
          value = accept(readValueByLabel(labelEl, alias));
          if (value) break;
        }
        if (value) break;
      }

      // 回退 1：整页文本中「标签：值」写在同一行的情形
      if (!value) {
        for (const alias of aliases) {
          const line = lines.find((item) => trimLabel(item).startsWith(alias));
          if (!line) continue;
          const rest = line.replace(/^.*?[:：]/, '').trim();
          if (rest && rest !== line) {
            value = accept(rest);
            if (value) break;
          }
        }
      }

      // 回退 2：信用代码按 18 位编码规则从标签附近匹配
      if (!value && field === '统一社会信用代码') {
        value = accept(findCreditCodeNearLabel(pageText, '统一社会信用代码'));
      }

      // 回退 3：参保人数常渲染在图表里取不到，按「标签 数字」从整页文本兜底
      if (!value && (field === '参保人数' || field === '分支机构参保人数')) {
        const match = pageText.match(new RegExp(`${field}[\\s:：]*(\\d{1,6})`));
        if (match) value = accept(match[1]);
      }

      if (value && !fields[field]) fields[field] = value;
    }

    // gsxt 把营业期限拆成「营业期限自 / 营业期限至」两个字段，这里合并成一个值
    if (!fields['营业期限']) {
      const readPart = (labelText) => {
        for (const labelEl of labelIndex.get(labelText) || []) {
          const cleaned = cleanValue(readValueByLabel(labelEl, labelText));
          if (cleaned && !isJunkValue('营业期限', cleaned)) return cleaned;
        }
        return '';
      };
      const from = readPart('营业期限自');
      const to = readPart('营业期限至');
      if (from || to) fields['营业期限'] = [from, to].filter(Boolean).join(' 至 ');
    }

    // 信用代码只保留符合 18 位编码规则的值，避免把提示文案当成编码
    const creditCode = fields['统一社会信用代码'];
    if (creditCode && !/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(creditCode.replace(/\s/g, ''))) {
      const fixed = findCreditCodeNearLabel(pageText, '统一社会信用代码');
      if (fixed) {
        fields['统一社会信用代码'] = fixed;
      } else {
        delete fields['统一社会信用代码'];
      }
    }

    return fields;
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
          case 'EXTRACT_INFO': {
            // 先判定页面状态：不在详情页时不提取，避免把结果卡片数据当成详情数据
            const state = detectState(message.name);
            sendResponse({
              ok: true,
              state,
              info: state === 'detail' ? extractDetailInfo() : {},
              url: location.href,
            });
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
