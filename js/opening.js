window.VC = window.VC || {};

// ---------- テキスト描画ヘルパー ----------
VC.text = {
  FONTS: {
    sans: 'Inter, "Noto Sans JP", -apple-system, BlinkMacSystemFont, sans-serif',
    serif: '"Noto Serif JP", Georgia, "Times New Roman", serif',
    mono: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Noto Sans JP", monospace',
  },
  FONT: 'Inter, "Noto Sans JP", -apple-system, BlinkMacSystemFont, sans-serif',
  use(colors) { this.FONT = this.FONTS[(colors && colors.font) || "sans"] || this.FONTS.sans; },
  isLight(hex) {
    const c = String(hex || "#000").replace("#", "");
    if (c.length < 6) return false;
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
  },
  flashRgb(colors) { return this.isLight(colors && colors.bg) ? "0,0,0" : "255,255,255"; },
  wrap(ctx, text, maxW) {
    const hasSpace = /\s/.test(text);
    const toks = hasSpace ? text.split(/\s+/) : [...text];
    const sep = hasSpace ? " " : "";
    const lines = [];
    let line = "";
    for (const t of toks) {
      const cand = line ? line + sep + t : t;
      if (line && ctx.measureText(cand).width > maxW) { lines.push(line); line = t; }
      else line = cand;
    }
    if (line) lines.push(line);
    return lines;
  },
  drawCentered(ctx, W, H, text, opts) {
    opts = opts || {};
    const maxW = W * (opts.maxWRatio || 0.86);
    let size = Math.round(H * (opts.sizeRatio || 0.11));
    const minSize = Math.round(H * 0.05);
    let lines;
    for (;;) {
      ctx.font = `${opts.weight || 800} ${size}px ${this.FONT}`;
      lines = this.wrap(ctx, text, maxW);
      const tooWide = lines.some((l) => ctx.measureText(l).width > maxW);
      const tooTall = lines.length * size * 1.2 > H * 0.8;
      if ((!tooWide && !tooTall) || size <= minSize) break;
      size = Math.max(minSize, Math.round(size * 0.9));
    }
    const lh = size * 1.2;
    const totalH = lines.length * lh;
    ctx.save();
    ctx.translate(W / 2, H / 2 + (opts.dy || 0));
    if (opts.scale && opts.scale !== 1) ctx.scale(opts.scale, opts.scale);
    ctx.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = opts.color || "#fff";
    lines.forEach((l, i) => ctx.fillText(l, 0, -totalH / 2 + lh * (i + 0.5)));
    ctx.restore();
    return { size, lines: lines.length };
  },
};

// ---------- 動画の型（スタイル） ----------
VC.styles = {
  list: [
    { id: "classic", name: "Classic", desc: "「you / can / now」が1文字ずつ → 画像モンタージュ（加速）→ 用途をドーン → 文字にパンチズームして本編へ。EDはタイピングでアプリ名。", colors: { bg: "#000000", fg: "#ffffff", font: "sans" } },
    { id: "typewriter", name: "Typewriter", desc: "文章をタイプ → じわっと流れて → 一瞬で退場 → 次の文章…を繰り返し、加速モンタージュ → 最後の1枚で止めて本編へ。EDはPR文をタイプ → 退場 → アプリ名をタイプ。", colors: { bg: "#ffffff", fg: "#111111", font: "sans" } },
  ],
  get(id) { return this.list.find((s) => s.id === id) || this.list[0]; },
  defaultColors(id) { return Object.assign({}, this.get(id).colors); },
  // 選択画面のプレビュー用デモ設定
  demo(id) {
    const op = Object.assign(VC.opening.defaults(), { montageDur: 2.6, intervalStart: 0.4, intervalEnd: 0.05, purpose: "edit documents", finalHold: 0.9, transDur: 0.5, sentences: ["計画書を貼るだけ。", "あとはコピペだけ。"], lastHold: 0.6, _demo: true });
    const ed = Object.assign(VC.ending.defaults(), { text: "YourApp", sub: "", hold: 1.2, prText: "段取りは、AIにまかせる。", prHold: 0.7 });
    return { style: id, colors: this.defaultColors(id), opening: op, ending: ed, output: { sting: 0 }, clips: [], ranges: [] };
  },
};

