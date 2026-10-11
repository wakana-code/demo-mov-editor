window.VC = window.VC || {};

// 共通：テキスト描画ヘルパー
VC.text = {
  FONT: 'Inter, "Noto Sans JP", -apple-system, sans-serif',
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
  // 幅に収まる最大フォントサイズでセンター描画（複数行対応）
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

// オープニング：単語1文字ずつ → 画像モンタージュ（加速） → 一呼吸 → 用途フレーズ → 全文ドーン
VC.opening = {
  defaults() {
    return {
      enabled: true,
      words: ["you", "can", "now"],
      wordDur: 0.9,
      montageDur: 4.2,
      intervalStart: 0.42,
      intervalEnd: 0.045,
      pause: 0.5,
      purpose: "edit documents",
      phraseDur: 0.5,
      finalHold: 1.4,
      transDur: 0.55,        // 用途テキスト → 本編への「パンチズーム」トランジションの長さ
      images: [],            // [{ id, name }]  中身は IndexedDB、要素は VC.runtime.images[id]
    };
  },
  hasPurpose(s) { return !!String((s && s.purpose) || "").trim(); },
  transDur(s) { return this.hasPurpose(s) ? Math.max(0, Number(s.transDur) || 0) : 0; },
  // トランジション中なら 0→1 の進行度、そうでなければ null
  transitionK(s, t) {
    const td = this.transDur(s);
    if (!td) return null;
    const start = this.duration(s) - td;
    if (t < start) return null;
    return Math.max(0, Math.min(1, (t - start) / td));
  },
  wordsList(s) { return (s.words || []).map((w) => String(w || "").trim()).filter(Boolean); },
  wordsDur(s) { return this.wordsList(s).length * s.wordDur; },

  // 切り替え時刻（最初ゆっくり→加速）
  switchTimes(s) {
    const out = [];
    const d = Math.max(0.5, s.montageDur);
    let t = 0, guard = 0;
    while (t < d && guard < 3000) {
      out.push(t);
      const f = t / d;
      const ease = f * f;
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
  // 各コマの「どの画像を、どう加工して出すか」。枚数が足りない周回はズーム・回転・反転・フィルタで水増し
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
        v.zoom = 1.08 + r() * 0.45;
        v.rot = (r() - 0.5) * 16;
        v.flip = r() < 0.35;
        v.filter = FILTERS[Math.floor(r() * FILTERS.length)];
        v.ox = (r() - 0.5) * 0.35;
        v.oy = (r() - 0.5) * 0.35;
      } else if (n) {
        v.zoom = 1 + r() * 0.08;
        v.ox = (r() - 0.5) * 0.06;
        v.oy = (r() - 0.5) * 0.06;
      }
      return v;
    });
  },
  framesCached(s) {
    const key = JSON.stringify([s.montageDur, s.intervalStart, s.intervalEnd, (s.images || []).map((i) => i.id)]);
    if (!this._cache || this._cache.key !== key) this._cache = { key, frames: this.frames(s) };
    return this._cache.frames;
  },
  neededCount(s) { return this.switchTimes(s).length; },

  // 用途テキストをフレーズに分割（短ければ分割しない＝いきなりドーン）
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
    const parts = text.split(/([、。，．,.!?！？・])/).reduce((acc, cur, i, arr) => {
      if (i % 2 === 0) acc.push(cur + (arr[i + 1] || ""));
      return acc;
    }, []).filter((p) => p.trim());
    const out = [];
    for (const p of parts) {
      if (p.length <= 7) out.push(p);
      else for (let i = 0; i < p.length; i += 5) out.push(p.slice(i, i + 5));
    }
    return out.length > 1 ? out : [];
  },

  duration(s) {
    if (!s || !s.enabled) return 0;
    const ph = this.phrases(s.purpose);
    const hasPurpose = this.hasPurpose(s);
    return this.wordsDur(s) + s.montageDur + s.pause + ph.length * s.phraseDur + (hasPurpose ? s.finalHold + this.transDur(s) : 0);
  },

  // 用途テキストにズームインして突き抜け、本編の映像が現れる（drawMain: 本編の最初のフレームを描く関数）
  drawTransition(ctx, W, H, k, s, drawMain) {
    const purpose = String(s.purpose || "").trim();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    // 本編：k=0.35 から、少し寄った状態（1.18倍）から等倍へ
    if (k > 0.35 && drawMain) {
      const q = Math.min(1, (k - 0.35) / 0.65);
      const eo = 1 - Math.pow(1 - q, 3);
      const sc = 1.18 - 0.18 * eo;
      ctx.save();
      ctx.globalAlpha = Math.min(1, (k - 0.35) / 0.2);
      ctx.translate(W / 2, H / 2);
      ctx.scale(sc, sc);
      ctx.translate(-W / 2, -H / 2);
      drawMain(ctx, W, H);
      ctx.restore();
    }
    // テキスト：加速しながら巨大化して突き抜ける（残像つき）
    if (k < 0.62) {
      const q = Math.min(1, k / 0.62);
      const ei = q * q * q;
      const scale = 1 + ei * 9;
      const alpha = q < 0.7 ? 1 : Math.max(0, 1 - (q - 0.7) / 0.3);
      for (let g = 2; g >= 0; g--) {
        const sc2 = scale * (1 - g * 0.06 * ei);
        VC.text.drawCentered(ctx, W, H, purpose, { sizeRatio: 0.12, scale: sc2, alpha: alpha * (g ? 0.22 : 1) });
      }
    }
    // 白いフラッシュ：突き抜けた瞬間
    const f = Math.abs(k - 0.5) < 0.16 ? 1 - Math.abs(k - 0.5) / 0.16 : 0;
    if (f > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(0.8 * f * f).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }
  },

  draw(ctx, W, H, t, s, images) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const words = this.wordsList(s);
    const wd = this.wordsDur(s);
    if (t < wd && words.length) {
      const i = Math.min(words.length - 1, Math.floor(t / s.wordDur));
      this.drawWord(ctx, W, H, words[i], t - i * s.wordDur, s.wordDur);
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
      VC.text.drawCentered(ctx, W, H, ph[i], { sizeRatio: 0.13, alpha: a });
      return;
    }
    t -= pd;
    const k = Math.min(1, t / 0.18);
    const e = 1 - Math.pow(1 - k, 3);
    VC.text.drawCentered(ctx, W, H, purpose, { sizeRatio: 0.12, scale: 1.28 - 0.28 * e, alpha: Math.min(1, k * 1.5 + 0.2) });
  },

  drawWord(ctx, W, H, word, lt, dur) {
    const chars = [...word];
    const n = chars.length;
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
      ctx.fillStyle = "#fff";
      ctx.fillText(c, x, y + (1 - a) * size * 0.08);
      x += widths[k] + gap;
    });
    ctx.globalAlpha = 1;
  },

  drawMontage(ctx, W, H, lt, s, images) {
    const fr = this.framesCached(s);
    let i = 0;
    for (let k = 0; k < fr.length; k++) { if (fr[k].t <= lt) i = k; else break; }
    const f = fr[i];
    if (!f) return;
    const item = f.imgIdx >= 0 ? s.images[f.imgIdx] : null;
    const img = item && images ? images[item.id] : null;
    if (!img || !img.naturalWidth) { this.drawPlaceholder(ctx, W, H, f, i); return; }
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

  drawPlaceholder(ctx, W, H, f, i) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${f.hue}, 70%, 45%)`);
    g.addColorStop(1, `hsl(${(f.hue + 60) % 360}, 70%, 25%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.75)";
    ctx.font = `700 ${Math.round(H * 0.06)}px ${VC.text.FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`画像 ${i + 1}（オープニングタブで追加）`, W / 2, H / 2);
  },
};

// エンディング：タイピング風にアプリ名
VC.ending = {
  defaults() { return { enabled: true, text: "AI-PM", sub: "", charDur: 0.09, hold: 1.8 }; },
  duration(s) {
    if (!s || !s.enabled) return 0;
    const n = [...String(s.text || "")].length;
    return n * s.charDur + 0.35 + (s.sub ? 0.45 : 0) + s.hold;
  },
  draw(ctx, W, H, t, s) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const chars = [...String(s.text || "")];
    const shown = Math.min(chars.length, Math.floor(t / s.charDur));
    const typed = chars.slice(0, shown).join("");
    const done = shown >= chars.length;
    const blink = Math.floor(t * 2.6) % 2 === 0;
    const cursor = !done || blink ? "▍" : " ";
    const size = Math.round(H * 0.14);
    ctx.font = `800 ${size}px ${VC.text.FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const fullW = ctx.measureText(chars.join("") + "▍").width;
    const x = (W - Math.min(fullW, W * 0.9)) / 2;
    const y = H / 2 - (s.sub ? size * 0.35 : 0);
    ctx.fillStyle = "#fff";
    ctx.fillText(typed, x, y);
    ctx.fillStyle = "#a5b4fc";
    ctx.fillText(cursor, x + ctx.measureText(typed).width, y);
    if (done && s.sub) {
      const a = Math.max(0, Math.min(1, (t - chars.length * s.charDur - 0.35) / 0.45));
      ctx.globalAlpha = a;
      ctx.fillStyle = "#cbd5e1";
      ctx.font = `500 ${Math.round(H * 0.045)}px ${VC.text.FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(s.sub, W / 2, y + size * 0.95);
      ctx.globalAlpha = 1;
    }
  },
};
