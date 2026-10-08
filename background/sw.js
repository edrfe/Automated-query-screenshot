/**
 * 后台 Service Worker。
 *
 * 仅承担轻量职责：
 * 1. 点击扩展图标时打开侧边栏；
 * 2. 首次安装时初始化默认配置。
 *
 * 说明：Manifest V3 的 Service Worker 会在空闲约 30 秒后被回收，
 * 因此批量任务的编排逻辑放在常驻的侧边栏页面（sidepanel/panel.js）中执行。
 */

/** 默认配置项 */
const DEFAULT_CONFIG = {
  folder: '企业截图', // 未指定自定义目录时，下载目录下的子文件夹名
  minDelayMs: 3000, // 相邻两条任务之间的最小间隔（毫秒）
  maxDelayMs: 8000, // 相邻两条任务之间的最大间隔（毫秒）
};

// 点击扩展图标时直接打开侧边栏
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('[gsxt-helper] 设置侧边栏行为失败：', error));

// 安装时写入默认配置
chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get('gsxt.config');
  if (!saved['gsxt.config']) {
    await chrome.storage.local.set({ 'gsxt.config': DEFAULT_CONFIG });
  }
});