// ---------- オープニング ----------
VC.opening = {
  defaults() {
    return {
      enabled: true,
      // classic
      words: ["you", "can", "now"],
      wordDur: 0.9,
      pause: 0.5,
      purpose: "edit documents",
      phraseDur: 0.5,
      finalHold: 1.4,
      transDur: 0.55,
      // typewriter
      sentences: ["計画書を貼るだけ。", "段取りは、AIにまかせる。", "あなたはコピペするだけ。"],
      charDur: 0.06,
      holdDur: 0.9,
      exitDur: 0.22,
      lastHold: 0.7,
      // montage（共通）
      montageDur: 4.2,
      intervalStart: 0.42,
      intervalEnd: 0.045,
      accel: 2,
      images: [],
    };
  },
  isType(P, id) { return ((P && P.style) || "classic") === id; },
  wordsList(s) {
    const src = Array.isArray(s.words) ? s.words : String(s.words || "").split(/[\s,、]+/);
    return src.map((w) => String(w || "").trim()).filter(Boolean);
  },
  wordsDur(s) { return this.wordsList(s).length * (Number(s.wordDur) > 0 ? Number(s.wordDur) : 0.9); },
  sentencesList(s) { return (s.sentences || []).map((w) => String(w || "").trim()).filter(Boolean); },
  hasPurpose(s) { return !!String((s && s.purpose) || "").trim(); },
  transDur(s) { return this.hasPurpose(s) ? Math.max(0, Number(s.transDur) || 0) : 0; },

  // ---- モンタージュ（共通） ----
  switchTimes(s) {
    const out = [];
    const d = Math.max(0.5, s.montageDur);
    let t = 0, guard = 0;
    const accel = Math.max(0.5, Number(s.accel) || 2);
    while (t < d && guard < 3000) {
      out.push(t);
      const f = t / d;
      const ease = Math.pow(f, accel);
      const iv = s.intervalStart + (s.intervalEnd - s.intervalStart) * ease;
      t += Math.max(0.03, iv);
      guard++;
    }
    return out;
  },
  rng(seed) {
    let x = (seed * 9301 + 49297) % 233280;
    return () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  },
  frames(s) {
    const times = this.switchTimes(s);
    const n = (s.images || []).length;
    const FILTERS = ["none", "grayscale(1)", "contrast(1.4) saturate(1.3)", "sepia(0.45)", "brightness(1.15) contrast(1.1)", "hue-rotate(35deg)", "saturate(0.3) contrast(1.2)"];
    return times.map((t, i) => {
      const r = this.rng(i * 13 + 7);
      const imgIdx = n ? i % n : -1;
      const round = n ? Math.floor(i / n) : 0;
      const v = { t, imgIdx, zoom: 1, rot: 0, flip: false, filter: "none", ox: 0, oy: 0, hue: Math.floor(r() * 360) };
      if (n && round > 0) {
        v.zoom = 1.08 + r() * 0.45; v.rot = (r() - 0.5) * 16; v.flip = r() < 0.35;
        v.filter = FILTERS[Math.floor(r() * FILTERS.length)]; v.ox = (r() - 0.5) * 0.35; v.oy = (r() - 0.5) * 0.35;
      } else if (n) {
        v.zoom = 1 + r() * 0.08; v.ox = (r() - 0.5) * 0.06; v.oy = (r() - 0.5) * 0.06;
      }
      return v;
    });
  },
  framesCached(s) {
    if (!this._cache) this._cache = {};
    const key = JSON.stringify([s.montageDur, s.intervalStart, s.intervalEnd, s.accel, (s.images || []).map((i) => i.id)]);
    if (!this._cache[key]) { if (Object.keys(this._cache).length > 8) this._cache = {}; this._cache[key] = this.frames(s); }
    return this._cache[key];
  },
  neededCount(s) { return this.switchTimes(s).length; },
  drawMontage(ctx, W, H, lt, s, images) {
    const fr = this.framesCached(s);
    let i = 0;
    for (let k = 0; k < fr.length; k++) { if (fr[k].t <= lt) i = k; else break; }
    const f = fr[i];
    if (!f) return;
    const item = f.imgIdx >= 0 ? s.images[f.imgIdx] : null;
    const img = item && images ? images[item.id] : null;
    if (!img || !img.naturalWidth) { this.drawPlaceholder(ctx, W, H, f, i, s); return; }
    ctx.save();
    ctx.translate(W / 2 + f.ox * W * 0.3, H / 2 + f.oy * H * 0.3);
    ctx.rotate((f.rot * Math.PI) / 180);
    ctx.scale(f.flip ? -f.zoom : f.zoom, f.zoom);
    if (f.filter !== "none") ctx.filter = f.filter;
    const sc = Math.max(W / img.naturalWidth, H / img.naturalHeight) * (f.rot ? 1.25 : 1.0);
    const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  },
  drawPlaceholder(ctx, W, H, f, i, s) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${f.hue}, 70%, 45%)`);
    g.addColorStop(1, `hsl(${(f.hue + 60) % 360}, 70%, 25%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (s && s._demo) return;
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = `700 ${Math.round(H * 0.06)}px ${VC.text.FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`画像 ${i + 1}（オープニングタブで追加）`, W / 2, H / 2);
  },

  // ---- 1センテンス：タイプ → じわっと流れる → 一瞬で退場（残像つき） ----
  sentenceDur(text, s) { return [...String(text)].length * s.charDur + s.holdDur + s.exitDur; },
  drawSentence(ctx, W, H, text, lt, s, colors, sizeRatio, weight) {
    const chars = [...String(text)];
    const typeDur = chars.length * s.charDur;
    const stay = typeDur + s.holdDur;
    const drift = W * 0.018;
    let x, shown, blur = 0, alpha = 1;
    if (lt < stay) {
      const f = Math.min(1, lt / stay);
      x = drift - 2 * drift * (1 - Math.pow(1 - f, 1.6));
      shown = Math.min(chars.length, Math.floor(lt / s.charDur) + 1);
    } else {
      const q = Math.min(1, (lt - stay) / Math.max(0.01, s.exitDur));
      const e = q * q * q;
      x = -drift - e * W * 1.3;
      blur = Math.sin(Math.PI * q);
      shown = chars.length;
      alpha = 1 - Math.max(0, q - 0.8) / 0.2;
    }
    let size = Math.round(H * (sizeRatio || 0.075));
    const wt = weight || 600;
    ctx.font = `${wt} ${size}px ${VC.text.FONT}`;
    const full = chars.join("");
    const maxW = W * 0.84;
    const tw0 = ctx.measureText(full).width;
    if (tw0 > maxW) { size = Math.max(Math.round(H * 0.04), Math.floor((size * maxW) / tw0)); ctx.font = `${wt} ${size}px ${VC.text.FONT}`; }
    const tw = ctx.measureText(full).width;
    const left = W / 2 - tw / 2;
    const y = H / 2;
    const typed = chars.slice(0, shown).join("");
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = colors.fg;
    if (blur > 0) {
      for (let i = 1; i <= 5; i++) { ctx.globalAlpha = alpha * 0.12; ctx.fillText(typed, left + x + i * blur * W * 0.03, y); }
    }
    ctx.globalAlpha = alpha;
    ctx.fillText(typed, left + x, y);
    const typing = lt < typeDur;
    const on = typing || Math.floor(lt * 2.6) % 2 === 0;
    if (on && lt < stay) {
      const cw = ctx.measureText(typed).width;
      ctx.fillRect(left + x + cw + size * 0.08, y - size * 0.5, Math.max(2, size * 0.07), size);
    }
    ctx.globalAlpha = 1;
  },

  // ---- 用途テキストのフレーズ分割（classic） ----
  phrases(text) {
    text = String(text || "").trim();
    if (!text) return [];
    if (/\s/.test(text)) {
      const toks = text.split(/\s+/);
      if (toks.length <= 2) return [];
      const size = toks.length >= 6 ? 2 : 1;
      const out = [];
      for (let i = 0; i < toks.length; i += size) out.push(toks.slice(i, i + size).join(" "));
      return out.length > 1 ? out : [];
    }
    if (text.length <= 8) return [];
    const parts = text.split(/([、。，．,.!?！？・])/).reduce((acc, cur, i, arr) => { if (i % 2 === 0) acc.push(cur + (arr[i + 1] || "")); return acc; }, []).filter((p) => p.trim());
    const out = [];
    for (const p of parts) { if (p.length <= 7) out.push(p); else for (let i = 0; i < p.length; i += 5) out.push(p.slice(i, i + 5)); }
    return out.length > 1 ? out : [];
  },

  // ---- 長さ ----
  duration(P) {
    const s = P && P.opening;
    if (!s || !s.enabled) return 0;
    return this.isType(P, "typewriter") ? this.twDuration(s) : this.classicDuration(s);
  },
  classicDuration(s) {
    const ph = this.phrases(s.purpose);
    const hasPurpose = this.hasPurpose(s);
    return this.wordsDur(s) + s.montageDur + s.pause + ph.length * s.phraseDur + (hasPurpose ? s.finalHold + this.transDur(s) : 0);
  },
  twDuration(s) {
    let d = 0;
    for (const t of this.sentencesList(s)) d += this.sentenceDur(t, s);
    return d + s.montageDur + Math.max(0, Number(s.lastHold) || 0);
  },
  transitionK(P, t) {
    if (this.isType(P, "typewriter")) return null;
    const s = P.opening;
    const td = this.transDur(s);
    if (!td) return null;
    const start = this.classicDuration(s) - td;
    if (t < start) return null;
    return Math.max(0, Math.min(1, (t - start) / td));
  },

  // ---- 描画 ----
  draw(ctx, W, H, t, P, images) {
    const colors = P.colors || VC.styles.defaultColors(P.style);
    VC.text.use(colors);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    if (this.isType(P, "typewriter")) this.drawTw(ctx, W, H, t, P.opening, colors, images);
    else this.drawClassic(ctx, W, H, t, P.opening, colors, images);
  },

  drawTw(ctx, W, H, t, s, colors, images) {
    let acc = 0;
    for (const text of this.sentencesList(s)) {
      const d = this.sentenceDur(text, s);
      if (t < acc + d) { this.drawSentence(ctx, W, H, text, t - acc, s, colors, 0.075, 600); return; }
      acc += d;
    }
    t -= acc;
    if (t < s.montageDur) { this.drawMontage(ctx, W, H, t, s, images); return; }
    this.drawMontage(ctx, W, H, s.montageDur - 0.001, s, images);   // 最後の1枚で止める
  },

  drawClassic(ctx, W, H, t, s, colors, images) {
    const words = this.wordsList(s);
    const wd = this.wordsDur(s);
    if (!isFinite(t) || t < 0) t = 0;
    if (t < wd && words.length) {
      const per = Number(s.wordDur) > 0 ? Number(s.wordDur) : 0.9;
      const i = Math.max(0, Math.min(words.length - 1, Math.floor(t / per) || 0));
      this.drawWord(ctx, W, H, words[i], t - i * per, per, colors);
      return;
    }
    t -= wd;
    if (t < s.montageDur) { this.drawMontage(ctx, W, H, t, s, images); return; }
    t -= s.montageDur;
    if (t < s.pause) return;
    t -= s.pause;
    const purpose = String(s.purpose || "").trim();
    if (!purpose) return;
    const ph = this.phrases(purpose);
    const pd = ph.length * s.phraseDur;
    if (t < pd) {
      const i = Math.min(ph.length - 1, Math.floor(t / s.phraseDur));
      const a = Math.min(1, (t - i * s.phraseDur) / 0.1);
      VC.text.drawCentered(ctx, W, H, ph[i], { sizeRatio: 0.13, alpha: a, color: colors.fg });
      return;
    }
    t -= pd;
    const k = Math.min(1, t / 0.18);
    const e = 1 - Math.pow(1 - k, 3);
    VC.text.drawCentered(ctx, W, H, purpose, { sizeRatio: 0.12, scale: 1.28 - 0.28 * e, alpha: Math.min(1, k * 1.5 + 0.2), color: colors.fg });
  },

  drawWord(ctx, W, H, word, lt, dur, colors) {
    const chars = [...String(word == null ? "" : word)];
    const n = chars.length;
    if (!n) return;
    if (!(dur > 0)) dur = 0.9;
    if (!isFinite(lt)) lt = 0;
    const per = (dur * 0.55) / n;
    const size = Math.round(H * 0.2);
    ctx.font = `800 ${size}px ${VC.text.FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const gap = size * 0.04;
    const widths = chars.map((c) => ctx.measureText(c).width);
    const total = widths.reduce((a, b) => a + b, 0) + gap * (n - 1);
    let x = (W - total) / 2;
    const y = H / 2;
    chars.forEach((c, k) => {
      const a = Math.max(0, Math.min(1, (lt - k * per) / 0.18));
      ctx.globalAlpha = a;
      ctx.fillStyle = colors.fg;
      ctx.fillText(c, x, y + (1 - a) * size * 0.08);
      x += widths[k] + gap;
    });
    ctx.globalAlpha = 1;
  },

  // 用途テキストにズームインして突き抜け、本編が現れる（classic）
  drawTransition(ctx, W, H, k, P, drawMain) {
    const s = P.opening;
    const colors = P.colors || VC.styles.defaultColors(P.style);
    VC.text.use(colors);
    const purpose = String(s.purpose || "").trim();
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    if (k > 0.35 && drawMain) {
      const q = Math.min(1, (k - 0.35) / 0.65);
      const eo = 1 - Math.pow(1 - q, 3);
      const sc = 1.18 - 0.18 * eo;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (k - 0.35) / 0.2);
      ctx.translate(W / 2, H / 2); ctx.scale(sc, sc); ctx.translate(-W / 2, -H / 2);
      drawMain(ctx, W, H);
      ctx.restore();
    }
    if (k < 0.62) {
      const q = Math.min(1, k / 0.62);
      const ei = q * q * q;
      const scale = 1 + ei * 9;
      const alpha = q < 0.7 ? 1 : Math.max(0, 1 - (q - 0.7) / 0.3);
      for (let g = 2; g >= 0; g--) {
        const sc2 = scale * (1 - g * 0.06 * ei);
        VC.text.drawCentered(ctx, W, H, purpose, { sizeRatio: 0.12, scale: sc2, alpha: alpha * (g ? 0.22 : 1), color: colors.fg });
      }
    }
    const f = Math.abs(k - 0.5) < 0.16 ? 1 - Math.abs(k - 0.5) / 0.16 : 0;
    if (f > 0) { ctx.fillStyle = `rgba(${VC.text.flashRgb(colors)},${(0.8 * f * f).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  },
};

// ---------- 先頭タイトルカード（サムネ） ----------
VC.sting = {
  duration(P) { const d = Number(P.output && P.output.sting); return d > 0 ? d : 0; },
  slash(ctx, cx, cy, sx, sy, d, halfLen, width) {
    const k = Math.SQRT1_2;
    const mx = cx + sx * d * k, my = cy + sy * d * k;
    const dx = sx * halfLen * k, dy = -sy * halfLen * k;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(mx - dx, my - dy); ctx.lineTo(mx + dx, my + dy); ctx.stroke();
  },
  ring(ctx, cx, cy, r, w) {
    ctx.lineWidth = w;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  },
  draw(ctx, W, H, P) {
    const colors = P.colors || VC.styles.defaultColors(P.style);
    VC.text.use(colors);
    const name = String((P.ending && P.ending.text) || P.name || "ReelCut").trim() || "ReelCut";
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    const m = Math.min(W, H);
    const c = m * 0.34;
    ctx.save();
    ctx.strokeStyle = colors.fg;
    ctx.lineCap = "round";
    if (VC.opening.isType(P, "typewriter")) {
      // 隅に、極太のリングと、それに被さる細いリング（枠では囲まない）
      this.ring(ctx, c * 0.1, c * 0.1, c * 0.55, m * 0.05);
      this.ring(ctx, c * 0.58, c * 0.36, c * 0.16, m * 0.006);
      this.ring(ctx, W - c * 0.1, H - c * 0.1, c * 0.55, m * 0.05);
      this.ring(ctx, W - c * 0.58, H - c * 0.36, c * 0.16, m * 0.006);
    } else {
      this.slash(ctx, 0, 0, 1, 1, c * 0.22, c * 0.30, Math.max(12, m * 0.064));
      this.slash(ctx, 0, 0, 1, 1, c * 0.46, c * 0.50, Math.max(2, m * 0.007));
      this.slash(ctx, 0, 0, 1, 1, c * 0.66, c * 0.18, Math.max(1.5, m * 0.004));
      this.slash(ctx, W, H, -1, -1, c * 0.22, c * 0.30, Math.max(12, m * 0.064));
      this.slash(ctx, W, H, -1, -1, c * 0.46, c * 0.50, Math.max(2, m * 0.007));
      this.slash(ctx, W, H, -1, -1, c * 0.66, c * 0.18, Math.max(1.5, m * 0.004));
      this.slash(ctx, W, 0, -1, 1, c * 0.30, c * 0.26, Math.max(1.5, m * 0.005));
      this.slash(ctx, 0, H, 1, -1, c * 0.30, c * 0.26, Math.max(1.5, m * 0.005));
    }
    ctx.restore();
    VC.text.drawCentered(ctx, W, H, name, { sizeRatio: H > W ? 0.12 : 0.2, weight: 800, maxWRatio: 0.74, color: colors.fg });
  },
};

// ---------- エンディング ----------
VC.ending = {
  defaults() {
    return {
      enabled: true,
      text: "AI-PM", sub: "", charDur: 0.09, hold: 1.8,
      // typewriter
      prText: "計画書を貼るだけ。段取りは、AIの上司がやる。", prCharDur: 0.05, prHold: 0.9, exitDur: 0.22,
    };
  },
  prSettings(s) { return { charDur: s.prCharDur, holdDur: s.prHold, exitDur: s.exitDur }; },
  duration(P) {
    const s = P && P.ending;
    if (!s || !s.enabled) return 0;
    const n = [...String(s.text || "")].length;
    const nameDur = n * s.charDur + 0.35 + (s.sub && !VC.opening.isType(P, "typewriter") ? 0.45 : 0) + s.hold;
    if (VC.opening.isType(P, "typewriter")) {
      const pr = String(s.prText || "").trim();
      return (pr ? VC.opening.sentenceDur(pr, this.prSettings(s)) : 0) + nameDur;
    }
    return nameDur;
  },
  draw(ctx, W, H, t, P) {
    const s = P.ending;
    const colors = P.colors || VC.styles.defaultColors(P.style);
    VC.text.use(colors);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    if (VC.opening.isType(P, "typewriter")) {
      const pr = String(s.prText || "").trim();
      if (pr) {
        const d = VC.opening.sentenceDur(pr, this.prSettings(s));
        if (t < d) { VC.opening.drawSentence(ctx, W, H, pr, t, this.prSettings(s), colors, 0.065, 500); return; }
        t -= d;
      }
      this.drawTyping(ctx, W, H, t, s.text, "", s.charDur, colors);
      return;
    }
    this.drawTyping(ctx, W, H, t, s.text, s.sub, s.charDur, colors);
  },
  drawTyping(ctx, W, H, t, text, sub, charDur, colors) {
    const chars = [...String(text || "")];
    const shown = Math.min(chars.length, Math.floor(t / charDur));
    const typed = chars.slice(0, shown).join("");
    const done = shown >= chars.length;
    const blink = Math.floor(t * 2.6) % 2 === 0;
    const size = Math.round(H * 0.14);
    ctx.font = `800 ${size}px ${VC.text.FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const fullW = ctx.measureText(chars.join("")).width + size * 0.3;
    const x = (W - Math.min(fullW, W * 0.9)) / 2;
    const y = H / 2 - (sub ? size * 0.35 : 0);
    ctx.fillStyle = colors.fg;
    ctx.fillText(typed, x, y);
    if (!done || blink) {
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x + ctx.measureText(typed).width + size * 0.08, y - size * 0.5, Math.max(2, size * 0.08), size);
      ctx.globalAlpha = 1;
    }
    if (done && sub) {
      const a = Math.max(0, Math.min(1, (t - chars.length * charDur - 0.35) / 0.45));
      ctx.globalAlpha = a * 0.8;
      ctx.fillStyle = colors.fg;
      ctx.font = `500 ${Math.round(H * 0.045)}px ${VC.text.FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(sub, W / 2, y + size * 0.95);
      ctx.globalAlpha = 1;
    }
  },
};
