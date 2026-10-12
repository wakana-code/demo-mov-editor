(function () {
  const { store, runtime } = VC;
  const TL = VC.timeline, R = VC.render;
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
    drag: null, sel: null, scrubSrc: null, pop: null, selectedRange: null,
    exporting: false, cancelExport: false, lastDown: 0, lastDownX: 0, mp4ok: null,
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
      output: Object.assign({ size: "1920x1080", fps: 30, name: "demo", sting: 0.1 }, saved.output || {}),
      cutFx: Object.assign({ type: "whip", dur: 0.3 }, saved.cutFx || {}),
      style: VC.styles.get(saved.style).id,
    };
    p.colors = Object.assign(VC.styles.defaultColors(p.style), saved.colors || {});
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

  // ---------- プロジェクトのタブ ----------
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
    if (S.pop) closePopover();
    P = normalizeProject(next);
    store.setCurrentId(P.id);
    S.T = 0; S.active = null; S.scrubSrc = null; S.selectedRange = null;
    VC.opening._cache = null; R.snaps = {};
    applyCanvasSize();
    renderProjTabs(); renderTimeline(); renderPanel();
    await restoreMedia();
    setTab(P.clips.length ? "clips" : "opening");
    renderTimeline(); setT(0, { pause: true });
  }
  async function newProject() {
    flushSave();
    const shell = store.newShell();
    const p = normalizeProject(shell);
    store.saveProject(p);
    await switchProject(p.id);
    toast(`「${p.name}」を作成しました（ダブルクリックで名前変更）`);
    openPicker();
  }
  async function closeProject(id) {
    const p = store.getProject(id);
    if (!p) return;
    if (!confirm(`「${p.name}」を削除しますか？（クリップ・画像・設定が消えます）`)) return;
    for (const c of p.clips || []) { delete runtime.videos[c.id]; store.delBlob(c.id); }
    for (const im of (p.opening && p.opening.images) || []) { delete runtime.images[im.id]; store.delBlob(im.id); }
    store.deleteProject(id);
    if (id === P.id) {
      const rest = store.list();
      if (rest.length) { P = { id: null }; await switchProject(rest[0].id); }
      else { P = normalizeProject(store.newShell("動画 1")); store.saveProject(P); store.setCurrentId(P.id); S.T = 0; S.active = null; renderProjTabs(); renderTimeline(); setTab("opening"); setT(0, { pause: true }); }
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

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg; el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function sizeOf() { return SIZES.find((s) => s.k === P.output.size) || SIZES[0]; }

  function applyCanvasSize() {
    const sz = sizeOf();
    if (canvas.width !== sz.w || canvas.height !== sz.h) { canvas.width = sz.w; canvas.height = sz.h; }
    const wrap = $("canvas-wrap");
    wrap.classList.toggle("v", sz.h > sz.w);
    wrap.classList.toggle("sq", sz.h === sz.w);
  }

  // ---------- media loading ----------
  function loadVideoEl(blob) {
    return new Promise((res, rej) => {
      const v = document.createElement("video");
      v.muted = true; v.playsInline = true; v.preload = "auto";
      v.src = URL.createObjectURL(blob);
      const fail = () => rej(new Error("この動画はブラウザで再生できません（HEVC収録の可能性）。QuickTimeで「書き出す → 1080p」してから追加してください"));
      v.onerror = fail;
      v.onloadedmetadata = () => {
        if (!isFinite(v.duration) || v.duration === 0) {
          const onDur = () => { if (isFinite(v.duration) && v.duration > 0) { v.removeEventListener("durationchange", onDur); v.currentTime = 0; res(v); } };
          v.addEventListener("durationchange", onDur);
          v.currentTime = 1e8;
          setTimeout(() => { if (!isFinite(v.duration)) fail(); }, 4000);
        } else res(v);
      };
    });
  }
  function loadImageEl(blob) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("画像を読み込めません"));
      img.src = URL.createObjectURL(blob);
    });
  }
  async function restoreMedia() {
    const keepClips = [];
    for (const c of P.clips) {
      if (runtime.videos[c.id]) { keepClips.push(c); continue; }
      try {
        const b = await store.getBlob(c.id);
        if (!b) continue;
        const v = await loadVideoEl(b);
        runtime.videos[c.id] = v;
        c.duration = v.duration; c.width = v.videoWidth; c.height = v.videoHeight;
        keepClips.push(c);
      } catch (e) { console.warn(e); }
    }
    if (keepClips.length !== P.clips.length) { P.ranges = TL.remapRanges(P.ranges, P.clips, keepClips); P.clips = keepClips; save(); }
    const keepImgs = [];
    for (const im of P.opening.images) {
      if (runtime.images[im.id]) { keepImgs.push(im); continue; }
      try {
        const b = await store.getBlob(im.id);
        if (!b) continue;
        runtime.images[im.id] = await loadImageEl(b);
        keepImgs.push(im);
      } catch (e) { console.warn(e); }
    }
    if (keepImgs.length !== P.opening.images.length) { P.opening.images = keepImgs; save(); }
  }

  async function addVideoFiles(files) {
    files = [...files].filter((f) => /video|\.mov$|\.mp4$|\.webm$|\.m4v$/i.test(f.type + f.name));
    if (!files.length) { toast("動画ファイルを選んでください"); return; }
    let n = 0;
    for (const f of files) {
      try {
        const id = store.uid("v");
        await store.putBlob(id, f);
        const v = await loadVideoEl(f);
        runtime.videos[id] = v;
        P.clips.push({ id, name: f.name.replace(/\.[^.]+$/, ""), duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        n++;
      } catch (e) { toast(`${f.name}: ${e.message}`); }
    }
    if (n) { save(); toast(`${n}本のクリップを追加しました`); if (S.tab !== "clips") setTab("clips"); else renderPanel(); renderTimeline(); }
  }
  async function addImageFiles(files) {
    files = [...files].filter((f) => /^image\//.test(f.type));
    if (!files.length) { toast("画像ファイルを選んでください"); return; }
    for (const f of files) {
      try {
        const id = store.uid("i");
        await store.putBlob(id, f);
        runtime.images[id] = await loadImageEl(f);
        P.opening.images.push({ id, name: f.name || "pasted" });
      } catch (e) { toast(e.message); }
    }
    VC.opening._cache = null;
    save(); renderPanel();
    toast(`画像を${files.length}枚追加しました`);
  }

  // ---------- playback ----------
  function info() { return R.info(P); }

  function setT(t, opts) {
    opts = opts || {};
    const inf = info();
    S.T = Math.max(0, Math.min(inf.total, t));
    S.scrubSrc = null;
    if (opts.pause) pause();
    syncVideoToT(true);
    updateHUD();
  }
  function seekSrc(src) {
    const inf = info();
    if (!P.clips.length) return;
    src = Math.max(0, Math.min(inf.srcTotal - 1e-3, src));
    pause();
    S.T = inf.opDur + TL.srcToOut(inf.segs, src);
    S.scrubSrc = src;
    const ca = TL.clipAt(P.clips, src);
    if (ca) {
      const v = runtime.videos[ca.clip.id];
      if (v) { switchActive(v, ca.local, false); }
    }
    updateHUD();
  }
  function switchActive(v, local, play) {
    if (S.active && S.active !== v) { try { S.active.pause(); } catch (e) {} }
    S.active = v;
    if (Math.abs(v.currentTime - local) > 0.08) v.currentTime = local;
    if (play && v.paused) v.play().catch(() => {});
  }
  function syncVideoToT(force) {
    const loc = R.locate(P, S.T);
    if (loc.phase === "opening" && loc.trans != null && loc.clip) {
      // トランジション中：本編の最初のフレームを止めたまま表示
      const tv = runtime.videos[loc.clip.id];
      if (tv) { if (S.active && S.active !== tv) { try { S.active.pause(); } catch (e) {} } S.active = tv; tv.pause(); if (Math.abs(tv.currentTime - loc.clipLocal) > 0.05) tv.currentTime = loc.clipLocal; }
      return loc;
    }
    if (loc.phase !== "main" || !loc.clip) { if (S.active) { S.active.pause(); } return loc; }
    const v = runtime.videos[loc.clip.id];
    if (!v) return loc;
    if (S.active !== v || force || Math.abs(v.currentTime - loc.clipLocal) > 0.3) switchActive(v, loc.clipLocal, S.playing);
    try { v.playbackRate = Math.min(16, loc.seg ? loc.seg.rate : 1); } catch (e) {}
    if (S.playing && v.paused && !v.ended) v.play().catch(() => {});
    return loc;
  }
  function play() {
    const inf = info();
    if (inf.total <= 0) { toast("クリップを追加するか、オープニングを有効にしてください"); return; }
    if (S.T >= inf.total - 0.02) S.T = 0;
    S.scrubSrc = null;
    S.playing = true;
    S.lastTick = performance.now();
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
    if (S.exporting) return;
    const dt = Math.min(0.1, (now - (S.lastTick || now)) / 1000);
    S.lastTick = now;
    const inf = info();
    let loc = R.locate(P, S.T, inf);
    if (S.playing) {
      if (loc.phase === "main" && loc.clip && loc.seg) {
        const v = syncVideoToT(false);
        const vid = runtime.videos[loc.clip.id];
        const off = TL.clipOffset(P.clips, P.clips.indexOf(loc.clip));
        const vsrc = off + vid.currentTime;
        if (vid.ended || vsrc >= loc.seg.end - 0.02) S.T = inf.opDur + loc.seg.outEnd + 0.001;
        else if (vsrc >= loc.seg.start - 0.05) S.T = inf.opDur + loc.seg.outStart + (Math.max(loc.seg.start, vsrc) - loc.seg.start) / loc.seg.rate;
        else S.T += dt;
        if (S.T >= inf.opDur + inf.outDur) S.T = inf.opDur + inf.outDur;
      } else {
        S.T += dt;
        if (S.active) { S.active.pause(); }
      }
      if (S.T >= inf.total) { S.T = inf.total; pause(); }
      loc = R.locate(P, S.T, inf);
      if (loc.phase === "main") syncVideoToT(false);
    }
    const drawLoc = (S.scrubSrc != null && !S.playing) ? R.locateSrc(P, S.scrubSrc, inf) : loc;
    R.draw(ctx, canvas.width, canvas.height, drawLoc, P, runtime);
    updateHUD(inf, loc);
  }

  // ---------- HUD / timeline ----------
  function updateHUD(inf, loc) {
    inf = inf || info();
    loc = loc || R.locate(P, S.T, inf);
    $("time-label").textContent = `${TL.fmt(S.T)} / ${TL.fmt(inf.total)}`;
    const ph = $("phase-label");
    if (loc.phase === "opening") ph.textContent = "🎞 オープニング";
    else if (loc.phase === "ending") ph.textContent = "🔚 エンディング";
    else {
      const src = S.scrubSrc != null && !S.playing ? S.scrubSrc : loc.src;
      const bits = [`📹 ${loc.clip ? loc.clip.name : ""}`, `元 ${TL.fmtMs(src)}`];
      if (loc.seg && loc.seg.rate !== 1) bits.push(`×${loc.seg.rate}`);
      if (S.scrubSrc != null && TL.isCutAt(inf.segs, S.scrubSrc)) bits.push("カット区間");
      ph.textContent = bits.join("　");
    }
    $("tl-open").classList.toggle("active", loc.phase === "opening");
    $("tl-end").classList.toggle("active", loc.phase === "ending");
    $("tl-open").classList.toggle("off", !P.opening.enabled);
    $("tl-end").classList.toggle("off", !P.ending.enabled);
    const src = loc.phase === "main" ? (S.scrubSrc != null && !S.playing ? S.scrubSrc : loc.src) : loc.phase === "opening" ? 0 : inf.srcTotal;
    const pct = inf.srcTotal ? (src / inf.srcTotal) * 100 : 0;
    $("tl-playhead").style.left = `calc(${Math.max(0, Math.min(100, pct))}% - 1px)`;
    $("stage-empty").classList.toggle("hidden", P.clips.length > 0 || P.opening.enabled || P.ending.enabled);
  }

  function renderTimeline() {
    const inf = info();
    const total = inf.srcTotal || 1;
    $("tl-clips").innerHTML = P.clips.map((c) => `<div class="tl-clip" style="width:${(c.duration / total) * 100}%" title="${esc(c.name)}（${TL.fmt(c.duration)}）">${esc(c.name)}</div>`).join("");
    $("tl-ranges").innerHTML = P.ranges.map((r) => {
      const l = (r.start / total) * 100, w = Math.max(0.3, ((r.end - r.start) / total) * 100);
      const label = r.type === "caption" ? `💬 ${r.text || ""}` : r.type === "speed" ? `×${r.rate}` : `✂ ${cutFxLabel(r)}`;
      return `<div class="tl-range ${r.type} ${S.selectedRange === r.id ? "selected" : ""}" data-id="${r.id}" style="left:${l}%;width:${w}%" title="${esc(label)}">${esc(label)}</div>`;
    }).join("");
    $("range-list").innerHTML = P.ranges.length ? P.ranges.slice().sort((a, b) => a.start - b.start).map((r) => {
      const chip = r.type === "caption" ? `<span class="chip chip-cap">字幕</span>` : r.type === "speed" ? `<span class="chip chip-speed">×${r.rate}</span>` : `<span class="chip chip-cut">カット</span>`;
      const d = r.type === "caption" ? r.text : r.type === "speed" ? `${r.rate}倍速` : `この区間を飛ばす（演出: ${cutFxLabel(r)}）`;
      return `<div class="range-item"><span class="t">${TL.fmtMs(r.start)} – ${TL.fmtMs(r.end)}</span>${chip}<span class="d">${esc(d)}</span><button class="btn btn-sm" data-action="range-jump" data-id="${r.id}">▶</button><button class="btn btn-sm" data-action="range-edit" data-id="${r.id}">編集</button><button class="btn btn-sm btn-danger" data-action="range-del" data-id="${r.id}">✕</button></div>`;
    }).join("") : "";
    updateHUD(inf);
  }

  function posToSrc(e) {
    const rect = $("tl-track").getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return f * info().srcTotal;
  }
  function showSelection(a, b) {
    const total = info().srcTotal || 1;
    const el = $("tl-selection");
    if (a == null) { el.classList.add("hidden"); return; }
    const l = Math.min(a, b), r = Math.max(a, b);
    el.classList.remove("hidden");
    el.style.left = `${(l / total) * 100}%`;
    el.style.width = `${((r - l) / total) * 100}%`;
  }

  // ---------- range popover ----------
  function openPopover(range, isNew) {
    S.pop = { r: Object.assign({}, range), isNew };
    S.selectedRange = range.id;
    showSelection(range.start, range.end);
    renderPopover();
    renderTimeline();
  }
  function closePopover() {
    S.pop = null; S.selectedRange = null;
    $("range-popover").classList.add("hidden");
    showSelection(null);
    renderTimeline();
  }
  function renderPopover() {
    const pop = $("range-popover");
    const { r, isNew } = S.pop;
    pop.classList.remove("hidden");
    const rect = $("timeline").getBoundingClientRect(), st = $("stage").getBoundingClientRect();
    pop.style.top = `${rect.bottom - st.top + 28}px`;
    pop.style.left = `${Math.max(0, Math.min(st.width - 430, rect.left - st.left + 46))}px`;
    const head = `<h4>${isNew ? "この範囲に" : "範囲を編集"} <span class="small">${TL.fmtMs(r.start)} – ${TL.fmtMs(r.end)}（${(r.end - r.start).toFixed(1)}秒）</span><span class="spacer"></span><button class="btn btn-sm" data-action="pop-close">✕</button></h4>`;
    if (!r.type) {
      pop.innerHTML = head + `
        <div class="row">
          <button class="btn btn-cap" data-action="pop-type" data-type="caption">💬 字幕を入れる</button>
          <button class="btn btn-speed" data-action="pop-type" data-type="speed">⏩ 倍速にする</button>
          <button class="btn btn-cut" data-action="pop-type" data-type="cut">✂ カットする</button>
        </div>`;
      return;
    }
    let body = "";
    if (r.type === "caption") {
      body = `
        <div class="row"><textarea id="pop-text" placeholder="例：計画書を貼るだけでタスクに分解">${esc(r.text || "")}</textarea></div>
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
          </select></div>
        <div class="small">演出の長さはクリップタブの「カットの演出 → 長さ」が共通で使われます。</div>`;
    }
    pop.innerHTML = head + body + `
      <div class="row" style="margin-top:10px">
        ${isNew ? `<button class="btn btn-sm" data-action="pop-back">← 種類を選び直す</button>` : `<button class="btn btn-sm btn-danger" data-action="pop-delete">削除</button>`}
        <span class="spacer"></span>
        <button class="btn btn-sm" data-action="pop-close">キャンセル</button>
        <button class="btn btn-sm btn-primary" data-action="pop-save">保存</button>
      </div>`;
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
    const idx = P.ranges.findIndex((x) => x.id === r.id);
    if (idx === -1) P.ranges.push(r); else P.ranges[idx] = r;
    R.snaps = {};
    save();
    closePopover();
    toast(isNew ? "範囲を追加しました" : "範囲を更新しました");
  }
  function val(id) { const el = $(id); return el ? el.value : ""; }

  // ---------- side panel ----------
  function setTab(t) {
    S.tab = t;
    [...$("tabs").querySelectorAll("button")].forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    renderPanel();
  }
  function renderPanel() {
    const el = $("panel");
    if (S.tab === "opening") el.innerHTML = panelOpening2();
    else if (S.tab === "clips") el.innerHTML = panelClips();
    else if (S.tab === "ending") el.innerHTML = panelEnding2();
    else el.innerHTML = panelExport();
  }
  function num(label, path, v, min, max, step, unit) {
    return `<div class="field"><label>${label} <span class="small">${v}${unit || ""}</span></label><input type="range" data-bind="${path}" min="${min}" max="${max}" step="${step}" value="${v}"></div>`;
  }
  function panelOpening() {
    const o = P.opening;
    const need = VC.opening.neededCount(o);
    const have = o.images.length;
    const dur = VC.opening.duration(o);
    return `
      <h3>🎞 オープニング <label class="row" style="gap:6px;font-weight:400;font-size:12px"><input type="checkbox" data-bind="opening.enabled" ${o.enabled ? "checked" : ""}> 入れる</label></h3>
      <div class="small">合計 ${dur.toFixed(1)} 秒　<button class="btn btn-sm" data-action="preview-opening">▶ プレビュー</button></div>
      <div class="field"><label>最初に1文字ずつ出す単語（スペース区切り）</label><input type="text" data-bind="opening.words" value="${esc(o.words.join(" "))}" placeholder="you can now"></div>
      ${num("1単語の表示時間", "opening.wordDur", o.wordDur, 0.4, 2, 0.05, "秒")}
      <div class="field"><label>モンタージュ画像（${have}枚 / コマ数 ${need}）</label>
        <div class="row"><button class="btn btn-sm" data-action="add-images">＋ 画像を追加</button><span class="small">または Cmd+V で貼り付け</span><span class="spacer"></span>${have ? `<button class="btn btn-sm btn-danger" data-action="clear-images">全削除</button>` : ""}</div>
        ${have ? `<div class="thumbs" style="margin-top:6px">${o.images.map((im) => `<div class="thumb"><img src="${runtime.images[im.id] ? runtime.images[im.id].src : ""}" alt=""><button class="x" data-action="del-image" data-id="${im.id}">✕</button></div>`).join("")}</div>` : `<div class="drop" data-action="add-images">ここをクリック / ドロップ / Cmd+V で画像を追加<br><span class="small">無いときはカラーのプレースホルダーが出ます</span></div>`}
        <div class="note">${have && have < need ? `枚数がコマ数より少ないので、2周目以降はズーム・回転・反転・色味違いで水増しします。` : `最初ゆっくり → だんだん速く切り替わります。`}</div>
      </div>
      ${num("モンタージュの長さ", "opening.montageDur", o.montageDur, 1.5, 10, 0.1, "秒")}
      <div class="grid2">${num("最初の間隔", "opening.intervalStart", o.intervalStart, 0.1, 1, 0.01, "秒")}${num("最後の間隔", "opening.intervalEnd", o.intervalEnd, 0.03, 0.3, 0.005, "秒")}</div>
      ${num("加速の強さ", "opening.accel", o.accel, 1, 4, 0.1, "")}
      <div class="note">1＝一定のペースで速くなる　2＝標準　3〜4＝最初ゆっくりが長く続いて、最後に一気に加速（CMっぽい）。コマ数 ${need} はこの値で変わります。</div>
      ${num("一呼吸", "opening.pause", o.pause, 0, 1.5, 0.05, "秒")}
      <div class="field"><label>用途（最後にドーンと出す文章）</label><textarea data-bind="opening.purpose" placeholder="例：edit documents / 計画書を貼るだけでタスクに分解">${esc(o.purpose)}</textarea>
        <div class="small">${VC.opening.phrases(o.purpose).length ? `長いので ${VC.opening.phrases(o.purpose).length} フレーズに分けて出してから全文を表示します` : "短いのでそのままドーンと表示します"}</div></div>
      <div class="grid2">${num("1フレーズの時間", "opening.phraseDur", o.phraseDur, 0.2, 1.5, 0.05, "秒")}${num("全文の表示時間", "opening.finalHold", o.finalHold, 0.5, 4, 0.1, "秒")}</div>
      ${num("本編へのズームイン（パンチズーム）", "opening.transDur", o.transDur, 0, 1.2, 0.05, "秒")}
      <div class="note">用途の文字に一気にズームイン → 文字を突き抜けた先に本編の映像が現れます（白いフラッシュ付き）。0 にするとただの切り替えになります。</div>`;
  }
  function panelClips() {
    const total = TL.totalSource(P.clips);
    return `
      <h3>📹 クリップ（本編） <span class="small">${P.clips.length}本・${TL.fmt(total)}</span></h3>
      <div class="drop" data-action="add-videos" id="clip-drop">＋ 画面収録を追加（.mov / .mp4、複数可）<br><span class="small">ここにドラッグ＆ドロップでもOK</span></div>
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
      <div class="note">ここは「既定」の演出です。カットごとに変えたいときは、再生バーのカット範囲をクリック → 「切り替わりの演出」で個別に選べます。プレビューで一度その箇所を通過すると、前の映像も含めた完全な演出になります（書き出しでは常に完全）。</div>
      <div class="note">再生できない場合（HEVC収録など）は、QuickTime Player で「ファイル → 書き出す → 1080p」してから追加してください。Macの画面収録は標準で無音です。</div>`;
  }
  function panelEnding() {
    const e = P.ending;
    return `
      <h3>🔚 エンディング <label class="row" style="gap:6px;font-weight:400;font-size:12px"><input type="checkbox" data-bind="ending.enabled" ${e.enabled ? "checked" : ""}> 入れる</label></h3>
      <div class="small">合計 ${VC.ending.duration(e).toFixed(1)} 秒　<button class="btn btn-sm" data-action="preview-ending">▶ プレビュー</button></div>
      <div class="field"><label>アプリ名（タイピング風に出ます）</label><input type="text" data-bind="ending.text" value="${esc(e.text)}" placeholder="AI-PM"></div>
      <div class="field"><label>サブテキスト（任意）</label><input type="text" data-bind="ending.sub" value="${esc(e.sub)}" placeholder="例：計画書を貼るだけ。段取りは、AIの上司がやる。"></div>
      <div class="grid2">${num("1文字の速さ", "ending.charDur", e.charDur, 0.03, 0.25, 0.01, "秒")}${num("表示したままの時間", "ending.hold", e.hold, 0.5, 5, 0.1, "秒")}</div>`;
  }
  // ---------- 型・色（共通ブロック） ----------
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
  function panelOpening2() {
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
          <div class="small">タイプ → じわっと流れる → 一瞬で退場 → 次の文章、の順に出ます</div></div>
        <div class="grid3">${num("1文字の速さ", "opening.charDur", o.charDur, 0.02, 0.15, 0.005, "秒")}${num("じわっと流れる時間", "opening.holdDur", o.holdDur, 0.3, 2.5, 0.05, "秒")}${num("退場の速さ", "opening.exitDur", o.exitDur, 0.1, 0.6, 0.02, "秒")}</div>
        ${montageBlock(o)}
        ${num("最後の1枚で止める時間", "opening.lastHold", o.lastHold, 0, 2, 0.05, "秒")}
        <div class="note">モンタージュの最後の1枚で一瞬止まってから、本編に切り替わります。</div>`;
    }
    return head + `
      <div class="field"><label>最初に1文字ずつ出す単語（スペース区切り）</label><input type="text" data-bind="opening.words" value="${esc(o.words.join(" "))}" placeholder="you can now"></div>
      ${num("1単語の表示時間", "opening.wordDur", o.wordDur, 0.4, 2, 0.05, "秒")}
      ${montageBlock(o)}
      ${num("一呼吸", "opening.pause", o.pause, 0, 1.5, 0.05, "秒")}
      <div class="field"><label>用途（最後にドーンと出す文章）</label><textarea data-bind="opening.purpose" placeholder="例：edit documents / 計画書を貼るだけでタスクに分解">${esc(o.purpose)}</textarea>
        <div class="small">${VC.opening.phrases(o.purpose).length ? `長いので ${VC.opening.phrases(o.purpose).length} フレーズに分けて出してから全文を表示します` : "短いのでそのままドーンと表示します"}</div></div>
      <div class="grid2">${num("1フレーズの時間", "opening.phraseDur", o.phraseDur, 0.2, 1.5, 0.05, "秒")}${num("全文の表示時間", "opening.finalHold", o.finalHold, 0.5, 4, 0.1, "秒")}</div>
      ${num("本編へのズームイン（パンチズーム）", "opening.transDur", o.transDur, 0, 1.2, 0.05, "秒")}
      <div class="note">用途の文字に一気にズームイン → 文字を突き抜けた先に本編の映像が現れます。0 にするとただの切り替えになります。</div>`;
  }
  function panelEnding2() {
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

  // ---------- 型の選択画面（OP/EDを自動再生） ----------
  const demos = {};
  function demoOf(id) { return demos[id] || (demos[id] = VC.styles.demo(id)); }
  let pickerT0 = 0;
  function openPicker() {
    S.picker = true;
    const el = $("style-picker");
    el.classList.remove("hidden");
    el.innerHTML = `<div class="picker-body">
      <div class="row" style="align-items:flex-start"><div><h2>動画の型を選ぶ</h2><p class="lead">OPとEDが自動で流れます。クリックで選択。後からオープニング／エンディングのタブで変えられます。色・フォントも後から自由に変えられます。</p></div><span class="spacer"></span><button class="btn" data-action="picker-close">閉じる</button></div>
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
        if (t < edD) VC.ending.draw(c, W, H, t, D); else VC.ending.draw(c, W, H, edD - 0.001, D);
      }
    }
  }
  function chooseStyle(id) {
    const st = VC.styles.get(id);
    if (st.id !== P.style) {
      P.style = st.id;
      P.colors = VC.styles.defaultColors(st.id);
      VC.opening._cache = null;
      save();
      toast(`型を「${st.name}」にしました`);
    }
    closePicker();
    renderPanel(); renderTimeline(); setT(0, { pause: true });
  }

  function panelExport() {
    const inf = info();
    const sz = sizeOf();
    const mp4 = S.mp4ok;
    return `
      <h3>⬇ 書き出し</h3>
      <div class="field"><label>サイズ</label><select data-bind="output.size">${SIZES.map((s) => `<option value="${s.k}" ${s.k === P.output.size ? "selected" : ""}>${s.label}</option>`).join("")}</select></div>
      <div class="grid2">
        <div class="field"><label>フレームレート</label><select data-bind="output.fps"><option value="30" ${P.output.fps == 30 ? "selected" : ""}>30 fps</option><option value="24" ${P.output.fps == 24 ? "selected" : ""}>24 fps</option><option value="60" ${P.output.fps == 60 ? "selected" : ""}>60 fps</option></select></div>
        <div class="field"><label>ファイル名</label><input type="text" data-bind="output.name" value="${esc(P.output.name)}"></div>
      </div>
      ${num("先頭のタイトルカード（サムネ用）", "output.sting", P.output.sting, 0, 0.5, 0.02, "秒")}
      <div class="note">動画の一番最初に、アプリ名（エンディングの文字）をほんの一瞬だけ表示します。SNSのサムネイルがこれになります。0.1秒＝約3フレームで、再生中はほぼ気づきません。0 でオフ。</div>
      <div class="note">長さ ${TL.fmt(inf.total)}（タイトル ${inf.stingDur.toFixed(2)}s ＋ OP ${inf.openDur.toFixed(1)}s ＋ 本編 ${TL.fmt(inf.outDur)} ＋ ED ${inf.edDur.toFixed(1)}s）<br>${sz.w}×${sz.h}・${P.output.fps}fps・無音・${mp4 === false ? "webm" : "mp4 (H.264)"}</div>
      ${mp4 === false ? `<div class="warn">このブラウザは mp4 書き出しに対応していないため webm になります。X / LinkedIn に投稿するなら <b>Chrome</b> で書き出してください。</div>` : mp4 === true ? `<div class="small">✅ mp4（H.264）で書き出せます。X / LinkedIn にそのまま投稿できます。</div>` : `<div class="small">対応確認中…</div>`}
      <button class="btn btn-primary" data-action="export" ${inf.total <= 0 ? "disabled" : ""} style="height:40px">⬇ 動画を書き出す</button>
      <div class="note">1フレームずつ描いてエンコードするので、動画の長さの0.5〜1.5倍ほど時間がかかります。書き出し中はこのタブを閉じないでください。</div>
      <details><summary class="small" style="cursor:pointer">データを全部消す</summary><div class="row" style="margin-top:6px"><button class="btn btn-sm btn-danger" data-action="wipe">全プロジェクトのクリップ・画像・設定を削除</button></div></details>`;
  }

  // ---------- export ----------
  async function doExport() {
    if (S.exporting) return;
    const inf = info();
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
    } catch (e) {
      console.error(e);
      toast(`書き出しに失敗：${e.message}`);
    }
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
  function onBind(el, commit) {
    const path = el.dataset.bind;
    if (!path) return;
    let v;
    if (el.type === "checkbox") v = el.checked;
    else if (el.type === "range" || el.type === "number") v = Number(el.value);
    else v = el.value;
    if (path === "opening.words") v = String(v).split(/[\s,、]+/).filter(Boolean);
    if (path === "opening.sentences") v = String(v).split(/\n/).map((x) => x.trim()).filter(Boolean);
    if (path === "output.fps") v = Number(v);
    setPath(path, v);
    if (path.startsWith("opening.")) VC.opening._cache = null;
    if (path === "output.size") applyCanvasSize();
    save();
    if (el.type === "range") { const lab = el.previousElementSibling && el.previousElementSibling.querySelector(".small"); if (lab) lab.textContent = `${v}${lab.textContent.replace(/^[\d.\-]+/, "")}`; }
    const inf = info();
    if (S.T > inf.total) S.T = inf.total;
    if (commit) renderPanel();
    updateHUD();
  }

  // ---------- events ----------
  document.addEventListener("input", (e) => { if (e.target.dataset && e.target.dataset.bind) onBind(e.target, false); });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.bind) { onBind(el, el.type !== "range" && el.type !== "text" ? true : el.type === "text"); return; }
    if (el.id === "file-video") { addVideoFiles(el.files); el.value = ""; }
    if (el.id === "file-image") { addImageFiles(el.files); el.value = ""; }
  });

  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const a = el.dataset.action, id = el.dataset.id, i = Number(el.dataset.i);
    switch (a) {
      case "add-videos": $("file-video").click(); break;
      case "add-images": $("file-image").click(); break;
      case "del-image": {
        P.opening.images = P.opening.images.filter((im) => im.id !== id);
        delete runtime.images[id]; store.delBlob(id); VC.opening._cache = null; save(); renderPanel(); break;
      }
      case "clear-images": {
        if (!confirm("モンタージュ画像を全て削除しますか？")) break;
        for (const im of P.opening.images) { delete runtime.images[im.id]; store.delBlob(im.id); }
        P.opening.images = []; VC.opening._cache = null; save(); renderPanel(); break;
      }
      case "clip-up": case "clip-down": {
        const j = a === "clip-up" ? i - 1 : i + 1;
        if (j < 0 || j >= P.clips.length) break;
        const old = P.clips.slice();
        const arr = P.clips.slice(); [arr[i], arr[j]] = [arr[j], arr[i]];
        P.ranges = TL.remapRanges(P.ranges, old, arr); P.clips = arr;
        save(); renderPanel(); renderTimeline(); setT(0, { pause: true }); break;
      }
      case "clip-del": {
        const c = P.clips[i];
        if (!c || !confirm(`「${c.name}」を削除しますか？（この区間の字幕・倍速・カットも消えます）`)) break;
        const old = P.clips.slice();
        const arr = P.clips.filter((_, k) => k !== i);
        P.ranges = TL.remapRanges(P.ranges, old, arr); P.clips = arr;
        if (S.active === runtime.videos[c.id]) S.active = null;
        delete runtime.videos[c.id]; store.delBlob(c.id);
        save(); renderPanel(); renderTimeline(); setT(0, { pause: true }); break;
      }
      case "preview-opening": setT(0, { pause: true }); if (P.opening.enabled) play(); else toast("オープニングが無効です"); break;
      case "preview-ending": { const inf = info(); setT(inf.opDur + inf.outDur, { pause: true }); if (P.ending.enabled) play(); else toast("エンディングが無効です"); break; }
      case "export": doExport(); break;
      case "export-cancel": S.cancelExport = true; break;
      case "wipe": {
        if (!confirm("全プロジェクトのクリップ・画像・設定をすべて削除します。よろしいですか？")) break;
        await store.clearAll();
        location.reload(); break;
      }
      // project tabs
      case "proj-switch": await switchProject(id); break;
      // style picker / colors
      case "open-picker": openPicker(); break;
      case "picker-close": closePicker(); break;
      case "style-choose": chooseStyle(id); break;
      case "colors-reset": P.colors = VC.styles.defaultColors(P.style); save(); renderPanel(); toast("色・フォントを既定に戻しました"); break;
      case "proj-new": await newProject(); break;
      case "proj-close": e.stopPropagation(); await closeProject(id); break;
      // ranges
      case "range-jump": { const r = P.ranges.find((x) => x.id === id); if (r) { seekSrc(r.start); } break; }
      case "range-edit": { const r = P.ranges.find((x) => x.id === id); if (r) openPopover(r, false); break; }
      case "range-del": P.ranges = P.ranges.filter((x) => x.id !== id); save(); renderTimeline(); break;
      // popover
      case "pop-close": closePopover(); break;
      case "pop-back": S.pop.r.type = null; renderPopover(); break;
      case "pop-type": S.pop.r.type = el.dataset.type; if (el.dataset.type === "speed") S.pop.r.rate = S.pop.r.rate || 2; if (el.dataset.type === "caption") S.pop.r.color = S.pop.r.color || CAP_COLORS[0]; renderPopover(); break;
      case "pop-color": S.pop.r.color = el.dataset.color; S.pop.r.text = val("pop-text"); renderPopover(); break;
      case "pop-rate": S.pop.r.rate = Number(el.dataset.rate); renderPopover(); break;
      case "pop-delete": P.ranges = P.ranges.filter((x) => x.id !== S.pop.r.id); save(); closePopover(); toast("削除しました"); break;
      case "pop-save": savePopover(); break;
      default: break;
    }
  });

  $("tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) setTab(b.dataset.tab); });
  $("btn-export-tab").addEventListener("click", () => setTab("export"));
  $("proj-tabs").addEventListener("dblclick", (e) => { const t = e.target.closest(".proj-tab[data-id]"); if (t) renameProject(t.dataset.id); });
  $("btn-play").addEventListener("click", () => (S.playing ? pause() : play()));
  $("btn-start").addEventListener("click", () => setT(0, { pause: true }));
  $("tl-open").addEventListener("click", () => setT(0, { pause: true }));
  $("tl-end").addEventListener("click", () => { const inf = info(); setT(inf.opDur + inf.outDur, { pause: true }); });

  // timeline pointer: click = seek / drag = scrub, double-click + drag = range select
  const track = $("tl-track");
  track.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tl-range")) return;
    if (!P.clips.length) { toast("まずクリップを追加してください"); return; }
    const now = performance.now();
    const dbl = now - S.lastDown < 400 && Math.abs(e.clientX - S.lastDownX) < 10;
    S.lastDown = now; S.lastDownX = e.clientX;
    track.setPointerCapture(e.pointerId);
    const s = posToSrc(e);
    S.drag = dbl ? { mode: "select", a: s, b: s } : { mode: "scrub" };
    if (dbl) { if (S.pop) closePopover(); showSelection(s, s); }
    seekSrc(s);
  });
  track.addEventListener("pointermove", (e) => {
    if (!S.drag) return;
    const s = posToSrc(e);
    if (S.drag.mode === "select") { S.drag.b = s; showSelection(S.drag.a, s); }
    seekSrc(s);
  });
  const endDrag = (e) => {
    if (!S.drag) return;
    const d = S.drag; S.drag = null;
    if (d.mode === "select") {
      const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
      if (b - a >= 0.15) openPopover({ id: store.uid("r"), type: null, start: a, end: b }, true);
      else { showSelection(null); toast("ダブルクリックしたまま横にドラッグして範囲を選びます"); }
    }
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);
  $("tl-ranges").addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".tl-range");
    if (!el) return;
    e.stopPropagation();
    const r = P.ranges.find((x) => x.id === el.dataset.id);
    if (r) { seekSrc(r.start); openPopover(r, false); }
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.code === "Space") { e.preventDefault(); S.playing ? pause() : play(); }
    if (e.key === "ArrowLeft") setT(S.T - (e.shiftKey ? 5 : 1), { pause: true });
    if (e.key === "ArrowRight") setT(S.T + (e.shiftKey ? 5 : 1), { pause: true });
    if (e.key === "Home") setT(0, { pause: true });
    if (e.key === "Escape" && S.picker) { closePicker(); return; }
    if (e.key === "Escape" && S.pop) closePopover();
    if ((e.key === "Delete" || e.key === "Backspace") && S.pop && !S.pop.isNew) { P.ranges = P.ranges.filter((x) => x.id !== S.pop.r.id); save(); closePopover(); }
  });

  // drag & drop / paste
  const wrap = $("canvas-wrap");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); wrap.classList.remove("dragover"); }));
  document.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
    if (!files.length) return;
    const imgs = files.filter((f) => /^image\//.test(f.type));
    const vids = files.filter((f) => !/^image\//.test(f.type));
    if (imgs.length) addImageFiles(imgs);
    if (vids.length) addVideoFiles(vids);
  });
  document.addEventListener("paste", (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const files = items.filter((it) => it.kind === "file" && /^image\//.test(it.type)).map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addImageFiles(files); }
  });

  // ---------- boot ----------
  (async () => {
    applyCanvasSize();
    renderProjTabs();
    setTab(P.clips.length ? "clips" : "opening");
    renderTimeline();
    updateHUD();
    requestAnimationFrame(tick);
    await restoreMedia();
    renderPanel(); renderTimeline(); setT(0, { pause: true });
    const sz = sizeOf();
    S.mp4ok = await VC.exporter.canMp4(sz.w, sz.h, Number(P.output.fps) || 30);
    if (S.tab === "export") renderPanel();
    if (S.mp4ok === false) toast("mp4書き出しには Chrome が必要です（他ブラウザは webm）");
  })();
})();
