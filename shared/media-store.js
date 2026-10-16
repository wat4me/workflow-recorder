/** Shared IndexedDB storage for step screenshots. */
(function () {
  if (globalThis.RecorderMediaStore) return;

  const DB_NAME = "PlaywrightRecorderDB";
  const STORE_NAME = "blobs";
  const THUMBNAIL_STORE = "thumbnails";
  const MEDIA_LOCK = "workflow-recorder-media-publication";

  // Shared across extension pages and the worker. Keep newly written blobs safe
  // until their chrome.storage references have been published. Cleanup never
  // waits for a writer: a case deletion can itself be ahead of an import on the
  // case queue, so waiting here would deadlock that queue.
  function withWriteLock(callback) {
    return navigator.locks.request(MEDIA_LOCK, { mode: "shared" }, callback);
  }

  function withCleanupLock(callback) {
    return navigator.locks.request(MEDIA_LOCK, { ifAvailable: true }, lock =>
      lock ? callback() : { deletedCount: 0, pending: true, skipped: true }
    );
  }

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        if (!db.objectStoreNames.contains(THUMBNAIL_STORE)) db.createObjectStore(THUMBNAIL_STORE);
      };
      request.onsuccess = event => {
        const db = event.target.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = event => reject(event.target.error);
    });
  }

  async function getBlob(key, store = STORE_NAME) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(store, "readonly").objectStore(store).get(key);
        request.onsuccess = event => resolve(event.target.result || null);
        request.onerror = event => reject(event.target.error);
      });
    } finally {
      db.close();
    }
  }

  async function putBlob(key, blob, store = STORE_NAME) {
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        transaction.oncomplete = resolve;
        transaction.onerror = event => reject(event.target.error);
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
        transaction.objectStore(store).put(blob, key);
      });
    } finally {
      db.close();
    }
  }

  async function getAllKeys() {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAllKeys();
        request.onsuccess = event => resolve(event.target.result || []);
        request.onerror = event => reject(event.target.error);
      });
    } finally {
      db.close();
    }
  }

  async function deleteBlob(key) {
    if (!key) return;
    await deleteBlobs([key]);
  }

  async function deleteBlobs(keys) {
    const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
    if (uniqueKeys.length === 0) return;
    const db = await open();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME, THUMBNAIL_STORE], "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const thumbnails = transaction.objectStore(THUMBNAIL_STORE);
        uniqueKeys.forEach(key => { store.delete(key); thumbnails.delete(key); });
        transaction.oncomplete = resolve;
        transaction.onerror = event => reject(event.target.error);
        transaction.onabort = event => reject(event.target.error || new Error("IndexedDB transaction aborted"));
      });
    } finally {
      db.close();
    }
  }

  globalThis.RecorderMediaStore = {
    deleteBlob, deleteBlobs, getAllKeys, getBlob, putBlob, withWriteLock, withCleanupLock,
    getThumbnail: key => getBlob(key, THUMBNAIL_STORE),
    putThumbnail: (key, blob) => putBlob(key, blob, THUMBNAIL_STORE)
  };
})();
