// ─── storage.js ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'qa_recorder_state';

const Storage = {
  async save(state) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state }, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  },

  async load() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(result[STORAGE_KEY] ?? null);
      });
    });
  },

  async clear() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(STORAGE_KEY, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  },

  async get(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(result);
      });
    });
  },

  async set(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    });
  }
};
