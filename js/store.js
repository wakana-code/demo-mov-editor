window.VC = window.VC || {};
// ランタイム（動画・画像の要素）。保存はしない
VC.runtime = { videos: {}, images: {} };

// 永続化：動画・画像の中身は IndexedDB、プロジェクト設定は localStorage
VC.store = {
  DB: "reelcut-db",
  PROJ: "reelcut:project",
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(this.DB, 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs"); };
      r.onsuccess = () => { this._db = r.result; res(this._db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction("blobs", mode);
      const st = t.objectStore("blobs");
      const req = fn(st);
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  putBlob(key, blob) { return this.tx("readwrite", (st) => st.put(blob, key)); },
  getBlob(key) { return this.tx("readonly", (st) => st.get(key)); },
  delBlob(key) { return this.tx("readwrite", (st) => st.delete(key)); },
  clearBlobs() { return this.tx("readwrite", (st) => st.clear()); },

  loadProject() {
    try { return JSON.parse(localStorage.getItem(this.PROJ)); } catch (e) { return null; }
  },
  saveProject(p) {
    localStorage.setItem(this.PROJ, JSON.stringify(p));
  },
  clearProject() { localStorage.removeItem(this.PROJ); },

  uid(prefix) { return (prefix || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },
};
