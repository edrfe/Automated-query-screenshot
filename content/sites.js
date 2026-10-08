/**
 * 多站点适配器配置。
 *
 * 每个站点用一个配置对象描述差异，content.js 保持站点无关：
 *   label            站点全称，用于界面展示
 *   short            站点简称，用于任务列表标签
 *   folder           截图归档的子文件夹名
 *   home             进入站点首页的地址
 *   matchPattern     chrome.tabs.query 用的匹配模式
 *   hosts            主机名关键字，用于按当前地址判断所属站点
 *   searchInput      搜索输入框候选选择器
 *   searchButton     查询按钮候选选择器
 *   searchInputHint  搜索框 placeholder 的兜底识别正则
 *   challenge        验证码容器候选选择器
 *   resultLink       搜索结果条目的候选选择器
 *   emptyHint        无结果的文案识别正则
 *   blockHint        站点拦截页的文案识别正则（命中后直接判定为被拒绝访问）
 *   detailUrlPattern 详情页 URL 特征（优先用它判断是否已进入详情页）
 *   loginUrlPattern  登录页 URL 特征（未登录被重定向时用它判断需要登录）
 *   resultsUrlPattern 结果页 URL 特征（限定结果页地址，避免误判）
 *   allowNonAnchorResult 结果条目不是 <a> 时是否允许按企业名定位可点击元素
 *   detailText       详情页文案特征 { all: [...], any: [...] }
 *   loginDialog      登录弹窗候选选择器
 *
 * 站点改版后，只需在此处补充/调整选择器即可，无需改动 content.js。
 */
