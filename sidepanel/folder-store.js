/**
 * 截图保存目录的句柄持久化。
 *
 * File System Access API 返回的 FileSystemDirectoryHandle 无法用 JSON 序列化，
 * 但支持结构化克隆，因此使用 IndexedDB 保存，重启浏览器后仍可读取。
 */
(() => {
  const DB_NAME = 'gsxt-helper';
  const STORE_NAME = 'handles';
  const KEY = 'screenshot-folder';

  /** 打开（必要时创建）数据库 */
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /** 保存目录句柄 */
  async function saveHandle(handle) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  /** 读取目录句柄，不存在时返回 null */
  async function loadHandle() {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  /** 清除已保存的目录句柄 */
  async function clearHandle() {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }

  window.FolderStore = { saveHandle, loadHandle, clearHandle };
})();
