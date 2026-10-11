window.VC = window.VC || {};
VC.runtime = { videos: {}, images: {} };

// 永続化：動画・画像の中身は IndexedDB、プロジェクト（複数）は localStorage
VC.store = {
  DB: "reelcut-db",
  PROJS: "reelcut:projects",
  CUR: "reelcut:current",
  LEGACY: "reelcut:project",
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
      const req = fn(t.objectStore("blobs"));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  },
  putBlob(key, blob) { return this.tx("readwrite", (st) => st.put(blob, key)); },
  getBlob(key) { return this.tx("readonly", (st) => st.get(key)); },
  delBlob(key) { return this.tx("readwrite", (st) => st.delete(key)); },
  clearBlobs() { return this.tx("readwrite", (st) => st.clear()); },

  uid(prefix) { return (prefix || "x") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },

  loadAll() {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(this.PROJS)) || {}; } catch (e) { all = {}; }
    // 旧形式（単一プロジェクト）からの移行
    const legacy = localStorage.getItem(this.LEGACY);
    if (legacy && !Object.keys(all).length) {
      try {
        const p = JSON.parse(legacy);
        p.id = this.uid("p"); p.name = p.name || "動画 1"; p.created_at = new Date().toISOString();
        all[p.id] = p;
        localStorage.setItem(this.PROJS, JSON.stringify(all));
        localStorage.setItem(this.CUR, p.id);
      } catch (e) { /* ignore */ }
      localStorage.removeItem(this.LEGACY);
    }
    return all;
  },
  list() { return Object.values(this.loadAll()).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")); },
  getProject(id) { return this.loadAll()[id] || null; },
  saveProject(p) {
    const all = this.loadAll();
    all[p.id] = p;
    localStorage.setItem(this.PROJS, JSON.stringify(all));
  },
  deleteProject(id) {
    const all = this.loadAll();
    delete all[id];
    localStorage.setItem(this.PROJS, JSON.stringify(all));
    if (this.getCurrentId() === id) localStorage.removeItem(this.CUR);
  },
  getCurrentId() { return localStorage.getItem(this.CUR) || null; },
  setCurrentId(id) { if (id) localStorage.setItem(this.CUR, id); else localStorage.removeItem(this.CUR); },
  newShell(name) { return { id: this.uid("p"), name: name || `動画 ${this.list().length + 1}`, created_at: new Date().toISOString() }; },
  getCurrentProject() {
    const all = this.loadAll();
    const id = this.getCurrentId();
    if (id && all[id]) return all[id];
    const first = this.list()[0];
    if (first) { this.setCurrentId(first.id); return first; }
    const shell = this.newShell("動画 1");
    this.saveProject(shell);
    this.setCurrentId(shell.id);
    return shell;
  },
  clearAll() {
    localStorage.removeItem(this.PROJS);
    localStorage.removeItem(this.CUR);
    localStorage.removeItem(this.LEGACY);
    return this.clearBlobs();
  },
};