window.GSXT_SITES = {
  gsxt: {
    id: 'gsxt',
    label: '国家企业信用信息公示系统',
    short: 'gsxt',
    folder: 'gsxt',
    home: 'https://www.gsxt.gov.cn/index.html',
    matchPattern: 'https://www.gsxt.gov.cn/*',
    hosts: ['gsxt.gov.cn'],
    searchInput: [
      '#keyword',
      '#name',
      'input[name="keyword"]',
      'input[name="name"]',
      '.search-input input',
      '.searchbox input',
      '.search-box input',
      'input[placeholder*="企业名称"]',
    ],
    searchButton: [
      '.bt-chaxun',
      '.search-btn',
      '.btn-search',
      '#btn-search',
      'button[type="submit"]',
      '.searchbox button',
      '.search-box button',
    ],
    searchInputHint: /企业名称|统一社会信用代码|注册号/,
    challenge: [
      '.geetest_panel',
      '.geetest_holder',
      '.geetest_box',
      '#gt_box',
      'div[class*="geetest"]',
    ],
    resultLink: [
      '.search_result .search_list li a',
      '.search-list a',
      '.search-list-item a',
      '.result-list a',
      '#searchList a',
      'ul.list-con a',
      '.list li a',
    ],
    emptyHint: /暂无数据|暂无查询结果|未查询到|无查询结果|没有找到/,
    detailUrlPattern: null,
    detailText: {
      all: ['统一社会信用代码'],
      any: ['注册资本', '成立日期', '企业类型', '法定代表人'],
    },
    loginDialog: [],
  },

  qcc: {
    id: 'qcc',
    label: '企查查',
    short: '企查查',
    folder: '企查查',
    home: 'https://www.qcc.com/',
    matchPattern: 'https://*.qcc.com/*',
    hosts: ['qcc.com'],
    searchInput: [
      'input.qccd-input',
      'input[name="key"]',
      '#searchKey',
      '.search-input input',
      '.index-search input',
      '.searchbox input',
      'input[placeholder*="公司"]',
      'input[placeholder*="企业"]',
    ],
    searchButton: [
      '.search-btn',
      '.btn-search',
      '.index-search-btn',
      '.searchbox button',
      'button[type="submit"]',
    ],
    searchInputHint: /公司名|公司名称|企业名称|企业名|请输入.*名称|请输入.*企业/,
    challenge: [
      '#nc_1_wrapper',
      '.nc-container',
      '[class*="geetest"]',
      '[class*="captcha"]',
      '[id*="captcha"]',
      '[class*="sliderVerify"]',
      '[class*="verify-box"]',
    ],
    resultLink: [
      'a.title.copy-value',
      '.copy-title a',
      '.main-search-result a.title',
      '.search-result-list .list-item a.title',
      '.search-list .title a',
      '#search-result a',
      '.result-list a',
    ],
    emptyHint: /暂无数据|暂无结果|未查询到|没有找到|无相关结果/,
    // 企查查详情页地址固定为 /firm/xxx.html，用它判断最稳妥
    detailUrlPattern: /qcc\.com\/firm\/[0-9a-zA-Z]+\.html/,
    // 未登录时会被送到登录页
    loginUrlPattern: /qcc\.com\/user_login/,
    // 结果页地址特征，避免把其他页面里含企业名的链接误判为结果
    resultsUrlPattern: /qcc\.com\/(web\/)?search/,
    detailText: null,
    loginDialog: [
      '[class*="login-dialog"]',
      '[class*="loginDialog"]',
      '[class*="login-modal"]',
      '[class*="loginModal"]',
      '[class*="dialog"][class*="login"]',
    ],
  },

  aiqicha: {
    id: 'aiqicha',
    label: '爱企查',
    short: '爱企查',
    folder: '爱企查',
    home: 'https://aiqicha.baidu.com/',
    matchPattern: 'https://aiqicha.baidu.com/*',
    hosts: ['aiqicha.baidu.com'],
    searchInput: [
      '#aqc-header-search-input',
      '#search-input',
      'input[name="q"]',
      '.search-input input',
      '.searchbox input',
      'input[placeholder*="企业"]',
      'input[placeholder*="公司"]',
    ],
    searchButton: [
      '.search-btn',
      '.btn-search',
      '#search-btn',
      '.search-input-btn',
      'button[type="submit"]',
    ],
    searchInputHint: /企业名称|公司名|请输入.*名称/,
    challenge: [
      '[class*="passMod"]',
      '[class*="geetest"]',
      '[class*="captcha"]',
      '[id*="captcha"]',
      '[class*="passVerify"]',
      '[class*="vcode"]',
    ],
    resultLink: [
      '.result-list .title a',
      '.search-result a',
      '.list-item a',
      '#result-list a',
    ],
    emptyHint: /暂无数据|暂无结果|未查询到|没有找到|无相关结果/,
    // 爱企查检测到浏览器处于调试状态时会直接返回拦截页
    blockHint: /请关闭浏览器的调试窗口/,
    // 爱企查详情页地址固定为 /company_detail_xxx
    detailUrlPattern: /aiqicha\.baidu\.com\/company_detail_/,
    // 爱企查的搜索结果必须登录才展示，未登录会跳到 /login?u=...
    loginUrlPattern: /aiqicha\.baidu\.com\/(login|passport)/,
    // 搜索结果页地址为 /s?q=xxx，登录后站点可能落到资讯页，靠地址限定更稳妥
    resultsUrlPattern: /aiqicha\.baidu\.com\/s(\?|$)/,
    // 爱企查是 Vue SPA，结果条目可能不是 <a>，允许按企业名定位可点击元素
    allowNonAnchorResult: true,
    detailText: null,
    loginDialog: [
      '[class*="passMod"]',
      '[class*="login-dialog"]',
      '[class*="loginDialog"]',
      '[class*="login-modal"]',
    ],
  },
};

/** 站点展示与执行顺序 */
window.GSXT_SITE_ORDER = ['gsxt', 'qcc', 'aiqicha'];

/**
 * 依据当前页面地址判断所属站点
 * @param {string} href 页面地址
 * @returns {object|null} 站点配置
 */
window.GSXT_MATCH_SITE = function matchSite(href) {
  let hostname = '';
  try {
    hostname = new URL(href).hostname;
  } catch (error) {
    return null;
  }
  for (const id of window.GSXT_SITE_ORDER) {
    const site = window.GSXT_SITES[id];
    if (site.hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      return site;
    }
  }
  return null;
};
