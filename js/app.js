(function () {
  const { store, runtime } = VC;
  runtime.missing = runtime.missing || {};
  const TL = VC.timeline, R = VC.render, INS = VC.inserts;
  const $ = (id) => document.getElementById(id);
  const canvas = $("preview");
  const ctx = canvas.getContext("2d");
  const SIZES = [
    { k: "1920x1080", w: 1920, h: 1080, label: "1920×1080（横・推奨）" },
    { k: "1280x720", w: 1280, h: 720, label: "1280×720（横・軽い）" },
    { k: "1080x1080", w: 1080, h: 1080, label: "1080×1080（正方形）" },
    { k: "1080x1920", w: 1080, h: 1920, label: "1080×1920（縦）" },
  ];
  const CAP_COLORS = ["#facc15", "#4ade80", "#38bdf8", "#f472b6", "#fb923c", "#a78bfa"];
  const SPEEDS = [1.5, 2, 3, 4, 8, 16];
  const FX_LABEL = { default: "既定", whip: "ウィップ", zoom: "パンチズーム", glitch: "グリッチ", none: "シームレス" };
  function cutFxLabel(r) { const f = r.fx && r.fx !== "default" ? r.fx : P.cutFx.type; return FX_LABEL[f] || f; }

  // ---------- state ----------
  let P = normalizeProject(store.getCurrentProject());
  const S = {
    T: 0, playing: false, tab: "opening", active: null, lastTick: 0,
    drag: null, scrubSrc: null, pop: null, selectedRange: null,
    exporting: false, cancelExport: false, lastDown: 0, lastDownX: 0, mp4ok: null,
    picker: false,
    mode: "project", modeIns: null,        // project | insert（埋め込み単体をメイン画面でプレビュー）
    place: null, placeAt: null,
    fileTarget: { kind: "clip" },
    imgTarget: { kind: "opening" },
    fs: null,                              // 全画面スライドエディタ
    persisted: false, storage: null,
    passed: new Set(), stall: 0,           // 再生中に通過した埋め込み／読み込み待ちの累積
    copyIns: null,                         // 「⧉ コピー」でコピー先を選んでいる埋め込み
    mergeIns: null,                        // 「🔗 結合」で結合元を選んでいる埋め込み
    pullProj: null,                        // 「📥 取り込む」で選んでいるプロジェクト
  };

  function normalizeProject(saved) {
    saved = saved || {};
    const p = {
      id: saved.id || store.uid("p"),
      name: saved.name || "動画",
      created_at: saved.created_at || new Date().toISOString(),
      opening: Object.assign(VC.opening.defaults(), saved.opening || {}),
      ending: Object.assign(VC.ending.defaults(), saved.ending || {}),
      clips: Array.isArray(saved.clips) ? saved.clips : [],
      ranges: Array.isArray(saved.ranges) ? saved.ranges : [],
      inserts: (Array.isArray(saved.inserts) ? saved.inserts : []).map((x) => INS.normalize(x)).filter(Boolean),
      output: Object.assign({ size: "1920x1080", fps: 30, name: "demo", sting: 0.1 }, saved.output || {}),
      cutFx: Object.assign({ type: "whip", dur: 0.3 }, saved.cutFx || {}),
      style: VC.styles.get(saved.style).id,
    };
    p.colors = Object.assign(VC.styles.defaultColors(p.style), saved.colors || {});
    p.body = saved.body === "slides" ? "slides" : "clips";
    if (p.body === "slides" && !p.inserts.some((x) => x.main)) {
      const md = INS.newDeck(); md.main = true; md.name = "本編スライド";
      p.inserts.push(md);
    }
    if (!Array.isArray(p.opening.images)) p.opening.images = [];
    if (!Array.isArray(p.opening.sentences)) p.opening.sentences = VC.opening.defaults().sentences;
    return p;
  }
  let saveTimer = null;
  function save() {
    $("save-badge").textContent = "保存中…"; $("save-badge").classList.add("dirty");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 250);
  }
  function flushSave() {
    clearTimeout(saveTimer);
    store.saveProject(P);
    $("save-badge").textContent = "保存済み"; $("save-badge").classList.remove("dirty");
    renderProjTabs();
  }
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function val(id) { const el = $(id); return el ? el.value : ""; }
  function sizeOf() { return SIZES.find((s) => s.k === P.output.size) || SIZES[0]; }
  function applyCanvasSize() {
    const sz = sizeOf();
    if (canvas.width !== sz.w || canvas.height !== sz.h) { canvas.width = sz.w; canvas.height = sz.h; }
    const wrap = $("canvas-wrap");
    wrap.classList.toggle("v", sz.h > sz.w);
    wrap.classList.toggle("sq", sz.h === sz.w);
  }
  function deckById(id) { return P.inserts.find((x) => x.id === id) || null; }
  function isSlides() { return P.body === "slides"; }
  function mainDeck() { return P.inserts.find((x) => x.main) || null; }
  function ensureMainDeck() {
    let md = mainDeck();
    if (!md) { md = INS.newDeck(); md.main = true; md.name = "本編スライド"; P.inserts.push(md); save(); }
    return md;
  }
  function pageTitle(p) {
    if (p.kind === "montage") return "🎞";
    const lines = INS.parseHtml(p.html);
    const t = lines.map((l) => l.map((r) => r.text).join("")).join(" ").trim();
    return t ? t.slice(0, 18) : p.video ? `🎥 ${p.video.name}` : p.images.length ? "🖼 画像" : "（空）";
  }
  function setBody(kind) {
    if (kind === P.body) return;
    P.body = kind;
    if (kind === "slides") ensureMainDeck();
    S.T = 0; S.active = null; R.snaps = {};
    save();
    renderPanel(); renderTimeline(); renderModeBar(); setT(0, { pause: true });
    toast(kind === "slides" ? "本編を「スライドだけ」にしました。「⛶ 本編スライドを編集」からページを作ってください" : "本編を「画面収録」にしました");
  }

  // ---------- project tabs ----------
  function renderProjTabs() {
    const list = store.list();
    $("proj-tabs").innerHTML = list.map((p) =>
      `<div class="proj-tab ${p.id === P.id ? "active" : ""}" data-action="proj-switch" data-id="${p.id}" title="クリックで切替／ダブルクリックで名前変更"><span class="n">${esc(p.name || "動画")}</span><button class="x" data-action="proj-close" data-id="${p.id}" title="このプロジェクトを削除">✕</button></div>`
    ).join("") + `<div class="proj-tab add" data-action="proj-new" title="新しい動画をまっさらから始める">＋ 新規</div>`;
  }
  async function switchProject(id) {
    if (id === P.id) return;
    const next = store.getProject(id);
    if (!next) return;
    pause();
    flushSave();
    if (S.fs) closeFs(true);
    if (S.pop) closePopover();
    S.mode = "project"; S.modeIns = null; S.place = null;
    P = normalizeProject(next);
    store.setCurrentId(P.id);
    S.T = 0; S.active = null; S.scrubSrc = null; S.selectedRange = null;
    VC.opening._cache = null; R.snaps = {};
    applyCanvasSize();
    renderProjTabs(); renderTimeline(); renderModeBar(); renderPanel();
    await restoreMedia();
    setTab(P.clips.length ? "clips" : "opening");
    renderTimeline(); setT(0, { pause: true });
  }
  async function newProject() {
    flushSave();
    const p = normalizeProject(store.newShell());
    store.saveProject(p);
    await switchProject(p.id);
    toast(`「${p.name}」を作成しました（ダブルクリックで名前変更）`);
    openPicker();
  }
  function allVideoRefs(p) {
    const out = (p.clips || []).slice();
    for (const ins of p.inserts || []) out.push(...INS.videoRefs(ins));
    return out;
  }
  function allMediaIds(p) {
    const ids = allVideoRefs(p).map((v) => v.id);
    for (const im of (p.opening && p.opening.images) || []) ids.push(im.id);
    for (const ins of p.inserts || []) for (const im of INS.imageRefs(ins)) ids.push(im.id);
    return [...new Set(ids)];
  }

  // ---------- プロジェクト丸ごと保存／読み込み ----------
  async function exportProjectFile() {
    flushSave();
    toast("プロジェクトファイルを作成中…");
    try {
      const r = await store.exportBundle(P, allMediaIds(P));
      const name = (P.name || "project").replace(/[\\/:*?"<>|]+/g, "_");
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${name}.rcpk`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`保存しました（メディア ${r.count}件・${(r.blob.size / 1048576).toFixed(0)}MB）${r.missing ? `　⚠ ${r.missing}件は読み込めないため含まれていません` : ""}`);
    } catch (e) { toast(`保存に失敗：${e.message}`); }
  }
  async function importProjectFile(file) {
    toast("読み込み中…（メディアをブラウザ内にコピーしています）");
    try {
      const proj = await store.importBundle(file);
      const p = normalizeProject(proj);
      p.id = store.uid("p");
      p.name = (p.name || "動画") + "（読込）";
      p.created_at = new Date().toISOString();
      store.saveProject(p);
      await switchProject(p.id);
      S.storage = await store.estimate();
      toast(`「${p.name}」を読み込みました`);
    } catch (e) { toast(`読み込みに失敗：${e.message}`); }
  }

  // ---------- ストレージ保護の状態 ----------
  function renderStorageBanner() {
    const el = $("storage-banner");
    if (!el) return;
    if (S.persisted) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    const est = S.storage;
    const freeGB = est && est.quota ? ((est.quota - (est.usage || 0)) / 1073741824).toFixed(1) : null;
    el.classList.remove("hidden");
    el.innerHTML = `
      <div><b>⚠ このサイトの保存データはブラウザに消される可能性があります</b>（保護なし${freeGB != null ? `・ブラウザが使える残り約 ${freeGB}GB` : ""}）。Chromeは空き容量が減ると、保護のないサイトの動画・画像を丸ごと削除します。</div>
      <ol>
        <li><b>アプリとしてインストール</b>：アドレスバー右端の「⊕ インストール」（または Chromeメニュー →「ReelCut をインストール」）→ 保護が自動で付きます</li>
        <li>それが無ければ <b>このページをブックマーク</b>（⌘D）して開き直す</li>
        <li>Macの空き容量を増やす（画面収録の元ファイルを整理）</li>
        <li>念のため「⬇ 書き出し」タブの <b>💾 プロジェクトを丸ごと保存</b> でファイルにしておく</li>
      </ol>
      <span class="spacer"></span>
      <button class="btn btn-sm" data-action="storage-recheck">↻ 状態を再確認</button>
      <button class="btn btn-sm btn-primary" data-action="export-project">💾 丸ごと保存</button>`;
  }
  async function closeProject(id) {
    const p = store.getProject(id);
    if (!p) return;
    if (!confirm(`「${p.name}」を削除しますか？（クリップ・画像・設定が消えます）`)) return;
    for (const c of allVideoRefs(p)) { delete runtime.videos[c.id]; store.delBlob(c.id); }
    for (const im of (p.opening && p.opening.images) || []) { delete runtime.images[im.id]; store.delBlob(im.id); }
    for (const ins of p.inserts || []) for (const im of INS.imageRefs(ins)) { delete runtime.images[im.id]; store.delBlob(im.id); }
    store.deleteProject(id);
    if (id === P.id) {
      const rest = store.list();
      if (rest.length) { P = { id: null }; await switchProject(rest[0].id); }
      else { P = normalizeProject(store.newShell("動画 1")); store.saveProject(P); store.setCurrentId(P.id); S.T = 0; S.active = null; S.mode = "project"; renderProjTabs(); renderTimeline(); renderModeBar(); setTab("opening"); setT(0, { pause: true }); }
    } else renderProjTabs();
    toast("削除しました");
  }
  function renameProject(id) {
    const p = id === P.id ? P : store.getProject(id);
    if (!p) return;
    const name = prompt("プロジェクト名", p.name || "");
    if (name == null || !name.trim()) return;
    p.name = name.trim().slice(0, 40);
    if (id === P.id) save(); else store.saveProject(p);
    renderProjTabs();
  }

  // ---------- media ----------
  function loadVideoEl(blob, id) {
    return new Promise((res, rej) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      let done = false;
      const ok = () => { if (done) return; done = true; clearTimeout(tm); v.onerror = null; if (id) watchVideo(v, id); res(v); };
      const fail = (msg) => { if (done) return; done = true; clearTimeout(tm); try { URL.revokeObjectURL(v.src); } catch (e) {} rej(new Error(msg)); };
      const tm = setTimeout(() => fail("読み込みがタイムアウトしました（ファイルが大きい／多すぎる可能性）。「↻ 再読み込み」を試してください"), 20000);
      v.onerror = () => fail("この動画はブラウザで再生できません（HEVC収録の可能性）。QuickTimeで「書き出す → 1080p」してから追加してください");
      v.onloadedmetadata = () => {
        if (!isFinite(v.duration) || v.duration === 0) {
          const onDur = () => { if (isFinite(v.duration) && v.duration > 0) { v.removeEventListener("durationchange", onDur); v.currentTime = 0; ok(); } };
          v.addEventListener("durationchange", onDur);
          v.currentTime = 1e8;
        } else ok();
      };
      v.src = URL.createObjectURL(blob);
    });
  }
  // 再生中にエラーが起きたら、保存データから自動で読み直す（1回）
  function watchVideo(v, id) {
    v.addEventListener("error", async () => {
      if (runtime.videos[id] !== v) return;
      console.warn("video error → reload", id);
      try {
        const b = await store.getBlob(id);
        if (!b) throw new Error("保存データが見つかりません");
        runtime.videos[id] = await loadVideoEl(b, id);
        delete runtime.missing[id];
      } catch (e) {
        runtime.missing[id] = { kind: "video", name: refName(id), error: "再生中にエラー：" + e.message };
      }
    });
  }
  function findVideoRefs(id) {
    const out = P.clips.filter((c) => c.id === id);
    for (const d of P.inserts) for (const pg of d.pages) if (pg.video && pg.video.id === id) out.push(pg.video);
    return out;
  }
  function findImageRefs(id) {
    const out = P.opening.images.filter((im) => im.id === id);
    for (const d of P.inserts) for (const pg of d.pages) for (const im of pg.images) if (im.id === id) out.push(im);
    return out;
  }
  function refName(id) { const r = findVideoRefs(id)[0] || findImageRefs(id)[0]; return r ? r.name : id; }
  function loadImageEl(blob) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("画像を読み込めません"));
      img.src = URL.createObjectURL(blob);
    });
  }
  // 復元：読めなかったものは絶対に削除せず「⚠ 読み込めない」として記録する（再読み込み／選び直しで復旧できる）
  async function restoreMedia() {
    const loadRef = async (c) => {
      if (runtime.videos[c.id]) { delete runtime.missing[c.id]; return true; }
      try {
        const b = await store.getBlob(c.id);
        if (!b) throw new Error("保存データが見つかりません（ブラウザに消された可能性）");
        const v = await loadVideoEl(b, c.id);
        runtime.videos[c.id] = v;
        if (isFinite(v.duration) && v.duration > 0) c.duration = v.duration;
        c.width = v.videoWidth; c.height = v.videoHeight;
        delete runtime.missing[c.id];
        return true;
      } catch (e) { console.warn(e); runtime.missing[c.id] = { kind: "video", name: c.name, error: e.message }; return false; }
    };
    const loadImg = async (im) => {
      if (runtime.images[im.id]) { delete runtime.missing[im.id]; return true; }
      try {
        const b = await store.getBlob(im.id);
        if (!b) throw new Error("保存データが見つかりません");
        runtime.images[im.id] = await loadImageEl(b);
        delete runtime.missing[im.id];
        return true;
      } catch (e) { console.warn(e); runtime.missing[im.id] = { kind: "image", name: im.name, error: e.message }; return false; }
    };
    for (const c of P.clips) await loadRef(c);
    for (const deck of P.inserts) for (const pg of deck.pages) { if (pg.video) await loadRef(pg.video); for (const im of pg.images) await loadImg(im); }
    for (const im of P.opening.images) await loadImg(im);
    const n = Object.keys(runtime.missing).length;
    if (n) toast(`⚠ ${n}件のメディアを読み込めませんでした。「📦 メディアの状態」から再読み込み／選び直しができます`);
  }
  async function importVideoFiles(files) {
    files = [...files].filter((f) => /video|\.mov$|\.mp4$|\.webm$|\.m4v$/i.test(f.type + f.name));
    const out = [];
    for (const f of files) {
      try {
        const id = store.uid("v");
        const stored = await store.putFile(id, f);          // 中身をコピーして保存（元ファイルを消しても大丈夫）
        let v;
        try { v = await loadVideoEl(stored, id); } catch (e) { store.delBlob(id); throw e; }
        runtime.videos[id] = v;
        out.push({ id, name: f.name.replace(/\.[^.]+$/, ""), duration: v.duration, width: v.videoWidth, height: v.videoHeight, start: 0, end: null });
      } catch (e) { toast(`${f.name}: ${e.message}`); }
    }
    return out;
  }
  // target: {kind:"clip"} | {kind:"page", deckId, pageId} | {kind:"montage-new", deckId} | {kind:"montage-add", deckId, gid}
  async function addVideoFiles(files, target) {
    target = target || { kind: "clip" };
    if (target.kind === "reattach") {
      const f = [...files][0];
      if (!f) return;
      try {
        const stored = await store.putFile(target.id, f);
        const v = await loadVideoEl(stored, target.id);
        runtime.videos[target.id] = v;
        delete runtime.missing[target.id];
        for (const r of findVideoRefs(target.id)) { r.duration = v.duration; r.width = v.videoWidth; r.height = v.videoHeight; }
        R.snaps = {};
        save(); renderPanel(); renderTimeline(); if (S.fs) renderFs();
        toast("動画を選び直しました");
      } catch (e) { toast(`選び直しに失敗：${e.message}`); }
      return;
    }
    const list = await importVideoFiles(files);
    if (!list.length) { toast("動画ファイルを選んでください"); return; }
    if (target.kind === "clip") {
      P.clips.push(...list);
      save(); toast(`${list.length}本のクリップを追加しました`);
      if (S.tab !== "clips") setTab("clips"); else renderPanel();
      renderTimeline();
      return;
    }
    const deck = deckById(target.deckId);
    if (!deck) return;
    if (target.kind === "page") {
      const pg = deck.pages.find((x) => x.id === target.pageId);
      if (!pg) return;
      if (pg.video) { delete runtime.videos[pg.video.id]; store.delBlob(pg.video.id); }
      pg.video = list[0]; pg.ranges = [];
      toast(`ページに「${list[0].name}」を載せました`);
    } else if (target.kind === "montage-new") {
      const gid = store.uid("g");
      deck.groups[gid] = INS.newGroup();
      const cur = S.fs ? deck.pages.findIndex((x) => x.id === S.fs.pageId) : deck.pages.length - 1;
      const pages = list.map((v) => Object.assign(INS.newPage("montage"), { video: v, group: gid }));
      deck.pages.splice(cur + 1, 0, ...pages);
      if (S.fs) S.fs.pageId = pages[0].id;
      toast(`モンタージュ（${list.length}本）を追加しました`);
    } else if (target.kind === "montage-add") {
      const idx = deck.pages.map((x, i) => (x.group === target.gid ? i : -1)).filter((i) => i >= 0).pop();
      const pages = list.map((v) => Object.assign(INS.newPage("montage"), { video: v, group: target.gid }));
      deck.pages.splice((idx == null ? deck.pages.length - 1 : idx) + 1, 0, ...pages);
      toast(`モンタージュに${list.length}本追加しました`);
    }
    R.snaps = {};
    save();
    if (S.fs) renderFs(); else renderPanel();
    renderTimeline();
  }
  async function addImageFiles(files, target) {
    target = target || { kind: "opening" };
    files = [...files].filter((f) => /^image\//.test(f.type));
    if (!files.length) { toast("画像ファイルを選んでください"); return; }
    if (target.kind === "reattach") {
      try {
        const stored = await store.putFile(target.id, files[0]);
        runtime.images[target.id] = await loadImageEl(stored);
        delete runtime.missing[target.id];
        VC.opening._cache = null;
        save(); renderPanel(); if (S.fs) renderFs();
        toast("画像を選び直しました");
      } catch (e) { toast(`選び直しに失敗：${e.message}`); }
      return;
    }
    const loaded = [];
    for (const f of files) {
      try {
        const id = store.uid("i");
        const stored = await store.putFile(id, f);
        try { runtime.images[id] = await loadImageEl(stored); } catch (e) { store.delBlob(id); throw e; }
        loaded.push({ id, name: f.name || "pasted" });
      } catch (e) { toast(e.message); }
    }
    if (!loaded.length) return;
    if (target.kind === "page") {
      const deck = deckById(target.deckId);
      const pg = deck ? deck.pages.find((x) => x.id === target.pageId) : null;
      if (!pg) { for (const l of loaded) { delete runtime.images[l.id]; store.delBlob(l.id); } return; }
      const sz = sizeOf();
      for (const l of loaded) {
        const img = runtime.images[l.id];
        const im = INS.newImage(l.id, l.name, img.naturalWidth, img.naturalHeight, sz.w, sz.h);
        im.x += (pg.images.length % 5) * 0.03; im.y += (pg.images.length % 5) * 0.03;
        pg.images.push(im);
      }
      save();
      if (S.fs) { S.fs.selImg = loaded[loaded.length - 1].id; S.fs.crop = false; renderFs(); }
      toast(`ページに画像を${loaded.length}枚追加しました`);
      return;
    }
    P.opening.images.push(...loaded);
    VC.opening._cache = null;
    save(); renderPanel();
    toast(`画像を${loaded.length}枚追加しました`);
  }
  function imageTarget() {
    if (S.fs) { const pg = fsPage(); if (pg) return { kind: "page", deckId: S.fs.deckId, pageId: pg.id }; }
    return { kind: "opening" };
  }

  // ---------- mode / context（メイン画面） ----------
  function modeIns() { return S.mode === "insert" ? deckById(S.modeIns) : null; }
  function ctxClips() {
    if (S.fs) { const pg = fsPage(); return pg && pg.video ? [pg.video] : []; }
    if (S.mode === "insert") return [];
    return P.clips;
  }
  function ctxRanges() {
    if (S.fs) { const pg = fsPage(); return pg && pg.kind !== "montage" ? pg.ranges : []; }
    if (S.mode === "insert") return [];
    return P.ranges;
  }
  function tlPre() { return S.fs ? "fstl" : "tl"; }
  function insertInfo(deck) { const d = INS.duration(deck); return { stingDur: 0, openDur: 0, opDur: 0, segs: [], outDur: 0, insLayout: [], mainDur: d, edDur: 0, total: d, srcTotal: 0 }; }
  function info() {
    if (S.fs) { const pg = fsPage(); return pg ? R.pageInfo(pg) : R.emptyInfo(); }
    if (S.mode === "insert") { const d = modeIns(); return d ? insertInfo(d) : R.emptyInfo(); }
    return R.info(P);
  }
  function locate(T, inf) {
    inf = inf || info();
    if (S.mode === "insert") return { phase: "insert", ins: modeIns(), local: T, info: inf };
    return R.locate(P, T, inf);
  }
  function enterMode(mode, insId) {
    pause();
    if (S.pop) closePopover();
    S.mode = mode; S.modeIns = insId || null;
    S.T = 0; S.scrubSrc = null; S.active = null;
    renderTimeline(); renderModeBar(); setT(0, { pause: true });
  }
  function exitMode() {
    if (S.mode === "project") return;
    pause();
    if (S.pop) closePopover();
    S.mode = "project"; S.modeIns = null; S.active = null;
    renderTimeline(); renderModeBar(); renderPanel(); setT(0, { pause: true });
  }
  function renderModeBar() {
    const bar = $("place-bar");
    const hint = $("tl-hint");
    if (S.place) {
      const d = deckById(S.place);
      bar.classList.remove("hidden");
      bar.innerHTML = `<b>📍 配置：${esc(d ? INS.label(d) : "")}</b><span>再生バーをクリックして位置を決めてください${S.placeAt != null ? `　→ <b>元 ${TL.fmtMs(S.placeAt)}</b> の直前に挿入` : ""}</span><span class="spacer"></span><button class="btn btn-sm" data-action="place-end">最後に</button><button class="btn btn-sm btn-primary" data-action="place-ok" ${S.placeAt == null ? "disabled" : ""}>✓ 決定</button><button class="btn btn-sm" data-action="place-cancel">キャンセル</button>`;
      hint.innerHTML = `配置モード：クリックした位置の<b>直前</b>に埋め込まれます（本編は後ろにずれます）`;
      return;
    }
    if (S.mode === "insert") {
      const d = modeIns();
      bar.classList.remove("hidden");
      bar.innerHTML = `<b>▶ 埋め込みをプレビュー中</b><span>${esc(d ? INS.label(d) : "")}</span><span class="spacer"></span><button class="btn btn-sm" data-action="ins-open" data-id="${d ? d.id : ""}">⛶ 編集</button><button class="btn btn-sm btn-primary" data-action="mode-exit">← 本編に戻る</button>`;
      hint.innerHTML = `埋め込み単体のプレビューです（位置を決めると本編の中で再生されます）`;
      return;
    }
    bar.classList.add("hidden"); bar.innerHTML = "";
    if (isSlides()) { hint.innerHTML = `本編はスライドです：クリック：その時点へ　｜　編集は <b>⛶ 本編スライドを編集</b>（再生バー下）から`; return; }
    hint.innerHTML = `クリック：その時点へ　｜　<b>ダブルクリックしてそのままドラッグ</b>：範囲を選んで「字幕 / 倍速 / カット」　｜　範囲をクリック：編集　｜　紫のマーカー：埋め込み`;
  }

  // ---------- playback（メイン） ----------
  // 現在位置より前に終わる埋め込みを「通過済み」として記憶し直す（シーク時に呼ぶ）
  function recomputePassed() {
    S.passed = new Set();
    S.stall = 0;
    if (S.mode !== "project") return;
    const inf = R.info(P);
    const o = S.T - inf.opDur;
    for (const x of inf.insLayout) if (x.outEnd <= o + 1e-3) S.passed.add(x.ins.id);
  }
  function setT(t, opts) {
    opts = opts || {};
    const inf = info();
    S.T = Math.max(0, Math.min(inf.total, t));
    S.scrubSrc = null;
    recomputePassed();
    if (opts.pause) pause();
    syncVideoToT(true);
    updateHUD();
  }
  function seekSrc(src) {
    const inf = info();
    const clips = ctxClips();
    if (!clips.length) return;
    src = Math.max(0, Math.min(inf.srcTotal - 1e-3, src));
    pause();
    S.T = inf.opDur + R.pureToOut(inf, TL.srcToOut(inf.segs, src));
    S.scrubSrc = src;
    recomputePassed();
    const ca = TL.clipAt(clips, src);
    if (ca) { const v = runtime.videos[ca.clip.id]; if (v) switchActive(v, ca.local, false); }
    updateHUD();
  }
  function switchActive(v, local, play) {
    if (S.active && S.active !== v) { try { S.active.pause(); } catch (e) {} }
    S.active = v;
    if (Math.abs(v.currentTime - local) > 0.08) v.currentTime = local;
    if (play && v.paused) v.play().catch(() => {});
  }
  function syncVideoToT(force) {
    const loc = locate(S.T);
    if (loc.phase === "insert" && loc.ins) {
      const st = INS.videoState(loc.ins, loc.local);
      const v = st ? runtime.videos[st.id] : null;
      if (!v) { if (S.active) S.active.pause(); return loc; }
      if (S.active !== v || force || (!v.seeking && Math.abs(v.currentTime - st.time) > 0.5)) switchActive(v, st.time, S.playing);
      try { v.playbackRate = Math.min(16, st.rate || 1); } catch (e) {}
      if (S.playing && v.paused && !v.ended) v.play().catch(() => {});
      return loc;
    }
    if (loc.phase === "opening" && loc.clip && (loc.trans != null || loc.pre)) {
      const tv = runtime.videos[loc.clip.id];
      if (tv) { if (S.active && S.active !== tv) { try { S.active.pause(); } catch (e) {} } S.active = tv; tv.pause(); if (!tv.seeking && Math.abs(tv.currentTime - loc.clipLocal) > 0.05) tv.currentTime = loc.clipLocal; }
      return loc;
    }
    if (loc.phase !== "main" || !loc.clip) { if (S.active) S.active.pause(); return loc; }
    const v = runtime.videos[loc.clip.id];
    if (!v) return loc;
    if (S.active !== v || force || (!v.seeking && Math.abs(v.currentTime - loc.clipLocal) > 0.3)) switchActive(v, loc.clipLocal, S.playing);
    try { v.playbackRate = Math.min(16, loc.seg ? loc.seg.rate : 1); } catch (e) {}
    if (S.playing && v.paused && !v.ended) v.play().catch(() => {});
    return loc;
  }
  function play() {
    const inf = info();
    if (inf.total <= 0) { toast("クリップを追加するか、オープニングを有効にしてください"); return; }
    if (S.T >= inf.total - 0.02) { S.T = 0; recomputePassed(); }
    S.scrubSrc = null; S.playing = true; S.lastTick = performance.now();
    $("btn-play").textContent = "⏸";
    syncVideoToT(true);
  }
  function pause() {
    S.playing = false;
    $("btn-play").textContent = "▶";
    if (S.active) { try { S.active.pause(); } catch (e) {} }
  }
  function tick(now) {
    requestAnimationFrame(tick);
    if (S.exporting || S.picker) return;
    const dt = Math.min(0.1, (now - (S.lastTick || now)) / 1000);
    S.lastTick = now;
    if (S.fs) { fsTick(dt); return; }
    const inf = info();
    let loc = locate(S.T, inf);
    if (S.playing) {
      if (loc.phase === "main" && loc.clip && loc.seg) {
        syncVideoToT(false);
        const vid = runtime.videos[loc.clip.id];
        const clips = ctxClips();
        const off = TL.clipOffset(clips, clips.indexOf(loc.clip));
        const vsrc = off + vid.currentTime;
        let pure = null;
        if (vid.ended || vsrc >= loc.seg.end - 0.02) pure = loc.seg.outEnd + 0.001;
        else if (vsrc >= loc.seg.start - 0.05) pure = loc.seg.outStart + (Math.max(loc.seg.start, vsrc) - loc.seg.start) / loc.seg.rate;
        if (pure != null) S.T = inf.opDur + R.playingOut(inf, pure, S.passed);
        else S.T += dt;
        if (S.T >= inf.opDur + inf.mainDur) S.T = inf.opDur + inf.mainDur;
      } else if (loc.phase === "insert") {
        S.passed.add(loc.ins.id);                       // 入った時点で「通過済み」にして、二度と戻らない
        const st = INS.videoState(loc.ins, loc.local);
        const v = st ? runtime.videos[st.id] : null;
        const stalled = v && (v.seeking || v.readyState < 2);
        if (!stalled || (S.stall += dt) > 1) { S.T += dt; S.stall = 0; }   // 動画の読み込み待ち中は時間を進めない（最大1秒）
        syncVideoToT(false);
      } else {
        S.T += dt;
        if (S.active) S.active.pause();
      }
      if (S.T >= inf.total) { S.T = inf.total; pause(); }
      loc = locate(S.T, inf);
      if (loc.phase === "main" || loc.phase === "insert") syncVideoToT(false);
    }
    const W = canvas.width, H = canvas.height;
    if (S.mode === "insert") { const d = modeIns(); if (d) INS.draw(ctx, W, H, d, S.T, P, runtime); }
    else { const drawLoc = (S.scrubSrc != null && !S.playing) ? R.locateSrc(P, S.scrubSrc, inf) : loc; R.draw(ctx, W, H, drawLoc, P, runtime); }
    updateHUD(inf, loc);
  }

  // ---------- HUD / timeline（共通描画） ----------
  function updateHUD(inf, loc) {
    if (S.fs) return;
    inf = inf || info();
    loc = loc || locate(S.T, inf);
    $("time-label").textContent = `${TL.fmt(S.T)} / ${TL.fmt(inf.total)}`;
    const ph = $("phase-label");
    let src = 0;
    if (loc.phase === "opening") { ph.textContent = "🎞 オープニング"; }
    else if (loc.phase === "sting") { ph.textContent = "🏷 タイトル"; }
    else if (loc.phase === "ending") { ph.textContent = "🔚 エンディング"; src = inf.srcTotal; }
    else if (loc.phase === "insert") { ph.textContent = `${loc.ins ? INS.label(loc.ins) : "埋め込み"}`; src = loc.ins && loc.ins.at != null ? loc.ins.at : 0; }
    else {
      src = S.scrubSrc != null && !S.playing ? S.scrubSrc : loc.src;
      const bits = [`📹 ${loc.clip ? loc.clip.name : ""}`, `元 ${TL.fmtMs(src)}`];
      if (loc.seg && loc.seg.rate !== 1) bits.push(`×${loc.seg.rate}`);
      if (S.scrubSrc != null && TL.isCutAt(inf.segs, S.scrubSrc)) bits.push("カット区間");
      ph.textContent = bits.join("　");
    }
    $("tl-open").classList.toggle("active", loc.phase === "opening" || loc.phase === "sting");
    $("tl-end").classList.toggle("active", loc.phase === "ending");
    $("tl-open").classList.toggle("off", !P.opening.enabled || S.mode !== "project");
    $("tl-end").classList.toggle("off", !P.ending.enabled || S.mode !== "project");
    let pct = inf.srcTotal ? (src / inf.srcTotal) * 100 : 0;
    if (S.mode === "project" && isSlides()) pct = loc.phase === "insert" ? (inf.mainDur ? (loc.local / inf.mainDur) * 100 : 0) : loc.phase === "ending" ? 100 : 0;
    $("tl-playhead").style.left = `calc(${Math.max(0, Math.min(100, pct))}% - 1px)`;
    $("stage-empty").classList.toggle("hidden", S.mode !== "project" || isSlides() || P.clips.length > 0 || P.opening.enabled || P.ending.enabled);
  }
  function rangeBarHtml(ranges, total) {
    return ranges.map((r) => {
      const l = (r.start / total) * 100, w = Math.max(0.3, ((r.end - r.start) / total) * 100);
      const label = r.type === "caption" ? `💬 ${r.text || ""}` : r.type === "speed" ? `×${r.rate}` : `✂ ${cutFxLabel(r)}`;
      return `<div class="tl-range ${r.type} ${S.selectedRange === r.id ? "selected" : ""}" data-id="${r.id}" style="left:${l}%;width:${w}%" title="${esc(label)}">${esc(label)}</div>`;
    }).join("");
  }
  function rangeListHtml(ranges) {
    return ranges.slice().sort((a, b) => a.start - b.start).map((r) => {
      const chip = r.type === "caption" ? `<span class="chip chip-cap">字幕</span>` : r.type === "speed" ? `<span class="chip chip-speed">×${r.rate}</span>` : `<span class="chip chip-cut">カット</span>`;
      const d = r.type === "caption" ? r.text : r.type === "speed" ? `${r.rate}倍速` : `この区間を飛ばす（演出: ${cutFxLabel(r)}）`;
      return `<div class="range-item"><span class="t">${TL.fmtMs(r.start)} – ${TL.fmtMs(r.end)}</span>${chip}<span class="d">${esc(d)}</span><button class="btn btn-sm" data-action="range-jump" data-id="${r.id}">▶</button><button class="btn btn-sm" data-action="range-edit" data-id="${r.id}">編集</button><button class="btn btn-sm btn-danger" data-action="range-del" data-id="${r.id}">✕</button></div>`;
    }).join("");
  }
  function renderTimeline() {
    if (S.fs) { renderFsTimeline(); return; }
    const inf = info();
    if (S.mode === "project" && isSlides()) {
      const md = mainDeck();
      const blocks = md ? INS.blocks(md) : [];
      const tot = inf.mainDur || 1;
      $("tl-clips").innerHTML = blocks.length && inf.mainDur
        ? blocks.map((b, i) => `<div class="tl-clip" style="width:${(b.dur / tot) * 100}%" title="${esc(b.kind === "montage" ? "モンタージュ" : pageTitle(b.page))}">${i + 1}. ${esc(b.kind === "montage" ? "🎞 モンタージュ" : pageTitle(b.page))}</div>`).join("")
        : `<div class="tl-clip" style="width:100%;align-items:center;justify-content:center;font-size:11px">本編スライドにページがありません（下の「⛶ 本編スライドを編集」から）</div>`;
      $("tl-ranges").innerHTML = ""; $("tl-inserts").innerHTML = ""; $("range-list").innerHTML = "";
      $("insert-list").innerHTML = `<div class="range-item"><span class="chip" style="background:#c4b5fd;color:#111">本編</span><span class="d">${esc(md ? INS.label(md) : "本編スライド")}　${inf.mainDur.toFixed(1)}秒</span><button class="btn btn-sm btn-primary" data-action="main-deck-open">⛶ 本編スライドを編集</button><button class="btn btn-sm" data-action="open-picker">🎛 本編の種類を変える</button></div>`;
      $("tl-ghost").classList.add("hidden");
      updateHUD(inf);
      return;
    }
    const clips = ctxClips(), ranges = ctxRanges();
    const total = inf.srcTotal || 1;
    if (S.mode === "insert") $("tl-clips").innerHTML = `<div class="tl-clip" style="width:100%;align-items:center;justify-content:center;font-size:11px">埋め込みのプレビュー中（「← 本編に戻る」で戻ります）</div>`;
    else $("tl-clips").innerHTML = clips.map((c) => `<div class="tl-clip" style="width:${(c.duration / total) * 100}%" title="${esc(c.name)}（${TL.fmt(c.duration)}）">${esc(c.name)}</div>`).join("");
    $("tl-ranges").innerHTML = rangeBarHtml(ranges, total);
    $("tl-inserts").innerHTML = S.mode === "project" ? P.inserts.filter((x) => x.at != null).map((x) =>
      `<div class="tl-ins ${S.place === x.id ? "selected" : ""}" data-action="ins-marker" data-id="${x.id}" style="left:${(Math.min(x.at, inf.srcTotal) / total) * 100}%" title="${esc(INS.label(x))}（${INS.duration(x).toFixed(1)}秒）">🧩</div>`).join("") : "";
    $("range-list").innerHTML = rangeListHtml(ranges);
    const placed = S.mode === "project" ? P.inserts.filter((x) => x.at != null).sort((a, b) => a.at - b.at) : [];
    $("insert-list").innerHTML = placed.map((x) => `<div class="range-item"><span class="t">元 ${TL.fmtMs(x.at)} の直前</span><span class="chip" style="background:#c4b5fd;color:#111">埋め込み</span><span class="d">${esc(INS.label(x))}　${INS.duration(x).toFixed(1)}秒</span><button class="btn btn-sm" data-action="ins-preview" data-id="${x.id}">▶</button><button class="btn btn-sm" data-action="ins-open" data-id="${x.id}">編集</button><button class="btn btn-sm" data-action="ins-place" data-id="${x.id}">📍</button><button class="btn btn-sm btn-danger" data-action="ins-unplace" data-id="${x.id}">外す</button></div>`).join("");
    const ghost = $("tl-ghost");
    if (S.place && S.placeAt != null) { ghost.classList.remove("hidden"); ghost.style.left = `${(Math.min(S.placeAt, inf.srcTotal) / total) * 100}%`; }
    else ghost.classList.add("hidden");
    updateHUD(inf);
  }
  function posToSrc(e) {
    const rect = $(`${tlPre()}-track`).getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return f * info().srcTotal;
  }
  function showSelection(a, b) {
    const total = info().srcTotal || 1;
    const el = $(`${tlPre()}-selection`);
    if (!el) return;
    if (a == null) { el.classList.add("hidden"); return; }
    const l = Math.min(a, b), r = Math.max(a, b);
    el.classList.remove("hidden");
    el.style.left = `${(l / total) * 100}%`;
    el.style.width = `${((r - l) / total) * 100}%`;
  }
  function doSeek(src) { if (S.fs) fsSeekSrc(src); else seekSrc(src); }
  function bindTrack(track) {
    track.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tl-range") || e.target.closest(".tl-ins")) return;
      if (!S.fs && S.mode === "insert") return;
      if (!S.fs && S.mode === "project" && isSlides()) {
        const rect = track.getBoundingClientRect();
        const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const inf = info();
        setT(inf.opDur + f * inf.mainDur, { pause: true });
        return;
      }
      if (!ctxClips().length) { toast(S.fs ? "このページには動画がありません" : "まずクリップを追加してください"); return; }
      const s = posToSrc(e);
      if (!S.fs && S.place) { S.placeAt = s; seekSrc(s); renderModeBar(); renderTimeline(); return; }
      const now = performance.now();
      const dbl = now - S.lastDown < 400 && Math.abs(e.clientX - S.lastDownX) < 10;
      S.lastDown = now; S.lastDownX = e.clientX;
      track.setPointerCapture(e.pointerId);
      S.drag = dbl ? { mode: "select", a: s, b: s } : { mode: "scrub" };
      if (dbl) { if (S.pop) closePopover(); showSelection(s, s); }
      doSeek(s);
    });
    track.addEventListener("pointermove", (e) => {
      if (!S.drag) return;
      const s = posToSrc(e);
      if (S.drag.mode === "select") { S.drag.b = s; showSelection(S.drag.a, s); }
      doSeek(s);
    });
    const endDrag = () => {
      if (!S.drag) return;
      const d = S.drag; S.drag = null;
      if (d.mode !== "select") return;
      const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
      if (b - a < 0.15) { showSelection(null); toast("ダブルクリックしたまま横にドラッグして範囲を選びます"); return; }
      const pg = S.fs ? fsPage() : null;
      if (pg && pg.kind === "montage") { pg.video.start = a; pg.video.end = b; showSelection(null); save(); renderFsTimeline(); renderFsPages(); toast(`使う範囲：${TL.fmtMs(a)} – ${TL.fmtMs(b)}`); return; }
      openPopover({ id: store.uid("r"), type: null, start: a, end: b }, true);
    };
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    track.addEventListener("pointerdown", (e) => {
      const el = e.target.closest(".tl-range");
      if (!el) return;
      e.stopPropagation();
      const r = ctxRanges().find((x) => x.id === el.dataset.id);
      if (r) { doSeek(r.start); openPopover(r, false); }
    }, true);
  }

  // ---------- range popover（メイン／全画面 共通） ----------
  function popEl() { return S.fs ? $("fs-popover") : $("range-popover"); }
  function openPopover(range, isNew) {
    S.pop = { r: Object.assign({}, range), isNew };
    S.selectedRange = range.id;
    showSelection(range.start, range.end);
    renderPopover();
    renderTimeline();
  }
  function closePopover() {
    S.pop = null; S.selectedRange = null;
    const el = popEl(); if (el) el.classList.add("hidden");
    showSelection(null);
    renderTimeline();
  }
  function renderPopover() {
    const pop = popEl();
    const { r, isNew } = S.pop;
    pop.classList.remove("hidden");
    const tl = $(S.fs ? "fstl" : "timeline"), base = $(S.fs ? "fs-center" : "stage");
    const rect = tl.getBoundingClientRect(), st = base.getBoundingClientRect();
    pop.style.top = `${rect.bottom - st.top + base.scrollTop + 28}px`;
    pop.style.left = `${Math.max(0, Math.min(st.width - 430, rect.left - st.left + 46))}px`;
    const head = `<h4>${isNew ? "この範囲に" : "範囲を編集"} <span class="small">${TL.fmtMs(r.start)} – ${TL.fmtMs(r.end)}（${(r.end - r.start).toFixed(1)}秒）</span><span class="spacer"></span><button class="btn btn-sm" data-action="pop-close">✕</button></h4>`;
    if (!r.type) {
      pop.innerHTML = head + `<div class="row">
          <button class="btn btn-cap" data-action="pop-type" data-type="caption">💬 字幕を入れる</button>
          <button class="btn btn-speed" data-action="pop-type" data-type="speed">⏩ 倍速にする</button>
          <button class="btn btn-cut" data-action="pop-type" data-type="cut">✂ カットする</button></div>`;
      return;
    }
    let body = "";
    if (r.type === "caption") {
      body = `<div class="row"><textarea id="pop-text" placeholder="例：計画書を貼るだけでタスクに分解">${esc(r.text || "")}</textarea></div>
        <div class="row"><span class="small">色</span><div class="swatches">${CAP_COLORS.map((c) => `<div class="swatch ${(r.color || CAP_COLORS[0]) === c ? "on" : ""}" style="background:${c}" data-action="pop-color" data-color="${c}"></div>`).join("")}</div>
          <span class="spacer"></span><span class="small">位置</span><select id="pop-pos" style="width:auto"><option value="bottom" ${r.pos !== "top" && r.pos !== "center" ? "selected" : ""}>下</option><option value="center" ${r.pos === "center" ? "selected" : ""}>中央</option><option value="top" ${r.pos === "top" ? "selected" : ""}>上</option></select></div>
        <div class="small">単語ごとに色が移っていきます（長さは範囲の時間で自動配分）</div>`;
    } else if (r.type === "speed") {
      body = `<div class="row"><span class="small">倍率</span>${SPEEDS.map((s) => `<button class="btn btn-sm ${Number(r.rate) === s ? "btn-primary" : ""}" data-action="pop-rate" data-rate="${s}">×${s}</button>`).join("")}</div>
        <div class="small">この区間は ${((r.end - r.start) / (Number(r.rate) || 2)).toFixed(1)} 秒に縮みます</div>`;
    } else {
      const cur = r.fx || "default";
      body = `<div class="small">この区間（${(r.end - r.start).toFixed(1)}秒）を動画から取り除きます。</div>
        <div class="row" style="margin-top:8px"><span class="small">切り替わりの演出</span>
          <select id="pop-fx" style="width:auto">
            <option value="default" ${cur === "default" ? "selected" : ""}>既定（クリップタブの設定：${FX_LABEL[P.cutFx.type] || P.cutFx.type}）</option>
            <option value="whip" ${cur === "whip" ? "selected" : ""}>ウィップ（高速スライド＋ブラー）</option>
            <option value="zoom" ${cur === "zoom" ? "selected" : ""}>パンチズーム</option>
            <option value="glitch" ${cur === "glitch" ? "selected" : ""}>グリッチ</option>
            <option value="none" ${cur === "none" ? "selected" : ""}>なし（シームレスに繋ぐ）</option>
          </select></div>`;
    }
    pop.innerHTML = head + body + `<div class="row" style="margin-top:10px">
        ${isNew ? `<button class="btn btn-sm" data-action="pop-back">← 種類を選び直す</button>` : `<button class="btn btn-sm btn-danger" data-action="pop-delete">削除</button>`}
        <span class="spacer"></span>
        <button class="btn btn-sm" data-action="pop-close">キャンセル</button>
        <button class="btn btn-sm btn-primary" data-action="pop-save">保存</button></div>`;
    const ta = $("pop-text"); if (ta) ta.focus();
  }
  function savePopover() {
    const { r, isNew } = S.pop;
    if (r.type === "caption") {
      r.text = (val("pop-text") || "").trim();
      const pos = $("pop-pos"); r.pos = pos ? pos.value : "bottom";
      r.color = r.color || CAP_COLORS[0];
      if (!r.text) { toast("字幕の文章を入力してください"); return; }
    }
    if (r.type === "speed") r.rate = Number(r.rate) || 2;
    if (r.type === "cut") { const sel = $("pop-fx"); r.fx = sel ? sel.value : (r.fx || "default"); }
    if (r.end - r.start < 0.1) { toast("範囲が短すぎます"); return; }
    const ranges = ctxRanges();
    const idx = ranges.findIndex((x) => x.id === r.id);
    if (idx === -1) ranges.push(r); else ranges[idx] = r;
    R.snaps = {};
    save();
    closePopover();
    if (S.fs) renderFsPages();
    toast(isNew ? "範囲を追加しました" : "範囲を更新しました");
  }
  function deleteRange(id) {
    const rs = ctxRanges();
    const k = rs.findIndex((x) => x.id === id);
    if (k !== -1) rs.splice(k, 1);
    R.snaps = {}; save(); renderTimeline();
    if (S.fs) renderFsPages();
  }

  // ---------- side panel ----------
  function setTab(t) {
    S.tab = t;
    [...$("tabs").querySelectorAll("button")].forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderPanel();
  }
  function renderPanel() {
    const el = $("panel");
    if (S.tab === "opening") el.innerHTML = panelOpening();
    else if (S.tab === "clips") el.innerHTML = panelClips();
    else if (S.tab === "embed") el.innerHTML = panelEmbed();
    else if (S.tab === "ending") el.innerHTML = panelEnding();
    else el.innerHTML = panelExport();
  }
  function num(label, path, v, min, max, step, unit) {
    return `<div class="field"><label>${label} <span class="small">${v}${unit || ""}</span></label><input type="range" data-bind="${path}" min="${min}" max="${max}" step="${step}" value="${v}"></div>`;
  }
  function colorsBlock() {
    const c = P.colors;
    const st = VC.styles.get(P.style);
    return `
      <div class="field"><label>動画の型 <span class="small">${esc(st.name)}</span></label>
        <div class="row"><button class="btn btn-sm" data-action="open-picker">🎛 型を変える（OP / ED をプレビューして選ぶ）</button></div></div>
      <div class="field"><label>色・フォント</label>
        <div class="row">
          <label class="small row" style="gap:4px">背景 <input type="color" data-bind="colors.bg" value="${esc(c.bg)}"></label>
          <label class="small row" style="gap:4px">文字 <input type="color" data-bind="colors.fg" value="${esc(c.fg)}"></label>
          <select data-bind="colors.font" style="width:auto"><option value="sans" ${c.font === "sans" ? "selected" : ""}>サンセリフ</option><option value="serif" ${c.font === "serif" ? "selected" : ""}>セリフ（明朝）</option><option value="mono" ${c.font === "mono" ? "selected" : ""}>等幅</option></select>
          <span class="spacer"></span><button class="btn btn-sm" data-action="colors-reset">既定に戻す</button>
        </div></div>`;
  }
  function montageBlock(o) {
    const need = VC.opening.neededCount(o);
    const have = o.images.length;
    return `
      <div class="field"><label>モンタージュ画像（${have}枚 / コマ数 ${need}）</label>
        <div class="row"><button class="btn btn-sm" data-action="add-images">＋ 画像を追加</button><span class="small">または Cmd+V で貼り付け</span><span class="spacer"></span>${have ? `<button class="btn btn-sm btn-danger" data-action="clear-images">全削除</button>` : ""}</div>
        ${have ? `<div class="thumbs" style="margin-top:6px">${o.images.map((im) => `<div class="thumb"><img src="${runtime.images[im.id] ? runtime.images[im.id].src : ""}" alt=""><button class="x" data-action="del-image" data-id="${im.id}">✕</button></div>`).join("")}</div>` : `<div class="drop" data-action="add-images">ここをクリック / ドロップ / Cmd+V で画像を追加<br><span class="small">無いときはカラーのプレースホルダーが出ます</span></div>`}
        <div class="note">${have && have < need ? `枚数がコマ数より少ないので、2周目以降はズーム・回転・反転・色味違いで水増しします。` : `最初ゆっくり → だんだん速く切り替わります。`}</div>
      </div>
      ${num("モンタージュの長さ", "opening.montageDur", o.montageDur, 1.5, 10, 0.1, "秒")}
      <div class="grid2">${num("最初の間隔", "opening.intervalStart", o.intervalStart, 0.1, 1, 0.01, "秒")}${num("最後の間隔", "opening.intervalEnd", o.intervalEnd, 0.03, 0.3, 0.005, "秒")}</div>
      ${num("加速の強さ", "opening.accel", o.accel, 1, 4, 0.1, "")}
      <div class="note">1＝一定のペースで速くなる　2＝標準　3〜4＝最初ゆっくりが長く続いて、最後に一気に加速（CMっぽい）。コマ数 ${need} はこの値で変わります。</div>`;
  }
  function panelOpening() {
    const o = P.opening;
    const dur = VC.opening.duration(P);
    const tw = P.style === "typewriter";
    const head = `
      <h3>🎞 オープニング <label class="row" style="gap:6px;font-weight:400;font-size:12px"><input type="checkbox" data-bind="opening.enabled" ${o.enabled ? "checked" : ""}> 入れる</label></h3>
      <div class="small">合計 ${dur.toFixed(1)} 秒　<button class="btn btn-sm" data-action="preview-opening">▶ プレビュー</button></div>
      ${colorsBlock()}`;
    if (tw) {
      return head + `
        <div class="field"><label>タイプで出す文章（1行＝1センテンス）</label><textarea data-bind="opening.sentences" style="min-height:84px">${esc(o.sentences.join("\n"))}</textarea>
          <div class="small">タイプ → じわっと左に流れる → 一瞬で左に退場 → 次の文章、の順に出ます</div></div>
        <div class="grid3">${num("1文字の速さ", "opening.charDur", o.charDur, 0.02, 0.15, 0.005, "秒")}${num("じわっと流れる時間", "opening.holdDur", o.holdDur, 0.3, 2.5, 0.05, "秒")}${num("退場の速さ", "opening.exitDur", o.exitDur, 0.1, 0.6, 0.02, "秒")}</div>
        ${montageBlock(o)}
        ${num("最後の1枚で止める時間", "opening.lastHold", o.lastHold, 0, 2, 0.05, "秒")}`;
    }
    return head + `
      <div class="field"><label>最初に1文字ずつ出す単語（スペース区切り）</label><input type="text" data-bind="opening.words" value="${esc(o.words.join(" "))}" placeholder="you can now"></div>
      ${num("1単語の表示時間", "opening.wordDur", o.wordDur, 0.4, 2, 0.05, "秒")}
      ${montageBlock(o)}
      ${num("一呼吸", "opening.pause", o.pause, 0, 1.5, 0.05, "秒")}
      <div class="field"><label>用途（最後にドーンと出す文章）</label><textarea data-bind="opening.purpose" placeholder="例：edit documents / 計画書を貼るだけでタスクに分解">${esc(o.purpose)}</textarea>
        <div class="small">${VC.opening.phrases(o.purpose).length ? `長いので ${VC.opening.phrases(o.purpose).length} フレーズに分けて出してから全文を表示します` : "短いのでそのままドーンと表示します"}</div></div>
      <div class="grid2">${num("1フレーズの時間", "opening.phraseDur", o.phraseDur, 0.2, 1.5, 0.05, "秒")}${num("全文の表示時間", "opening.finalHold", o.finalHold, 0.5, 4, 0.1, "秒")}</div>
      ${num("本編へのズームイン（パンチズーム）", "opening.transDur", o.transDur, 0, 1.2, 0.05, "秒")}`;
  }
  function panelClips() {
    const total = TL.totalSource(P.clips);
    if (isSlides()) {
      const md = mainDeck();
      return `
        <h3>💬 本編（スライドだけ） <span class="small">${md ? `${md.pages.length}ページ・${INS.duration(md).toFixed(1)}秒` : ""}</span></h3>
        <div class="row"><button class="btn btn-primary" data-action="main-deck-open">⛶ 本編スライドを編集</button><button class="btn btn-sm" data-action="open-picker">🎛 本編の種類を変える</button></div>
        <div class="note">この動画の本編はスライドです。全画面エディタでページ（文字・画像・動画・モンタージュ）を作ると、OP → スライド → ED の順で再生・書き出しされます。<br>「画面収録」に戻しても、追加済みのクリップ（${P.clips.length}本）は残っています。</div>
        ${mediaStatusHtml()}`;
    }
    return `
      <h3>📹 クリップ（本編） <span class="small">${P.clips.length}本・${TL.fmt(total)}</span></h3>
      <div class="drop" data-action="add-videos">＋ 画面収録を追加（.mov / .mp4、複数可）<br><span class="small">ここにドラッグ＆ドロップでもOK</span></div>
      ${P.clips.length ? P.clips.map((c, i) => `
        <div class="clip-item">
          <span class="n" title="${esc(c.name)}">${i + 1}. ${esc(c.name)}</span>
          <span class="m">${TL.fmt(c.duration)}　${c.width}×${c.height}</span>
          <button class="btn" data-action="clip-up" data-i="${i}" ${i === 0 ? "disabled" : ""} title="上へ">↑</button>
          <button class="btn" data-action="clip-down" data-i="${i}" ${i === P.clips.length - 1 ? "disabled" : ""} title="下へ">↓</button>
          <button class="btn btn-danger" data-action="clip-del" data-i="${i}" title="削除">✕</button>
        </div>`).join("") : `<div class="note">クリップはこの順番で1本につながります。順番を入れ替えても、付けた字幕・倍速・カットはそのクリップについていきます。</div>`}
      <h3 style="margin-top:4px">✂ カットの演出</h3>
      <div class="grid2">
        <div class="field"><label>種類</label><select data-bind="cutFx.type">
          <option value="whip" ${P.cutFx.type === "whip" ? "selected" : ""}>ウィップ（高速スライド＋ブラー）</option>
          <option value="zoom" ${P.cutFx.type === "zoom" ? "selected" : ""}>パンチズーム</option>
          <option value="glitch" ${P.cutFx.type === "glitch" ? "selected" : ""}>グリッチ</option>
          <option value="none" ${P.cutFx.type === "none" ? "selected" : ""}>なし（シームレスに繋ぐ）</option>
        </select></div>
        ${num("長さ", "cutFx.dur", P.cutFx.dur, 0.1, 0.8, 0.05, "秒")}
      </div>
      <div class="note">ここは「既定」の演出です。カットごとに変えたいときは、再生バーのカット範囲をクリック → 「切り替わりの演出」で個別に選べます。</div>
      <div class="note">再生できない場合（HEVC収録など）は、QuickTime Player で「ファイル → 書き出す → 1080p」してから追加してください。</div>
      ${mediaStatusHtml()}`;
  }
  function mediaStatusHtml() {
    const miss = Object.entries(runtime.missing || {});
    const est = S.storage;
    const used = est && est.usage != null ? `${(est.usage / 1048576).toFixed(0)}MB 使用` : "";
    const quota = est && est.quota ? ` / 空き約 ${((est.quota - (est.usage || 0)) / 1073741824).toFixed(1)}GB` : "";
    return `
      <h3 style="margin-top:4px">📦 メディアの状態 <span class="small">${S.persisted ? "🔒 ストレージ保護あり" : "保護なし"}${used ? `　${used}${quota}` : ""}</span></h3>
      ${miss.length ? miss.map(([id, m]) => `
        <div class="clip-item">
          <span class="n">⚠ ${m.kind === "video" ? "🎥" : "🖼"} ${esc(m.name || id)}</span>
          <span class="small" style="flex:1;min-width:120px">${esc(m.error || "")}</span>
          <button class="btn btn-sm" data-action="media-reattach" data-id="${id}" data-kind="${m.kind}" style="width:auto;padding:0 8px">ファイルを選び直す</button>
        </div>`).join("") + `<div class="row"><button class="btn btn-sm btn-primary" data-action="media-retry">↻ 再読み込み</button><span class="small">一時的なエラーなら再読み込みで直ります。元ファイルがあれば「選び直す」で復旧（編集内容はそのまま）</span></div>`
      : `<div class="small">✅ すべて読み込めています。${S.persisted ? "" : "（ブラウザがストレージを保護していないため、容量不足時に消される可能性があります。このサイトをブックマークして使い続けると保護されやすくなります）"}</div>`}
      <div class="note">追加した動画・画像は中身をブラウザ内（IndexedDB）に<b>コピー</b>して保存します。元のファイルを移動・削除・変換しても消えません。読み込めなかったものもプロジェクトからは消さず、ここに残します。</div>`;
  }
  function panelEnding() {
    const e = P.ending;
    const tw = P.style === "typewriter";
    return `
      <h3>🔚 エンディング <label class="row" style="gap:6px;font-weight:400;font-size:12px"><input type="checkbox" data-bind="ending.enabled" ${e.enabled ? "checked" : ""}> 入れる</label></h3>
      <div class="small">合計 ${VC.ending.duration(P).toFixed(1)} 秒　<button class="btn btn-sm" data-action="preview-ending">▶ プレビュー</button></div>
      ${colorsBlock()}
      ${tw ? `
      <div class="field"><label>PR文（タイプ → じわっと流れる → 一瞬で退場）</label><textarea data-bind="ending.prText" style="min-height:60px">${esc(e.prText || "")}</textarea></div>
      <div class="grid3">${num("1文字の速さ", "ending.prCharDur", e.prCharDur, 0.02, 0.15, 0.005, "秒")}${num("じわっと流れる時間", "ending.prHold", e.prHold, 0.3, 2.5, 0.05, "秒")}${num("退場の速さ", "ending.exitDur", e.exitDur, 0.1, 0.6, 0.02, "秒")}</div>` : ""}
      <div class="field"><label>アプリ名（タイピング風に出ます）</label><input type="text" data-bind="ending.text" value="${esc(e.text)}" placeholder="AI-PM"></div>
      ${tw ? "" : `<div class="field"><label>サブテキスト（任意）</label><input type="text" data-bind="ending.sub" value="${esc(e.sub)}" placeholder="例：計画書を貼るだけ。段取りは、AIの上司がやる。"></div>`}
      <div class="grid2">${num("アプリ名の1文字の速さ", "ending.charDur", e.charDur, 0.03, 0.25, 0.01, "秒")}${num("表示したままの時間", "ending.hold", e.hold, 0.5, 5, 0.1, "秒")}</div>`;
  }
  function panelEmbed() {
    const projects = store.list();
    const selStyle = `padding:6px 8px;border:1px solid var(--line-2);border-radius:7px;background:var(--bg-2);color:var(--text);font:inherit;font-size:12px`;
    const row = (x) => {
      const isMain = !!x.main;
      const canPlace = !isSlides();
      const others = P.inserts.filter((y) => y.id !== x.id);
      return `
      <div class="ins-item" style="${isMain && isSlides() ? "border-color:#c4b5fd" : ""}">
        ${isMain ? `<span class="chip" style="background:#c4b5fd;color:#111">${isSlides() ? "本編" : "本編用"}</span>` : ""}
        <span class="n" title="${esc(INS.label(x))}">${esc(INS.label(x))}</span>
        <span class="small">${isMain && isSlides() ? "" : x.at != null ? `📍 元 ${TL.fmtMs(x.at)}` : "未配置"}　${INS.duration(x).toFixed(1)}秒</span>
        <button class="btn btn-sm btn-primary" data-action="ins-open" data-id="${x.id}">⛶ 開く</button>
        <button class="btn btn-sm" data-action="ins-preview" data-id="${x.id}">▶</button>
        ${canPlace ? `<button class="btn btn-sm" data-action="ins-place" data-id="${x.id}" title="本編に配置">📍</button>` : ""}
        <button class="btn btn-sm" data-action="ins-rename" data-id="${x.id}" title="名前を付ける">✏</button>
        <button class="btn btn-sm ${S.copyIns === x.id ? "btn-primary" : ""}" data-action="ins-copy-toggle" data-id="${x.id}" title="別のプロジェクトへコピー／複製">⧉</button>
        <button class="btn btn-sm ${S.mergeIns === x.id ? "btn-primary" : ""}" data-action="ins-merge-toggle" data-id="${x.id}" title="他の埋め込みを後ろに繋げる" ${others.length ? "" : "disabled"}>🔗</button>
        ${isSlides() && !isMain ? `<button class="btn btn-sm" data-action="ins-make-main" data-id="${x.id}" title="これを本編スライドにする">本編にする</button>` : ""}
        <button class="btn btn-sm btn-danger" data-action="ins-del" data-id="${x.id}">✕</button>
        ${S.copyIns === x.id ? `
        <div class="row" style="width:100%;margin-top:4px">
          <span class="small">コピー先</span>
          <select id="ins-copy-target" style="flex:1;${selStyle}">${projects.map((p) => `<option value="${p.id}" ${p.id === P.id ? "selected" : ""}>${esc(p.name || "動画")}${p.id === P.id ? "（このプロジェクト内に複製）" : ""}</option>`).join("")}</select>
          <button class="btn btn-sm btn-primary" data-action="ins-copy-run" data-id="${x.id}">コピー実行</button>
        </div>` : ""}
        ${S.mergeIns === x.id ? `
        <div class="row" style="width:100%;margin-top:4px">
          <span class="small">この後ろに繋げる埋め込み</span>
          <select id="ins-merge-src" style="flex:1;${selStyle}">${others.map((y) => `<option value="${y.id}">${esc(INS.label(y))}（${y.pages.length}ページ）</option>`).join("")}</select>
          <button class="btn btn-sm btn-primary" data-action="ins-merge-run" data-id="${x.id}" data-keep="0">繋げる（元は削除）</button>
          <button class="btn btn-sm" data-action="ins-merge-run" data-id="${x.id}" data-keep="1">複製して繋げる（元は残す）</button>
        </div>` : ""}
      </div>`;
    };
    const sorted = P.inserts.slice().sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0));
    const pullSrc = S.pullProj ? store.getProject(S.pullProj) : null;
    const pullDecks = pullSrc && Array.isArray(pullSrc.inserts) ? pullSrc.inserts.map((x) => INS.normalize(x)).filter(Boolean) : [];
    return `
      <h3>🧩 埋め込み <span class="small">${P.inserts.length}個</span></h3>
      <div class="row"><button class="btn btn-sm btn-primary" data-action="ins-new">＋ 新しい埋め込みを作る（全画面エディタ）</button>${isSlides() ? `<button class="btn btn-sm" data-action="open-picker">🎛 本編の種類を変える</button>` : ""}</div>
      ${isSlides() ? `<div class="note">本編がスライドのときは、他の埋め込みを本編に配置できません。「🔗」で本編スライドの後ろに繋げるか、「本編にする」で入れ替えてください。</div>` : ""}
      ${sorted.length ? sorted.map(row).join("") : `<div class="note">文字・画像・動画のページや、複数動画のモンタージュを全画面エディタで作り、本編の好きな位置に埋め込めます。「📍」で再生バーの位置をクリック → 決定。</div>`}
      <h3 style="margin-top:4px">📥 他のプロジェクトから取り込む</h3>
      <div class="row"><select id="pull-proj" style="flex:1;${selStyle}"><option value="">（プロジェクトを選択）</option>${projects.filter((p) => p.id !== P.id).map((p) => `<option value="${p.id}" ${S.pullProj === p.id ? "selected" : ""}>${esc(p.name || "動画")}</option>`).join("")}</select></div>
      ${pullSrc ? (pullDecks.length ? pullDecks.map((x) => `<div class="ins-item"><span class="n">${esc(INS.label(x))}</span><span class="small">${INS.duration(x).toFixed(1)}秒</span><button class="btn btn-sm btn-primary" data-action="pull-run" data-pid="${pullSrc.id}" data-id="${x.id}">📥 取り込む</button></div>`).join("") : `<div class="small">「${esc(pullSrc.name)}」に埋め込みはありません</div>`) : ""}
      ${Object.keys(runtime.missing || {}).length ? mediaStatusHtml() : ""}`;
  }
  function panelEmbedOld() {
    const md = mainDeck();
    const list = P.inserts.filter((x) => !x.main);
    return `
      <h3>🧩 埋め込み <span class="small">${list.length}個</span></h3>
      ${isSlides() && md ? `
      <div class="ins-item" style="border-color:#c4b5fd">
        <span class="chip" style="background:#c4b5fd;color:#111">本編</span>
        <span class="n" title="${esc(INS.label(md))}">${esc(INS.label(md))}</span>
        <span class="small">${INS.duration(md).toFixed(1)}秒</span>
        <button class="btn btn-sm btn-primary" data-action="main-deck-open">⛶ 編集</button>
        <button class="btn btn-sm" data-action="ins-preview" data-id="${md.id}">▶</button>
        <button class="btn btn-sm" data-action="ins-rename" data-id="${md.id}" title="名前を付ける">✏</button>
        <button class="btn btn-sm ${S.copyIns === md.id ? "btn-primary" : ""}" data-action="ins-copy-toggle" data-id="${md.id}" title="別のプロジェクトへコピー／複製">⧉</button>
        ${S.copyIns === md.id ? `<div class="row" style="width:100%;margin-top:4px"><span class="small">コピー先</span><select id="ins-copy-target" style="flex:1;padding:6px 8px;border:1px solid var(--line-2);border-radius:7px;background:var(--bg-2);color:var(--text);font:inherit;font-size:12px">${store.list().map((p) => `<option value="${p.id}" ${p.id === P.id ? "selected" : ""}>${esc(p.name || "動画")}${p.id === P.id ? "（このプロジェクト内に複製）" : ""}</option>`).join("")}</select><button class="btn btn-sm btn-primary" data-action="ins-copy-run" data-id="${md.id}">コピー実行</button></div>` : ""}
      </div>
      <div class="note">本編がスライドのときは、他の埋め込みを本編に配置することはできません（本編スライドにページとして作ってください）。</div>` : ""}
      <div class="row"><button class="btn btn-sm btn-primary" data-action="ins-new">＋ 新しい埋め込みを作る（全画面エディタ）</button></div>
      ${list.length ? list.map((x) => `
      <div class="ins-item">
        <span class="n" title="${esc(INS.label(x))}">${esc(INS.label(x))}</span>
        <span class="small">${x.at != null ? `📍 元 ${TL.fmtMs(x.at)}` : "未配置"}　${INS.duration(x).toFixed(1)}秒</span>
        <button class="btn btn-sm btn-primary" data-action="ins-open" data-id="${x.id}">⛶ 開く</button>
        <button class="btn btn-sm" data-action="ins-preview" data-id="${x.id}">▶</button>
        ${isSlides() ? "" : `<button class="btn btn-sm" data-action="ins-place" data-id="${x.id}">📍</button>`}
        <button class="btn btn-sm" data-action="ins-rename" data-id="${x.id}" title="名前を付ける">✏</button>
        <button class="btn btn-sm ${S.copyIns === x.id ? "btn-primary" : ""}" data-action="ins-copy-toggle" data-id="${x.id}" title="別のプロジェクトへコピー／複製">⧉</button>
        <button class="btn btn-sm btn-danger" data-action="ins-del" data-id="${x.id}">✕</button>
        ${S.copyIns === x.id ? `
        <div class="row" style="width:100%;margin-top:4px">
          <span class="small">コピー先</span>
          <select id="ins-copy-target" style="flex:1;padding:6px 8px;border:1px solid var(--line-2);border-radius:7px;background:var(--bg-2);color:var(--text);font:inherit;font-size:12px">
            ${store.list().map((p) => `<option value="${p.id}" ${p.id === P.id ? "selected" : ""}>${esc(p.name || "動画")}${p.id === P.id ? "（このプロジェクト内に複製）" : ""}</option>`).join("")}
          </select>
          <button class="btn btn-sm btn-primary" data-action="ins-copy-run" data-id="${x.id}">コピー実行</button>
        </div>` : ""}
      </div>`).join("") : `<div class="note">文字・画像・動画のページや、複数動画のモンタージュを全画面エディタで作り、本編の好きな位置に埋め込めます。「📍」で再生バーの位置をクリック → 決定。</div>`}
      ${Object.keys(runtime.missing || {}).length ? mediaStatusHtml() : ""}`;
  }
  function panelExport() {
    const inf = R.info(P);
    const sz = sizeOf();
    const mp4 = S.mp4ok;
    return `
      <h3>⬇ 書き出し</h3>
      <div class="field"><label>サイズ</label><select data-bind="output.size">${SIZES.map((s) => `<option value="${s.k}" ${s.k === P.output.size ? "selected" : ""}>${s.label}</option>`).join("")}</select></div>
      <div class="grid2">
        <div class="field"><label>フレームレート</label><select data-bind="output.fps"><option value="30" ${P.output.fps == 30 ? "selected" : ""}>30 fps</option><option value="24" ${P.output.fps == 24 ? "selected" : ""}>24 fps</option><option value="60" ${P.output.fps == 60 ? "selected" : ""}>60 fps</option></select></div>
        <div class="field"><label>ファイル名</label><input type="text" data-bind="output.name" value="${esc(P.output.name)}"></div>
      </div>
      <h3 style="margin-top:4px">💾 プロジェクトの保存（動画・画像込み）</h3>
      <div class="row">
        <button class="btn btn-sm btn-primary" data-action="export-project">💾 プロジェクトを丸ごと保存（.rcpk）</button>
        <label class="btn btn-sm" for="file-backup" style="cursor:pointer">📂 .rcpk を読み込む</label>
      </div>
      <div class="note">編集内容と、使っている動画・画像をすべて1ファイルにしてMacに保存します。ブラウザがデータを消しても、このファイルから完全に復元できます。<b>区切りごとに保存しておくのがおすすめ</b>です。${S.persisted ? "<br>🔒 現在このサイトは保護されています。" : "<br>⚠ 現在このサイトは保護されていません（上部の案内を参照）。"}</div>
      ${num("先頭のタイトルカード（サムネ用）", "output.sting", P.output.sting, 0, 0.5, 0.02, "秒")}
      <div class="note">長さ ${TL.fmt(inf.total)}（タイトル ${inf.stingDur.toFixed(2)}s ＋ OP ${inf.openDur.toFixed(1)}s ＋ 本編 ${TL.fmt(inf.mainDur)}（埋め込み ${inf.insLayout.length}個）＋ ED ${inf.edDur.toFixed(1)}s）<br>${sz.w}×${sz.h}・${P.output.fps}fps・無音・${mp4 === false ? "webm" : "mp4 (H.264)"}</div>
      ${mp4 === false ? `<div class="warn">このブラウザは mp4 書き出しに対応していないため webm になります。X / LinkedIn に投稿するなら <b>Chrome</b> で書き出してください。</div>` : mp4 === true ? `<div class="small">✅ mp4（H.264）で書き出せます。</div>` : `<div class="small">対応確認中…</div>`}
      <button class="btn btn-primary" data-action="export" ${inf.total <= 0 ? "disabled" : ""} style="height:40px">⬇ 動画を書き出す</button>
      <div class="note">1フレームずつ描いてエンコードするので、動画の長さの0.5〜1.5倍ほど時間がかかります。</div>
      <details><summary class="small" style="cursor:pointer">データを全部消す</summary><div class="row" style="margin-top:6px"><button class="btn btn-sm btn-danger" data-action="wipe">全プロジェクトのクリップ・画像・設定を削除</button></div></details>`;
  }

  // ---------- 埋め込み：プレビュー／配置 ----------
  function previewIns(id) {
    const d = deckById(id);
    if (!d) return;
    if (S.fs) closeFs(true);
    if (S.mode !== "project") exitMode();
    if (d.main && isSlides()) { const inf = R.info(P); setT(inf.opDur, { pause: true }); play(); return; }
    if (d.at != null) {
      const inf = R.info(P);
      const il = inf.insLayout.find((x) => x.ins.id === id);
      if (il) { setT(inf.opDur + il.outStart, { pause: true }); play(); return; }
    }
    enterMode("insert", id);
    play();
  }
  function startPlace(id) {
    if (S.fs) closeFs(true);
    if (S.mode !== "project") exitMode();
    if (isSlides()) { toast("本編がスライドのときは配置できません。本編スライドにページとして作るか、「⧉」で本編スライドへコピーしてください"); return; }
    if (!P.clips.length) { toast("先にクリップ（本編）を追加してください"); return; }
    const d = deckById(id);
    S.place = id; S.placeAt = d && d.at != null ? d.at : null;
    pause(); if (S.pop) closePopover();
    renderModeBar(); renderTimeline();
    toast("再生バーをクリックして位置を決めてください");
  }
  function finishPlace(ok) {
    const d = deckById(S.place);
    if (ok && d && S.placeAt != null) { d.at = S.placeAt; save(); toast(`${INS.label(d)} を 元 ${TL.fmtMs(d.at)} の直前に配置しました`); }
    S.place = null; S.placeAt = null;
    renderModeBar(); renderTimeline(); renderPanel(); setT(S.T, { pause: true });
  }
  // ---------- 埋め込みの名前・コピー ----------
  function renameDeck(id) {
    const x = deckById(id);
    if (!x) return;
    const name = prompt("埋め込みの名前（空にすると自動の名前になります）", x.name || "");
    if (name == null) return;
    x.name = name.trim().slice(0, 40);
    save(); renderPanel(); renderTimeline();
    if (S.fs && S.fs.deckId === id) renderFs();
  }
  async function copyBlobTo(from, to, kind, loadNow) {
    const b = await store.getBlob(from);
    if (!b) return false;
    await store.putBlob(to, b);
    if (loadNow) {
      try {
        if (kind === "video") runtime.videos[to] = await loadVideoEl(b, to);
        else runtime.images[to] = await loadImageEl(b);
      } catch (e) { console.warn(e); }
    }
    return true;
  }
  // デッキを完全に複製（動画・画像も別IDでコピー）。loadNow=true なら今すぐ再生できる状態にする
  async function cloneDeck(src, loadNow) {
    const c = JSON.parse(JSON.stringify(src));
    c.id = store.uid("ins"); c.at = null; delete c.main;
    const gmap = {}, groups = {};
    for (const gid in c.groups || {}) { const n = store.uid("g"); gmap[gid] = n; groups[n] = c.groups[gid]; }
    c.groups = groups;
    let missing = 0;
    for (const pg of c.pages) {
      pg.id = store.uid("s");
      pg.group = pg.group ? gmap[pg.group] || null : null;
      pg.ranges = (pg.ranges || []).map((r) => Object.assign({}, r, { id: store.uid("r") }));
      if (pg.video) {
        const nid = store.uid("v");
        if (await copyBlobTo(pg.video.id, nid, "video", loadNow)) pg.video = Object.assign({}, pg.video, { id: nid });
        else { missing++; pg.video = null; pg.ranges = []; if (pg.kind === "montage") { pg.kind = "slide"; pg.group = null; } }
      }
      const imgs = [];
      for (const im of pg.images || []) {
        const nid = store.uid("i");
        if (await copyBlobTo(im.id, nid, "image", loadNow)) imgs.push(Object.assign({}, im, { id: nid })); else missing++;
      }
      pg.images = imgs;
    }
    for (const gid in c.groups) if (!c.pages.some((p) => p.group === gid)) delete c.groups[gid];
    return { deck: INS.normalize(c), missing };
  }
  async function copyDeckTo(deckId, targetId) {
    const src = deckById(deckId);
    if (!src) return;
    const toSelf = targetId === P.id;
    const tp = toSelf ? P : store.getProject(targetId);
    if (!tp) { toast("コピー先が見つかりません"); return; }
    toast("コピー中…（動画・画像も複製しています）");
    try {
      const r = await cloneDeck(src, toSelf);
      r.deck.name = src.name ? `${src.name}（コピー）` : "";
      if (toSelf) { P.inserts.push(r.deck); save(); }
      else {
        const fresh = store.getProject(targetId) || tp;
        fresh.inserts = Array.isArray(fresh.inserts) ? fresh.inserts : [];
        fresh.inserts.push(r.deck);
        store.saveProject(fresh);
      }
      S.copyIns = null;
      renderPanel();
      toast(`${toSelf ? "このプロジェクト内に複製しました" : `「${tp.name}」にコピーしました（タブを切り替えると使えます）`}${r.missing ? `　⚠ 読み込めない動画・画像 ${r.missing}件は含まれていません` : ""}`);
    } catch (e) { console.error(e); toast(`コピーに失敗：${e.message}`); }
  }
  // 他のプロジェクトの埋め込みを、今のプロジェクトへ複製して取り込む
  async function pullDeckFrom(projId, deckId) {
    const sp = store.getProject(projId);
    const src = sp && Array.isArray(sp.inserts) ? sp.inserts.map((x) => INS.normalize(x)).find((x) => x && x.id === deckId) : null;
    if (!src) { toast("取り込み元が見つかりません"); return; }
    toast("取り込み中…（動画・画像も複製しています）");
    try {
      const r = await cloneDeck(src, true);
      r.deck.name = src.name || "";
      P.inserts.push(r.deck);
      save(); renderPanel(); renderTimeline();
      toast(`「${sp.name}」から ${INS.label(r.deck)} を取り込みました${r.missing ? `　⚠ 読み込めない動画・画像 ${r.missing}件は含まれていません` : ""}`);
    } catch (e) { console.error(e); toast(`取り込みに失敗：${e.message}`); }
  }
  // 結合：src のページを target の後ろに繋げる（keepSrc=false なら src は削除、true なら複製して繋げる）
  async function mergeDecks(targetId, srcId, keepSrc) {
    const target = deckById(targetId), src = deckById(srcId);
    if (!target || !src || target === src) return;
    try {
      let pages, groups;
      if (keepSrc) { const r = await cloneDeck(src, true); pages = r.deck.pages; groups = r.deck.groups; }
      else { pages = src.pages; groups = src.groups; }
      Object.assign(target.groups, groups);
      target.pages.push(...pages);
      if (!keepSrc) {
        const wasMain = !!src.main;
        P.inserts = P.inserts.filter((y) => y.id !== srcId);
        if (S.fs && S.fs.deckId === srcId) closeFs(true);
        if (wasMain && isSlides()) { target.main = true; target.at = null; }
      }
      S.mergeIns = null;
      R.snaps = {};
      save(); renderPanel(); renderTimeline(); setT(Math.min(S.T, info().total), { pause: true });
      toast(`${INS.label(target)} に ${pages.length}ページを繋げました${keepSrc ? "（元は残しています）" : ""}`);
    } catch (e) { console.error(e); toast(`結合に失敗：${e.message}`); }
  }
  function makeMain(id) {
    const x = deckById(id);
    if (!x) return;
    for (const y of P.inserts) y.main = false;
    x.main = true; x.at = null;
    S.T = 0; R.snaps = {};
    save(); renderPanel(); renderTimeline(); setT(0, { pause: true });
    toast(`${INS.label(x)} を本編スライドにしました`);
  }
  function deleteDeck(id) {
    const x = deckById(id);
    if (!x || !confirm(`${INS.label(x)} を削除しますか？${x.main && isSlides() ? "\n（本編スライドです。削除すると、空の本編スライドが作られます）" : ""}`)) return;
    for (const v of INS.videoRefs(x)) { delete runtime.videos[v.id]; store.delBlob(v.id); }
    for (const im of INS.imageRefs(x)) { delete runtime.images[im.id]; store.delBlob(im.id); }
    if (S.fs && S.fs.deckId === id) closeFs(true);
    if (S.modeIns === id) exitMode();
    P.inserts = P.inserts.filter((y) => y.id !== id);
    if (S.copyIns === id) S.copyIns = null;
    if (S.mergeIns === id) S.mergeIns = null;
    if (isSlides()) ensureMainDeck();
    save(); renderPanel(); renderTimeline(); setT(Math.min(S.T, info().total), { pause: true });
  }

  // ---------- 全画面スライドエディタ ----------
  function fsDeck() { return S.fs ? deckById(S.fs.deckId) : null; }
  function fsPage() { const d = fsDeck(); return d ? d.pages.find((x) => x.id === S.fs.pageId) || d.pages[0] || null : null; }
  function fsGroup() { const pg = fsPage(), d = fsDeck(); return pg && pg.kind === "montage" && d ? d.groups[pg.group] || null : null; }
  function openFs(deckId, pageId) {
    const d = deckById(deckId);
    if (!d) return;
    pause();
    if (S.mode !== "project") { S.mode = "project"; S.modeIns = null; }
    if (S.pop) closePopover();
    if (S.place) finishPlace(false);
    S.fs = { deckId: d.id, pageId: pageId || d.pages[0].id, selImg: null, crop: false, drag: null, play: null, active: null, scrubSrc: null };
    $("slide-fs").classList.remove("hidden");
    renderFs();
  }
  function closeFs(silent) {
    if (!S.fs) return;
    fsStop();
    if (S.pop) { S.pop = null; S.selectedRange = null; }
    S.fs = null;
    $("slide-fs").classList.add("hidden");
    $("slide-fs").innerHTML = "";
    R.snaps = {};
    if (!silent) { renderPanel(); renderModeBar(); renderTimeline(); setT(0, { pause: true }); }
  }
  function renderFs() {
    const d = fsDeck(), pg = fsPage();
    if (!d || !pg) { closeFs(); return; }
    S.fs.pageId = pg.id;
    const colors = INS.colorsOf(pg, P);
    const isM = pg.kind === "montage";
    const g = fsGroup();
    $("slide-fs").innerHTML = `
      <div class="fs-top">
        <b>⛶</b><input type="text" data-fs="name" value="${esc(d.name || "")}" placeholder="埋め込みの名前（任意）">
        <span class="sep"></span>
        <div class="grp"><button class="btn btn-sm" data-action="fs-page-add" title="空のページを追加">＋ ページ</button><button class="btn btn-sm" data-action="fs-montage-new" title="動画を複数選ぶとモンタージュのページ群になります">🎞 モンタージュ</button></div>
        <span class="sep"></span>
        ${isM ? `<span class="small">モンタージュ用ページ（下の再生バーで「使う範囲」をダブルクリック＋ドラッグ）</span>` : `
        <div class="grp">
          <button class="btn btn-sm" data-cmd="bold" data-keepfocus="1" title="太字"><b>B</b></button>
          <button class="btn btn-sm" data-cmd="underline" data-keepfocus="1" title="下線"><u>U</u></button>
          <select data-fscmd="fontSize" style="width:auto;padding:4px 6px;border:1px solid var(--line-2);border-radius:7px;background:var(--bg-2);color:var(--text);font:inherit;font-size:12px"><option value="">サイズ</option>${[1, 2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}">${["xs", "s", "標準", "L", "XL", "2XL", "3XL"][n - 1]}</option>`).join("")}</select>
          <button class="btn btn-sm" data-cmd="removeFormat" data-keepfocus="1" title="装飾を解除">解除</button>
        </div>
        <span class="sep"></span>
        <div class="grp align-btns">${[["left", "⇤"], ["center", "↔"], ["right", "⇥"]].map(([a, l]) => `<button class="btn btn-sm ${(pg.align || "center") === a ? "on" : ""}" data-action="fs-align" data-al="${a}" title="${a}">${l}</button>`).join("")}
          <select data-sb="pos" style="width:auto;padding:4px 6px;border:1px solid var(--line-2);border-radius:7px;background:var(--bg-2);color:var(--text);font:inherit;font-size:12px"><option value="center" ${pg.pos === "center" ? "selected" : ""}>中央</option><option value="top" ${pg.pos === "top" ? "selected" : ""}>上</option><option value="bottom" ${pg.pos === "bottom" ? "selected" : ""}>下</option></select></div>
        <span class="sep"></span>
        <div class="grp"><label class="small row" style="gap:3px">背景<input type="color" data-sb="bg" value="${esc(colors.bg)}"></label><label class="small row" style="gap:3px">文字<input type="color" data-sb="fg" value="${esc(colors.fg)}"></label><button class="btn btn-sm" data-action="slide-colors-reset" title="テーマの色に戻す">テーマ色</button></div>
        <span class="sep"></span>
        <div class="grp"><button class="btn btn-sm" data-action="fs-img-add">🖼 画像</button><button class="btn btn-sm" data-action="fs-video-add">🎥 ${pg.video ? "動画を差替" : "動画"}</button>${pg.video ? `<button class="btn btn-sm btn-danger" data-action="fs-video-remove" title="動画を外す">🎥✕</button>` : ""}<button class="btn btn-sm ${S.fs.crop ? "on" : ""}" data-action="fs-crop" ${S.fs.selImg ? "" : "disabled"}>✂ 切り取り</button></div>`}
        <span class="spacer"></span>
        <div class="grp">${S.fs.play ? `<button class="btn btn-sm btn-primary" data-action="fs-stop">⏹ 停止</button>` : `<button class="btn btn-sm" data-action="fs-play-page">▶ ${isM ? "このモンタージュ" : "このページ"}</button><button class="btn btn-sm" data-action="fs-play-deck">▶ 全体</button>`}</div>
        <span class="sep"></span>
        <button class="btn btn-sm" data-action="ins-place" data-id="${d.id}">📍 配置${d.at != null ? `（元 ${TL.fmtMs(d.at)}）` : ""}</button>
        <button class="btn btn-sm btn-primary" data-action="fs-close">✓ 完了</button>
      </div>
      <div class="fs-pages" id="fs-pages"></div>
      <div class="fs-center" id="fs-center">
        <div class="fs-stage-wrap" id="fs-wrap">
          <div class="fs-stage ${S.fs.crop ? "crop" : ""} ${S.fs.play ? "fs-playing" : ""}" id="fs-stage"><canvas id="fs-bg"></canvas><div id="fs-imgs"></div><canvas id="fs-text" class="fs-text"></canvas></div>
          <div class="fs-hint" id="fs-hint"></div>
        </div>
        ${g ? `<div class="fs-gset"><b style="font-size:12px;color:#facc15">🎞 モンタージュの設定（このグループ共通）</b>
          <div class="grid3">${num("長さ", "__g.montageDur", g.montageDur, 1, 15, 0.1, "秒")}${num("最初の間隔", "__g.intervalStart", g.intervalStart, 0.15, 2, 0.05, "秒")}${num("最後の間隔", "__g.intervalEnd", g.intervalEnd, 0.04, 0.5, 0.01, "秒")}</div>
          <div class="grid2">${num("加速の強さ", "__g.accel", g.accel, 1, 4, 0.1, "")}${num("最後のコマで止める", "__g.lastHold", g.lastHold, 0, 2, 0.05, "秒")}</div>
          <div class="small">使う範囲：${pg.video ? `${TL.fmtMs(INS.useRange(pg.video).start)} – ${TL.fmtMs(INS.useRange(pg.video).end)}` : "動画なし"}　<button class="btn btn-sm" data-action="fs-use-reset">全体に戻す</button>　<button class="btn btn-sm" data-action="fs-montage-add" data-gid="${pg.group}">＋ このモンタージュに動画を追加</button></div></div>` : ""}
        <div class="timeline" id="fstl"><div class="tl-track" id="fstl-track"><div class="tl-clips" id="fstl-clips"></div><div class="tl-ranges" id="fstl-ranges"></div><div class="fs-usebar hidden" id="fstl-use"></div><div class="tl-selection hidden" id="fstl-selection"></div><div class="tl-playhead" id="fstl-playhead"></div></div></div>
        <div class="tl-hint" id="fstl-hint"></div>
        <div id="fs-popover" class="popover hidden"></div>
        <div id="fs-range-list" class="range-list"></div>
        ${isM ? "" : `<div class="fs-editor-wrap">
          <div id="fs-editor" class="slide-editor pos-${pg.pos} al-${pg.align}" contenteditable="true" data-slide-html="1" style="background:${esc(colors.bg)};color:${esc(colors.fg)};font-family:${VC.text.FONTS[colors.font] || VC.text.FONTS.sans}" spellcheck="false">${pg.html || ""}</div>
          <div class="row" style="margin-top:6px">${pg.video ? `<span class="small">🎥 「${esc(pg.video.name)}」：長さは動画（${INS.pageDuration(pg).toFixed(1)}秒）に合わせます</span>` : num("表示時間", "__page.dur", pg.dur, 0.3, 10, 0.1, "秒")}</div>
        </div>`}
      </div>`;
    renderFsPages();
    fitFsStage();
    renderFsStage();
    renderFsTimeline();
    bindTrack($("fstl-track"));
  }
  function renderFsPages() {
    const d = fsDeck();
    const box = $("fs-pages");
    if (!d || !box) return;
    const sz = sizeOf();
    const th = Math.round((200 * sz.h) / sz.w);
    const pageHtml = (p, i) => `
      <div class="fs-page ${p.id === S.fs.pageId ? "sel" : ""}" data-action="fs-page-select" data-id="${p.id}">
        <canvas data-pgthumb="${p.id}" width="200" height="${th}"></canvas>
        <span class="no">${i + 1}</span><span class="tag">${p.kind === "montage" ? "🎞" : ""}${p.video ? "🎥" : ""}${p.images.length ? "🖼" : ""}${p.kind !== "montage" && INS.hasText(p) ? "💬" : ""}</span>
        <div class="ops"><button class="btn" data-action="fs-page-move" data-id="${p.id}" data-d="-1" title="上へ">↑</button><button class="btn" data-action="fs-page-move" data-id="${p.id}" data-d="1" title="下へ">↓</button><button class="btn" data-action="fs-page-dup" data-id="${p.id}" title="複製">⧉</button><button class="btn btn-danger" data-action="fs-page-del" data-id="${p.id}" title="削除">✕</button></div>
      </div>`;
    let html = "", i = 0;
    while (i < d.pages.length) {
      const p = d.pages[i];
      if (p.kind === "montage" && d.groups[p.group]) {
        const gid = p.group;
        let inner = "";
        while (i < d.pages.length && d.pages[i].kind === "montage" && d.pages[i].group === gid) { inner += pageHtml(d.pages[i], i); i++; }
        html += `<div class="fs-group"><div class="gh">🎞 モンタージュ <button class="btn" data-action="fs-montage-add" data-gid="${gid}">＋動画</button></div>${inner}</div>`;
      } else { html += pageHtml(p, i); i++; }
    }
    box.innerHTML = html;
    for (const cv of box.querySelectorAll("canvas[data-pgthumb]")) {
      const p = d.pages.find((x) => x.id === cv.dataset.pgthumb);
      if (!p) continue;
      const c = cv.getContext("2d");
      try { INS.drawPage(c, cv.width, cv.height, p, 0, P, runtime, { static: true, live: true, src: p.video ? INS.useRange(p.video).start : null }); } catch (e) {}
    }
  }
  function fitFsStage() {
    const wrap = $("fs-wrap"), st = $("fs-stage");
    if (!wrap || !st) return;
    const sz = sizeOf();
    const aw = wrap.clientWidth - 8, ah = Math.max(220, wrap.clientHeight - 30);
    let w = aw, h = (w * sz.h) / sz.w;
    if (h > ah) { h = ah; w = (h * sz.w) / sz.h; }
    st.style.width = `${Math.max(100, w)}px`;
    st.style.height = `${Math.max(60, h)}px`;
  }
  function renderFsBg() {
    const pg = fsPage(), bg = $("fs-bg");
    if (!pg || !bg) return;
    const sz = sizeOf();
    if (bg.width !== sz.w) { bg.width = sz.w; bg.height = sz.h; }
    const c = bg.getContext("2d");
    if (S.fs.play) {
      const d = fsDeck();
      if (S.fs.play.kind === "deck") INS.draw(c, sz.w, sz.h, d, S.fs.play.T, P, runtime);
      else { const b = INS.blockOfPage(d, pg.id); if (b && b.kind === "montage") INS.drawMontageBlock(c, sz.w, sz.h, b, S.fs.play.T, runtime); else INS.drawPage(c, sz.w, sz.h, pg, S.fs.play.T, P, runtime); }
      return;
    }
    INS.drawPage(c, sz.w, sz.h, pg, 0, P, runtime, { live: true, src: S.fs.scrubSrc, noImages: true, noText: true });
  }
  function renderFsStage() {
    const pg = fsPage(), st = $("fs-stage");
    if (!pg || !st) return;
    st.classList.toggle("crop", !!S.fs.crop);
    st.classList.toggle("fs-playing", !!S.fs.play);
    const sz = sizeOf();
    const tx = $("fs-text"); tx.width = sz.w; tx.height = sz.h;
    renderFsBg();
    drawFsText();
    $("fs-imgs").innerHTML = pg.images.map((im) => imgElHtml(im)).join("");
    for (const im of pg.images) updateImgEl(im);
    const hint = $("fs-hint");
    if (hint) hint.textContent = S.fs.play ? "再生中（⏹ で停止）" : S.fs.crop ? "画像の4辺のバーをドラッグして切り取り（Esc または「✂」で終了）" : pg.kind === "montage" ? "モンタージュ用ページ：下の再生バーで使う範囲を指定" : "画像：ドラッグで移動 ／ 右下の■で拡大縮小 ／ 選んで「✂ 切り取り」／ Delete で削除　｜　Cmd+V で画像を貼り付け";
  }
  function drawFsText() {
    const pg = fsPage(), cv = $("fs-text");
    if (!pg || !cv) return;
    const c = cv.getContext("2d");
    c.clearRect(0, 0, cv.width, cv.height);
    if (pg.kind === "montage" || !INS.hasText(pg)) return;
    const colors = INS.colorsOf(pg, P);
    VC.text.use(colors);
    INS.drawText(c, cv.width, cv.height, INS.parseHtml(pg.html), 0, INS.pageDuration(pg), P, colors, { pos: pg.pos || "center", align: pg.align || "center", overMedia: !!pg.video || pg.images.length > 0, static: true });
  }
  function imgElHtml(im) {
    const img = runtime.images[im.id];
    return `<div class="fs-img ${S.fs.selImg === im.id ? "sel" : ""}" data-img="${im.id}"><img src="${img ? img.src : ""}" alt=""><div class="h"></div><div class="e l" data-edge="l"></div><div class="e r" data-edge="r"></div><div class="e t" data-edge="t"></div><div class="e b" data-edge="b"></div></div>`;
  }
  function updateImgEl(im) {
    const box = $("fs-imgs");
    const el = box && box.querySelector(`[data-img="${im.id}"]`);
    if (!el) return;
    el.style.left = `${im.x * 100}%`; el.style.top = `${im.y * 100}%`; el.style.width = `${im.w * 100}%`; el.style.height = `${im.h * 100}%`;
    const img = el.querySelector("img");
    img.style.width = `${100 / im.sw}%`; img.style.height = `${100 / im.sh}%`;
    img.style.left = `${-(im.sx / im.sw) * 100}%`; img.style.top = `${-(im.sy / im.sh) * 100}%`;
    el.classList.toggle("sel", S.fs.selImg === im.id);
  }
  function fsSelectImg(id) {
    S.fs.selImg = id;
    if (!id) S.fs.crop = false;
    const box = $("fs-imgs");
    if (box) for (const el of box.querySelectorAll(".fs-img")) el.classList.toggle("sel", el.dataset.img === id);
    const st = $("fs-stage"); if (st) st.classList.toggle("crop", !!S.fs.crop);
    const b = $("slide-fs").querySelector('[data-action="fs-crop"]');
    if (b) { b.disabled = !id; b.classList.toggle("on", !!S.fs.crop); }
  }
  function fsDeleteImage(id) {
    const pg = fsPage();
    if (!pg) return;
    pg.images = pg.images.filter((x) => x.id !== id);
    delete runtime.images[id]; store.delBlob(id);
    S.fs.selImg = null; S.fs.crop = false;
    save(); renderFs();
  }
  function renderFsTimeline() {
    const pg = fsPage();
    if (!pg || !$("fstl-track")) return;
    const inf = info();
    const total = inf.srcTotal || 1;
    const v = pg.video;
    $("fstl-clips").innerHTML = v ? `<div class="tl-clip" style="width:100%">${esc(v.name)}（${TL.fmt(v.duration)}）</div>` : `<div class="tl-clip" style="width:100%;align-items:center;justify-content:center;font-size:11px">動画なし（上の「🎥 動画」で載せられます）</div>`;
    const ranges = ctxRanges();
    $("fstl-ranges").innerHTML = rangeBarHtml(ranges, total);
    const use = $("fstl-use");
    if (pg.kind === "montage" && v) { const r = INS.useRange(v); use.classList.remove("hidden"); use.style.left = `${(r.start / total) * 100}%`; use.style.width = `${(r.dur / total) * 100}%`; }
    else use.classList.add("hidden");
    $("fs-range-list").innerHTML = rangeListHtml(ranges);
    $("fstl-hint").innerHTML = pg.kind === "montage"
      ? `<b>ダブルクリックしてそのままドラッグ</b>：このページの動画から使う範囲（黄色）を指定`
      : `クリック：その時点へ　｜　<b>ダブルクリックしてそのままドラッグ</b>：範囲を選んで「字幕 / 倍速 / カット」　｜　範囲をクリック：編集`;
    updateFsPlayhead();
  }
  function updateFsPlayhead() {
    const pg = fsPage(), ph = $("fstl-playhead");
    if (!pg || !ph) return;
    const total = pg.video ? pg.video.duration || 1 : 1;
    let src = S.fs.scrubSrc != null ? S.fs.scrubSrc : 0;
    if (S.fs.play && pg.video) {
      const st = S.fs.play.kind === "deck" ? INS.videoState(fsDeck(), S.fs.play.T) : (INS.blockOfPage(fsDeck(), pg.id) && INS.blockOfPage(fsDeck(), pg.id).kind === "montage" ? INS.montageState(INS.blockOfPage(fsDeck(), pg.id), S.fs.play.T) : INS.pageVideoState(pg, S.fs.play.T));
      if (st && st.id === pg.video.id) src = st.time;
    }
    ph.style.left = `calc(${Math.max(0, Math.min(100, (src / total) * 100))}% - 1px)`;
  }
  function fsSeekSrc(src) {
    const pg = fsPage();
    if (!pg || !pg.video) return;
    fsStop();
    src = Math.max(0, Math.min((pg.video.duration || 0) - 1e-3, src));
    S.fs.scrubSrc = src;
    const v = runtime.videos[pg.video.id];
    if (v && Math.abs(v.currentTime - src) > 0.03) v.currentTime = src;
    updateFsPlayhead();
  }
  function fsPlay(kind) {
    S.fs.play = { kind, T: 0 };
    S.fs.scrubSrc = null;
    renderFs();
  }
  function fsStop() {
    if (!S.fs || !S.fs.play) return;
    S.fs.play = null;
    if (S.fs.active) { try { S.fs.active.pause(); } catch (e) {} S.fs.active = null; }
    renderFs();
  }
  function fsTick(dt) {
    const pg = fsPage(), d = fsDeck();
    if (!pg || !d) return;
    if (S.fs.play) {
      const pl = S.fs.play;
      pl.T += dt;
      let dur, st;
      if (pl.kind === "deck") { dur = INS.duration(d); st = INS.videoState(d, pl.T); }
      else { const b = INS.blockOfPage(d, pg.id); dur = b ? b.dur : INS.pageDuration(pg); st = b && b.kind === "montage" ? INS.montageState(b, pl.T) : INS.pageVideoState(pg, pl.T); }
      const v = st ? runtime.videos[st.id] : null;
      if (v) {
        if (S.fs.active && S.fs.active !== v) S.fs.active.pause();
        S.fs.active = v;
        if (Math.abs(v.currentTime - st.time) > 0.3) v.currentTime = st.time;
        try { v.playbackRate = Math.min(16, st.rate || 1); } catch (e) {}
        if (v.paused) v.play().catch(() => {});
      } else if (S.fs.active) { S.fs.active.pause(); S.fs.active = null; }
      if (pl.T >= dur) { fsStop(); return; }
      renderFsBg();
      updateFsPlayhead();
      return;
    }
    if (pg.video) renderFsBg();
  }
  function slideHtmlInput(el) {
    const pg = fsPage();
    if (!pg) return;
    pg.html = el.innerHTML;
    save();
    drawFsText();
  }
  function execCmd(cmd, arg) {
    const ed = $("fs-editor");
    if (!ed) return;
    ed.focus();
    try { document.execCommand("styleWithCSS", false, false); document.execCommand(cmd, false, arg || null); } catch (e) {}
    slideHtmlInput(ed);
  }
  const fsEl = $("slide-fs");
  fsEl.addEventListener("pointerdown", (e) => {
    if (!S.fs || S.fs.play) return;
    const stage = $("fs-stage");
    if (!stage || !stage.contains(e.target)) return;
    const pg = fsPage();
    if (!pg) return;
    const imEl = e.target.closest(".fs-img");
    if (!imEl) { if (S.fs.selImg) fsSelectImg(null); return; }
    const im = pg.images.find((x) => x.id === imEl.dataset.img);
    if (!im) return;
    if (S.fs.selImg !== im.id) fsSelectImg(im.id);
    const rect = stage.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width, ny = (e.clientY - rect.top) / rect.height;
    let kind = "move", edge = null;
    if (e.target.classList.contains("h")) kind = "resize";
    else if (e.target.classList.contains("e") && S.fs.crop) { kind = "crop"; edge = e.target.dataset.edge; }
    else if (S.fs.crop) return;
    S.fs.drag = { kind, edge, id: im.id, nx, ny, orig: Object.assign({}, im), rect };
    try { stage.setPointerCapture(e.pointerId); } catch (x) {}
    e.preventDefault();
  });
  fsEl.addEventListener("pointermove", (e) => {
    const d = S.fs && S.fs.drag;
    if (!d) return;
    const pg = fsPage();
    const im = pg && pg.images.find((x) => x.id === d.id);
    if (!im) return;
    const nx = (e.clientX - d.rect.left) / d.rect.width, ny = (e.clientY - d.rect.top) / d.rect.height;
    const dx = nx - d.nx, dy = ny - d.ny, o = d.orig;
    if (d.kind === "move") { im.x = o.x + dx; im.y = o.y + dy; }
    else if (d.kind === "resize") { const nw = Math.max(0.03, o.w + dx); im.w = nw; im.h = o.h * (nw / o.w); }
    else if (d.kind === "crop") {
      const rx = o.sw / o.w, ry = o.sh / o.h;
      if (d.edge === "l") { const a = Math.max(-o.sx / rx, Math.min(dx, o.w - 0.03)); im.x = o.x + a; im.w = o.w - a; im.sx = o.sx + a * rx; im.sw = o.sw - a * rx; }
      if (d.edge === "r") { const a = Math.max(0.03 - o.w, Math.min(dx, (1 - o.sx - o.sw) / rx)); im.w = o.w + a; im.sw = o.sw + a * rx; }
      if (d.edge === "t") { const a = Math.max(-o.sy / ry, Math.min(dy, o.h - 0.03)); im.y = o.y + a; im.h = o.h - a; im.sy = o.sy + a * ry; im.sh = o.sh - a * ry; }
      if (d.edge === "b") { const a = Math.max(0.03 - o.h, Math.min(dy, (1 - o.sy - o.sh) / ry)); im.h = o.h + a; im.sh = o.sh + a * ry; }
    }
    updateImgEl(im);
  });
  const fsEndDrag = () => { if (S.fs && S.fs.drag) { S.fs.drag = null; save(); renderFsPages(); } };
  fsEl.addEventListener("pointerup", fsEndDrag);
  fsEl.addEventListener("pointercancel", fsEndDrag);
  window.addEventListener("resize", () => { if (S.fs) fitFsStage(); });

  // ---------- 型の選択画面 ----------
  const demos = {};
  function demoOf(id) { return demos[id] || (demos[id] = VC.styles.demo(id)); }
  let pickerT0 = 0;
  function openPicker() {
    S.picker = true;
    pause();
    const el = $("style-picker");
    el.classList.remove("hidden");
    el.innerHTML = `<div class="picker-body">
      <div class="row" style="align-items:flex-start"><div><h2>本編の種類</h2><p class="lead">画面収録を編集するか、スライドだけで作るか。後から変えられます（どちらのデータも消えません）。</p></div><span class="spacer"></span><button class="btn" data-action="picker-close">閉じる</button></div>
      <div class="body-cards">
        <div class="body-card ${!isSlides() ? "current" : ""}" data-action="body-choose" data-body="clips"><span class="ico">📹</span><div><h4>画面収録 ${!isSlides() ? `<span class="chip">現在</span>` : ""}</h4><p>画面収録を追加して、再生バーで字幕・倍速・カット。説明は埋め込みスライドとして挿入。</p></div></div>
        <div class="body-card ${isSlides() ? "current" : ""}" data-action="body-choose" data-body="slides"><span class="ico">💬</span><div><h4>スライドだけ ${isSlides() ? `<span class="chip">現在</span>` : ""}</h4><p>文字・画像・動画・モンタージュのページを並べて1本の動画に。OP → スライド → ED。</p></div></div>
      </div>
      <h2 style="font-size:18px">OP / ED の型</h2><p class="lead">OPとEDが自動で流れます。クリックで選択。後からオープニング／エンディングのタブで変えられます。</p>
      <div class="style-cards">${VC.styles.list.map((st) => `
        <div class="style-card ${st.id === P.style ? "current" : ""}" data-action="style-choose" data-id="${st.id}">
          <div class="pv"><div><div class="lbl">オープニング</div><canvas data-pv="op" data-style="${st.id}" width="480" height="270"></canvas></div><div><div class="lbl">エンディング</div><canvas data-pv="ed" data-style="${st.id}" width="480" height="270"></canvas></div></div>
          <h4>${esc(st.name)} ${st.id === P.style ? `<span class="chip">現在の型</span>` : ""}</h4><p>${esc(st.desc)}</p>
          <div class="small" style="margin-top:6px"><span class="sw" style="background:${st.colors.bg}"></span>背景　<span class="sw" style="background:${st.colors.fg}"></span>文字（既定）</div>
        </div>`).join("")}</div></div>`;
    pickerT0 = performance.now();
    requestAnimationFrame(pickerLoop);
  }
  function closePicker() { S.picker = false; $("style-picker").classList.add("hidden"); $("style-picker").innerHTML = ""; }
  function pickerLoop(now) {
    if (!S.picker) return;
    requestAnimationFrame(pickerLoop);
    const t0 = (now - pickerT0) / 1000;
    for (const cv of $("style-picker").querySelectorAll("canvas[data-pv]")) {
      const D = demoOf(cv.dataset.style);
      const c = cv.getContext("2d"), W = cv.width, H = cv.height;
      const opD = VC.opening.duration(D), edD = VC.ending.duration(D);
      const drawMain = (cc, w, h) => { cc.fillStyle = "#1f2937"; cc.fillRect(0, 0, w, h); cc.fillStyle = "rgba(255,255,255,.5)"; cc.font = `700 ${Math.round(h * 0.1)}px ${VC.text.FONTS.sans}`; cc.textAlign = "center"; cc.textBaseline = "middle"; cc.fillText("DEMO", w / 2, h / 2); };
      if (cv.dataset.pv === "op") {
        const t = t0 % (opD + 1.0);
        if (t < opD) { const k = VC.opening.transitionK(D, t); if (k != null) VC.opening.drawTransition(c, W, H, k, D, drawMain); else VC.opening.draw(c, W, H, t, D, {}); }
        else drawMain(c, W, H);
      } else {
        const t = t0 % (edD + 1.0);
        VC.ending.draw(c, W, H, t < edD ? t : edD - 0.001, D);
      }
    }
  }
  function chooseStyle(id) {
    const st = VC.styles.get(id);
    if (st.id !== P.style) { P.style = st.id; P.colors = VC.styles.defaultColors(st.id); VC.opening._cache = null; save(); toast(`型を「${st.name}」にしました`); }
    closePicker();
    renderPanel(); renderTimeline(); setT(0, { pause: true });
  }

  // ---------- export ----------
  async function doExport() {
    if (S.exporting) return;
    if (S.fs) closeFs();
    if (S.mode !== "project") exitMode();
    if (S.place) finishPlace(false);
    const inf = R.info(P);
    if (inf.total <= 0) { toast("書き出す内容がありません"); return; }
    pause();
    applyCanvasSize();
    S.exporting = true; S.cancelExport = false;
    const ov = $("export-overlay");
    ov.classList.remove("hidden");
    const setOv = (p, text) => { ov.innerHTML = `<div style="font-weight:700;font-size:16px">書き出し中… ${Math.round(p * 100)}%</div><div class="bar"><div style="width:${p * 100}%"></div></div><div class="small" style="color:#cbd5e1">${esc(text || "")}</div><button class="btn btn-sm" data-action="export-cancel">キャンセル</button>`; };
    setOv(0, "準備中…");
    try {
      const fps = Number(P.output.fps) || 30;
      const res = await VC.exporter.run({ canvas, P, runtime, fps, onProgress: setOv, isCancelled: () => S.cancelExport });
      if (res) {
        const name = (P.output.name || "demo").replace(/[\\/:*?"<>|]+/g, "_");
        VC.exporter.download(res.blob, `${name}.${res.ext}`);
        toast(`書き出し完了：${name}.${res.ext}（${(res.blob.size / 1048576).toFixed(1)} MB）`);
      } else toast("書き出しをキャンセルしました");
    } catch (e) { console.error(e); toast(`書き出しに失敗：${e.message}`); }
    S.exporting = false;
    ov.classList.add("hidden");
    setT(0, { pause: true });
  }

  // ---------- binding ----------
  function setPath(path, value) {
    const ks = path.split(".");
    let o = P;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]];
    o[ks[ks.length - 1]] = value;
  }
  function updateRangeLabel(el, v) {
    if (el.type !== "range") return;
    const lab = el.previousElementSibling && el.previousElementSibling.querySelector(".small");
    if (lab) lab.textContent = `${v}${lab.textContent.replace(/^[\d.\-]+/, "")}`;
  }
  function onBind(el, commit) {
    const path = el.dataset.bind;
    if (!path) return;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "range" || el.type === "number") v = Number(el.value);
    else v = el.value;
    if (path.startsWith("__page.")) { const pg = fsPage(); if (!pg) return; pg[path.slice(7)] = v; save(); updateRangeLabel(el, v); return; }
    if (path.startsWith("__g.")) { const g = fsGroup(); if (!g) return; g[path.slice(4)] = v; save(); updateRangeLabel(el, v); return; }
    if (path === "opening.words") v = String(v).split(/[\s,、]+/).filter(Boolean);
    if (path === "opening.sentences") v = String(v).split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (path === "output.fps") v = Number(v);
    setPath(path, v);
    if (path.startsWith("opening.")) VC.opening._cache = null;
    if (path === "output.size") applyCanvasSize();
    save();
    updateRangeLabel(el, v);
    const inf = info();
    if (S.T > inf.total) S.T = inf.total;
    if (commit) renderPanel();
    updateHUD();
  }

  // ---------- events ----------
  document.addEventListener("mousedown", (e) => { if (e.target.closest("[data-keepfocus]")) e.preventDefault(); });
  document.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.bind) { onBind(el, false); return; }
    if (el.dataset && el.dataset.slideHtml) { slideHtmlInput(el); return; }
    if (el.dataset && el.dataset.fs === "name") { const d = fsDeck(); if (d) { d.name = el.value; save(); } return; }
    if (el.dataset && el.dataset.sb) {
      const pg = fsPage(); if (!pg) return;
      if (el.dataset.sb === "bg" || el.dataset.sb === "fg") {
        pg[el.dataset.sb] = el.value;
        const ed = $("fs-editor"); if (ed) ed.style[el.dataset.sb === "bg" ? "background" : "color"] = el.value;
        save(); renderFsBg(); drawFsText();
      }
    }
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.bind) { onBind(el, el.type !== "range"); return; }
    if (el.dataset && el.dataset.fscmd === "fontSize") { if (el.value) execCmd("fontSize", el.value); el.value = ""; return; }
    if (el.dataset && el.dataset.sb === "pos") { const pg = fsPage(); if (pg) { pg.pos = el.value; save(); const ed = $("fs-editor"); if (ed) ed.className = ed.className.replace(/pos-\w+/, `pos-${pg.pos}`); drawFsText(); renderFsPages(); } return; }
    if (el.dataset && el.dataset.sb) { const pg = fsPage(); if (pg) renderFsPages(); return; }
    if (el.id === "file-video") { addVideoFiles(el.files, S.fileTarget); S.fileTarget = { kind: "clip" }; el.value = ""; }
    if (el.id === "file-image") { addImageFiles(el.files, S.imgTarget); S.imgTarget = { kind: "opening" }; el.value = ""; }
    if (el.id === "file-backup") { if (el.files && el.files[0]) importProjectFile(el.files[0]); el.value = ""; }
    if (el.id === "pull-proj") { S.pullProj = el.value || null; renderPanel(); }
  });

  document.addEventListener("click", async (e) => {
    const cmdEl = e.target.closest("[data-cmd]");
    if (cmdEl) { execCmd(cmdEl.dataset.cmd, cmdEl.dataset.arg); return; }
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const a = el.dataset.action, id = el.dataset.id, i = Number(el.dataset.i);
    const d = fsDeck(), pg = fsPage();
    switch (a) {
      case "add-videos": S.fileTarget = { kind: "clip" }; $("file-video").click(); break;
      case "add-images": S.imgTarget = { kind: "opening" }; $("file-image").click(); break;
      case "del-image": P.opening.images = P.opening.images.filter((im) => im.id !== id); delete runtime.images[id]; store.delBlob(id); VC.opening._cache = null; save(); renderPanel(); break;
      case "clear-images": {
        if (!confirm("モンタージュ画像を全て削除しますか？")) break;
        for (const im of P.opening.images) { delete runtime.images[im.id]; store.delBlob(im.id); }
        P.opening.images = []; VC.opening._cache = null; save(); renderPanel(); break;
      }
      case "clip-up": case "clip-down": {
        const j = a === "clip-up" ? i - 1 : i + 1;
        if (j < 0 || j >= P.clips.length) break;
        const old = P.clips.slice(), arr = P.clips.slice(); [arr[i], arr[j]] = [arr[j], arr[i]];
        P.ranges = TL.remapRanges(P.ranges, old, arr); P.clips = arr;
        save(); renderPanel(); renderTimeline(); setT(0, { pause: true }); break;
      }
      case "clip-del": {
        const c = P.clips[i];
        if (!c || !confirm(`「${c.name}」を削除しますか？（この区間の字幕・倍速・カットも消えます）`)) break;
        const old = P.clips.slice(), arr = P.clips.filter((_, k) => k !== i);
        P.ranges = TL.remapRanges(P.ranges, old, arr); P.clips = arr;
        if (S.active === runtime.videos[c.id]) S.active = null;
        delete runtime.videos[c.id]; store.delBlob(c.id);
        save(); renderPanel(); renderTimeline(); setT(0, { pause: true }); break;
      }
      case "preview-opening": if (S.mode !== "project") exitMode(); setT(0, { pause: true }); if (P.opening.enabled) play(); else toast("オープニングが無効です"); break;
      case "preview-ending": { if (S.mode !== "project") exitMode(); const inf = R.info(P); setT(inf.opDur + inf.mainDur, { pause: true }); if (P.ending.enabled) play(); else toast("エンディングが無効です"); break; }
      case "export": doExport(); break;
      case "export-cancel": S.cancelExport = true; break;
      case "wipe": { if (!confirm("全プロジェクトのクリップ・画像・設定をすべて削除します。よろしいですか？")) break; await store.clearAll(); location.reload(); break; }
      case "media-retry": {
        toast("再読み込み中…");
        await restoreMedia();
        S.storage = await store.estimate();
        renderPanel(); renderTimeline(); if (S.fs) renderFs();
        if (!Object.keys(runtime.missing).length) toast("すべて読み込めました");
        break;
      }
      case "media-reattach":
        if (el.dataset.kind === "video") { S.fileTarget = { kind: "reattach", id }; $("file-video").click(); }
        else { S.imgTarget = { kind: "reattach", id }; $("file-image").click(); }
        break;
      case "export-project": exportProjectFile(); break;
      case "storage-recheck":
        S.persisted = await store.persist();
        S.storage = await store.estimate();
        renderStorageBanner(); renderPanel();
        toast(S.persisted ? "🔒 保護されています" : "まだ保護されていません。インストールかブックマークをしてから再確認してください");
        break;
      case "proj-switch": await switchProject(id); break;
      case "proj-new": await newProject(); break;
      case "proj-close": e.stopPropagation(); await closeProject(id); break;
      case "open-picker": openPicker(); break;
      case "picker-close": closePicker(); break;
      case "body-choose": {
        const kind = el.dataset.body;
        closePicker();
        setBody(kind);
        if (kind === "slides" && isSlides()) openFs(ensureMainDeck().id);
        break;
      }
      case "main-deck-open": if (S.mode !== "project") exitMode(); openFs(ensureMainDeck().id); break;
      case "style-choose": chooseStyle(id); break;
      case "colors-reset": P.colors = VC.styles.defaultColors(P.style); save(); renderPanel(); toast("色・フォントを既定に戻しました"); break;
      case "mode-exit": exitMode(); break;

      // ranges / popover
      case "range-jump": { const r = ctxRanges().find((x) => x.id === id); if (r) doSeek(r.start); break; }
      case "range-edit": { const r = ctxRanges().find((x) => x.id === id); if (r) openPopover(r, false); break; }
      case "range-del": deleteRange(id); break;
      case "pop-close": closePopover(); break;
      case "pop-back": S.pop.r.type = null; renderPopover(); break;
      case "pop-type": S.pop.r.type = el.dataset.type; if (el.dataset.type === "speed") S.pop.r.rate = S.pop.r.rate || 2; if (el.dataset.type === "caption") S.pop.r.color = S.pop.r.color || CAP_COLORS[0]; renderPopover(); break;
      case "pop-color": S.pop.r.color = el.dataset.color; S.pop.r.text = val("pop-text"); renderPopover(); break;
      case "pop-rate": S.pop.r.rate = Number(el.dataset.rate); renderPopover(); break;
      case "pop-delete": { const rid = S.pop.r.id; closePopover(); deleteRange(rid); toast("削除しました"); break; }
      case "pop-save": savePopover(); break;

      // inserts（メイン側）
      case "ins-new": { const x = INS.newDeck(); P.inserts.push(x); save(); renderPanel(); openFs(x.id); break; }
      case "ins-open": case "ins-marker": if (deckById(id)) openFs(id); break;
      case "ins-preview": previewIns(id); break;
      case "ins-place": startPlace(id); break;
      case "ins-unplace": { const x = deckById(id); if (x) { x.at = null; save(); renderPanel(); renderTimeline(); setT(Math.min(S.T, info().total), { pause: true }); toast("配置を外しました（埋め込み自体は残ります）"); } break; }
      case "ins-del": deleteDeck(id); break;
      case "ins-rename": renameDeck(id); break;
      case "ins-copy-toggle": S.copyIns = S.copyIns === id ? null : id; S.mergeIns = null; renderPanel(); break;
      case "ins-copy-run": await copyDeckTo(id, val("ins-copy-target") || P.id); break;
      case "ins-merge-toggle": S.mergeIns = S.mergeIns === id ? null : id; S.copyIns = null; renderPanel(); break;
      case "ins-merge-run": { const sid = val("ins-merge-src"); if (!sid) { toast("繋げる埋め込みを選んでください"); break; } await mergeDecks(id, sid, el.dataset.keep === "1"); break; }
      case "ins-make-main": makeMain(id); break;
      case "pull-run": await pullDeckFrom(el.dataset.pid, id); break;
      case "place-end": S.placeAt = R.info(P).srcTotal; renderModeBar(); renderTimeline(); break;
      case "place-ok": finishPlace(true); break;
      case "place-cancel": finishPlace(false); break;

      // fullscreen editor
      case "fs-close": closeFs(); break;
      case "fs-page-select": if (S.fs) { fsStop(); S.fs.pageId = id; S.fs.selImg = null; S.fs.crop = false; S.fs.scrubSrc = null; if (S.pop) closePopover(); renderFs(); } break;
      case "fs-page-add": { if (!d) break; const np = INS.newPage("slide"); const k = d.pages.findIndex((x) => x.id === S.fs.pageId); d.pages.splice(k + 1, 0, np); S.fs.pageId = np.id; S.fs.selImg = null; save(); renderFs(); break; }
      case "fs-page-dup": {
        if (!d) break;
        const src = d.pages.find((x) => x.id === id); if (!src) break;
        const cp = JSON.parse(JSON.stringify(src)); cp.id = store.uid("s"); cp.video = null; cp.ranges = []; cp.images = []; cp.kind = "slide"; cp.group = null;
        d.pages.splice(d.pages.indexOf(src) + 1, 0, cp); S.fs.pageId = cp.id; save(); renderFs(); toast("文字と色を複製しました（動画・画像は含みません）"); break;
      }
      case "fs-page-move": {
        if (!d) break;
        const k = d.pages.findIndex((x) => x.id === id), j = k + Number(el.dataset.d);
        if (k === -1 || j < 0 || j >= d.pages.length) break;
        [d.pages[k], d.pages[j]] = [d.pages[j], d.pages[k]];
        save(); renderFs(); break;
      }
      case "fs-page-del": {
        if (!d) break;
        const x = d.pages.find((p) => p.id === id); if (!x) break;
        if (d.pages.length <= 1) { toast("最後のページは削除できません"); break; }
        if (!confirm("このページを削除しますか？")) break;
        if (x.video) { delete runtime.videos[x.video.id]; store.delBlob(x.video.id); }
        for (const im of x.images) { delete runtime.images[im.id]; store.delBlob(im.id); }
        d.pages = d.pages.filter((p) => p.id !== id);
        if (x.group && !d.pages.some((p) => p.group === x.group)) delete d.groups[x.group];
        if (S.fs.pageId === id) S.fs.pageId = d.pages[0].id;
        save(); renderFs(); break;
      }
      case "fs-align": if (pg) { pg.align = el.dataset.al; save(); renderFs(); } break;
      case "slide-colors-reset": if (pg) { pg.bg = null; pg.fg = null; save(); renderFs(); } break;
      case "fs-img-add": if (d && pg) { S.imgTarget = { kind: "page", deckId: d.id, pageId: pg.id }; $("file-image").click(); } break;
      case "fs-video-add": if (d && pg) { S.fileTarget = { kind: "page", deckId: d.id, pageId: pg.id }; $("file-video").click(); } break;
      case "fs-video-remove": {
        if (!pg || !pg.video) break;
        delete runtime.videos[pg.video.id]; store.delBlob(pg.video.id);
        pg.video = null; pg.ranges = [];
        if (pg.kind === "montage") { pg.kind = "slide"; if (!d.pages.some((p) => p.group === pg.group)) delete d.groups[pg.group]; pg.group = null; }
        save(); renderFs(); break;
      }
      case "fs-montage-new": if (d) { S.fileTarget = { kind: "montage-new", deckId: d.id }; $("file-video").click(); } break;
      case "fs-montage-add": e.stopPropagation(); if (d) { S.fileTarget = { kind: "montage-add", deckId: d.id, gid: el.dataset.gid }; $("file-video").click(); } break;
      case "fs-use-reset": if (pg && pg.video) { pg.video.start = 0; pg.video.end = null; save(); renderFs(); } break;
      case "fs-crop": if (S.fs && S.fs.selImg) { S.fs.crop = !S.fs.crop; renderFs(); } break;
      case "fs-img-del": fsDeleteImage(id); break;
      case "fs-play-page": if (S.fs) fsPlay("page"); break;
      case "fs-play-deck": if (S.fs) fsPlay("deck"); break;
      case "fs-stop": fsStop(); break;
      default: break;
    }
  });

  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
  $("btn-export-tab").addEventListener("click", () => setTab("export"));
  $("proj-tabs").addEventListener("dblclick", (e) => { const t = e.target.closest(".proj-tab[data-id]"); if (t) renameProject(t.dataset.id); });
  $("btn-play").addEventListener("click", () => (S.playing ? pause() : play()));
  $("btn-start").addEventListener("click", () => setT(0, { pause: true }));
  $("tl-open").addEventListener("click", () => { if (S.mode !== "project") exitMode(); setT(0, { pause: true }); });
  $("tl-end").addEventListener("click", () => { if (S.mode !== "project") exitMode(); const inf = R.info(P); setT(inf.opDur + inf.mainDur, { pause: true }); });
  bindTrack($("tl-track"));
  $("tl-inserts").addEventListener("pointerdown", (e) => { if (e.target.closest(".tl-ins")) e.stopPropagation(); });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    if (S.fs) {
      if (e.key === "Escape") { if (S.pop) closePopover(); else if (S.fs.play) fsStop(); else if (S.fs.crop) { S.fs.crop = false; renderFs(); } else closeFs(); return; }
      if (e.code === "Space") { e.preventDefault(); S.fs.play ? fsStop() : fsPlay("page"); return; }
      if ((e.key === "Delete" || e.key === "Backspace") && S.fs.selImg) { e.preventDefault(); fsDeleteImage(S.fs.selImg); }
      return;
    }
    if (e.code === "Space") { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.key === "ArrowLeft") setT(S.T - (e.shiftKey ? 5 : 1), { pause: true });
    if (e.key === "ArrowRight") setT(S.T + (e.shiftKey ? 5 : 1), { pause: true });
    if (e.key === "Home") setT(0, { pause: true });
    if (e.key === "Escape" && S.picker) { closePicker(); return; }
    if (e.key === "Escape" && S.place) { finishPlace(false); return; }
    if (e.key === "Escape" && S.pop) closePopover();
    if ((e.key === "Delete" || e.key === "Backspace") && S.pop && !S.pop.isNew) { const rid = S.pop.r.id; closePopover(); deleteRange(rid); }
  });

  const wrap = $("canvas-wrap");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove("dragover"); }));
  document.addEventListener("drop", (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    const imgs = files.filter((f) => /^image\//.test(f.type));
    const vids = files.filter((f) => !/^image\//.test(f.type));
    if (imgs.length) addImageFiles(imgs, imageTarget());
    if (vids.length) {
      if (S.fs && fsDeck()) addVideoFiles(vids, vids.length > 1 ? { kind: "montage-new", deckId: S.fs.deckId } : { kind: "page", deckId: S.fs.deckId, pageId: fsPage().id });
      else addVideoFiles(vids, { kind: "clip" });
    }
  });
  document.addEventListener("paste", (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const files = items.filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    addImageFiles(files, imageTarget());
  });

  // ---------- boot ----------
  (async () => {
    applyCanvasSize();
    renderProjTabs();
    setTab(P.clips.length ? "clips" : "opening");
    renderTimeline(); renderModeBar();
    updateHUD();
    requestAnimationFrame(tick);
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
    S.persisted = await store.persist();
    S.storage = await store.estimate();
    renderStorageBanner();
    await restoreMedia();
    renderPanel(); renderTimeline(); setT(0, { pause: true });
    const sz = sizeOf();
    S.mp4ok = await VC.exporter.canMp4(sz.w, sz.h, Number(P.output.fps) || 30);
    if (S.tab === "export") renderPanel();
    if (S.mp4ok === false) toast("mp4書き出しには Chrome が必要です（他ブラウザは webm）");
  })();
})();
