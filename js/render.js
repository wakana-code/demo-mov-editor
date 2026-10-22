window.VC = window.VC || {};

// フレーム合成：出力時間 T → フェーズ・動画の位置 → Canvas に描く
VC.render = {
  snaps: {},
  _inc: null,

  isSlidesBody(P) { return P && P.body === "slides"; },
  mainDeck(P) { return (P && P.inserts || []).find((x) => x.main) || null; },
  info(P) {
    const stingDur = VC.sting.duration(P);
    const openDur = VC.opening.duration(P);
    const edDur = VC.ending.duration(P);
    const opDur = stingDur + openDur;
    if (this.isSlidesBody(P)) {
      // 本編＝スライドだけ
      const md = this.mainDeck(P);
      const d = md ? VC.inserts.duration(md) : 0;
      const insLayout = md ? [{ ins: md, dur: d, base: 0, outStart: 0, outEnd: d }] : [];
      return { stingDur, openDur, opDur, segs: [], outDur: 0, insLayout, mainDur: d, edDur, total: opDur + d + edDur, srcTotal: 0, slides: true };
    }
    const segs = VC.timeline.segments(P.clips, P.ranges);
    const outDur = VC.timeline.outputDuration(segs);
    const srcTotal = VC.timeline.totalSource(P.clips);
    let extra = 0;
    const insLayout = (P.inserts || []).filter((x) => x.at != null && !x.main).slice().sort((a, b) => a.at - b.at).map((ins) => {
      const dur = VC.inserts.duration(ins);
      const base = VC.timeline.srcToOut(segs, Math.max(0, Math.min(ins.at, srcTotal)));
      const outStart = base + extra;
      extra += dur;
      return { ins, dur, base, outStart, outEnd: outStart + dur };
    });
    const mainDur = outDur + extra;
    return { stingDur, openDur, opDur, segs, outDur, insLayout, mainDur, edDur, total: opDur + mainDur + edDur, srcTotal };
  },
  emptyInfo() { return { stingDur: 0, openDur: 0, opDur: 0, segs: [], outDur: 0, insLayout: [], mainDur: 0, edDur: 0, total: 0, srcTotal: 0 }; },
  pageInfo(page) {
    const segs = VC.inserts.pageSegs(page);
    const outDur = VC.timeline.outputDuration(segs);
    return { stingDur: 0, openDur: 0, opDur: 0, segs, outDur, insLayout: [], mainDur: outDur, edDur: 0, total: VC.inserts.pageDuration(page), srcTotal: page.video ? page.video.duration || 0 : 0 };
  },

  // 「本編だけの出力時間（pure）」と「埋め込み込みの出力時間（out）」の変換
  pureToOut(info, pure) { let o = pure; for (const x of info.insLayout || []) if (x.base < pure) o += x.dur; return o; },
  outToPure(info, o) { let p = o; for (const x of info.insLayout || []) if (x.outEnd <= o) p -= x.dur; return p; },

  // 再生中：本編の位置 pure に対応する出力時間。prevOut より前に終わった埋め込みだけを「通過済み」とみなし、
  // 今まさに地点を越えた埋め込みがあれば、その入口（outStart）を返す（＝飛ばさずに埋め込みへ入る）
  playingOut(info, pure, passed) {
    let o = pure;
    for (const x of info.insLayout || []) {
      if (passed && passed.has(x.ins.id)) { o = Math.max(o + x.dur, x.outEnd); continue; }   // 通過済み（埋め込みの終わりより前には戻さない）
      if (x.base <= pure + 1e-6) return x.outStart;                                           // 今越えた → 埋め込みへ
    }
    return o;
  },

  firstMainClip(P, info) {
    const firstOut = info.segs.find((g) => !g.cut);
    const src = firstOut ? firstOut.start : 0;
    const ca = VC.timeline.clipAt(P.clips, src);
    return { clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0 };
  },

  locate(P, T, info) {
    info = info || this.info(P);
    if (T < info.stingDur) return { phase: "sting", local: T, info };
    if (T < info.opDur) {
      const local = T - info.stingDur;
      const loc = { phase: "opening", local, info };
      if (P.clips.length && !this.isSlidesBody(P)) {
        // どの型でも、オープニング中に本編の最初の位置へ事前シークしておく（最初のコマが一瞬映るのを防ぐ）
        const f = this.firstMainClip(P, info);
        loc.clip = f.clip; loc.clipLocal = f.clipLocal; loc.pre = true;
        const k = VC.opening.transitionK(P, local);
        if (k != null) loc.trans = k;
      }
      return loc;
    }
    const o = T - info.opDur;
    if (o < info.mainDur && (P.clips.length || info.insLayout.length)) {
      const il = info.insLayout.find((x) => o >= x.outStart && o < x.outEnd);
      if (il) return { phase: "insert", ins: il.ins, local: o - il.outStart, il, info };
      if (P.clips.length) {
        const pure = this.outToPure(info, o);
        const seg = VC.timeline.segAtOut(info.segs, pure) || info.segs.filter((g) => !g.cut).pop();
        const src = seg ? Math.min(seg.end - 1e-4, seg.start + (pure - seg.outStart) * seg.rate) : 0;
        const ca = VC.timeline.clipAt(P.clips, src);
        return { phase: "main", local: pure, out: o, seg, src, clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0, info };
      }
    }
    return { phase: "ending", local: Math.max(0, T - info.opDur - info.mainDur), info };
  },

  locateSrc(P, src, info) {
    info = info || this.info(P);
    const ca = VC.timeline.clipAt(P.clips, src);
    const seg = info.segs.find((g) => src >= g.start && src < g.end) || null;
    return { phase: "main", local: VC.timeline.srcToOut(info.segs, src), src, seg: seg && !seg.cut ? seg : null, clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0, info, scrub: true };
  },

  pageLocate(page, T, info) {
    const st = page ? VC.inserts.pageVideoState(page, T) : null;
    return { phase: "main", local: T, seg: st ? st.seg : null, src: st ? st.src : 0, clip: page && page.video ? page.video : null, clipLocal: st ? st.time : 0, info };
  },

  draw(ctx, W, H, loc, P, runtime) {
    if (loc.phase === "sting") { VC.sting.draw(ctx, W, H, P); return; }
    if (loc.phase === "opening") {
      if (loc.trans != null) {
        const v = loc.clip ? runtime.videos[loc.clip.id] : null;
        let drawMain = v && v.videoWidth ? (c, w, h) => this.drawVideo(c, w, h, v) : null;
        if (!drawMain && this.isSlidesBody(P)) { const md = this.mainDeck(P); if (md) drawMain = (c, w, h) => VC.inserts.draw(c, w, h, md, 0, P, runtime); }
        VC.opening.drawTransition(ctx, W, H, loc.trans, P, drawMain);
        return;
      }
      VC.opening.draw(ctx, W, H, loc.local, P, runtime.images);
      return;
    }
    if (loc.phase === "ending") { VC.ending.draw(ctx, W, H, loc.local, P); return; }
    if (loc.phase === "insert") { VC.inserts.draw(ctx, W, H, loc.ins, loc.local, P, runtime); return; }

    VC.text.use(null);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const v = loc.clip ? runtime.videos[loc.clip.id] : null;
    let fx = P.cutFx || { type: "whip", dur: 0.3 };
    const seg = loc.seg;
    if (seg && seg.afterCut) {
      const cr = (P.ranges || []).find((r) => r.id === seg.afterCut);
      if (cr && cr.fx && cr.fx !== "default") fx = { type: cr.fx, dur: fx.dur };
    }
    const inFx = !loc.scrub && seg && seg.afterCut && fx.type !== "none" && fx.dur > 0 && (loc.local - seg.outStart) < fx.dur;
    if (inFx && v && v.videoWidth) {
      const inc = this.incCanvas(W, H);
      const ic = inc.getContext("2d");
      ic.fillStyle = "#000"; ic.fillRect(0, 0, W, H);
      this.drawVideo(ic, W, H, v);
      const k = Math.max(0, Math.min(1, (loc.local - seg.outStart) / fx.dur));
      this.drawCutFx(ctx, W, H, k, fx.type, this.snaps[seg.afterCut] || null, inc);
    } else if (v && v.videoWidth) {
      this.drawVideo(ctx, W, H, v);
    } else if (loc.clip) {
      ctx.fillStyle = "#1a1d26"; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.font = `600 ${Math.round(H * 0.045)}px ${VC.text.FONTS.sans}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(`⚠ 動画「${loc.clip.name || ""}」を読み込めません（📦 メディアの状態 から復旧）`, W / 2, H / 2);
    }
    for (const c of VC.timeline.captionsAt(P.ranges, loc.src)) this.drawCaption(ctx, W, H, c, loc.src);
    if (seg && seg.beforeCut && (seg.end - loc.src) < 0.25 * seg.rate) {
      let s = this.snaps[seg.beforeCut];
      if (!s || s.width !== W || s.height !== H) { s = document.createElement("canvas"); s.width = W; s.height = H; this.snaps[seg.beforeCut] = s; }
      s.getContext("2d").drawImage(ctx.canvas, 0, 0, W, H);
    }
  },

  incCanvas(W, H) {
    if (!this._inc || this._inc.width !== W || this._inc.height !== H) { this._inc = document.createElement("canvas"); this._inc.width = W; this._inc.height = H; }
    return this._inc;
  },
  drawVideo(ctx, W, H, v) {
    const sc = Math.min(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * sc, dh = v.videoHeight * sc;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  },
  drawVideoCover(ctx, W, H, v) {
    const sc = Math.max(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * sc, dh = v.videoHeight * sc;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  },

  // ---------- カット演出 ----------
  drawCutFx(ctx, W, H, k, type, out, inc) {
    if (type === "zoom") return this.fxZoom(ctx, W, H, k, out, inc);
    if (type === "glitch") return this.fxGlitch(ctx, W, H, k, out, inc);
    return this.fxWhip(ctx, W, H, k, out, inc);
  },
  fxWhip(ctx, W, H, k, out, inc) {
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const speed = Math.sin(Math.PI * k);
    const N = 7, spread = W * 0.14 * speed;
    const layer = (img, base) => {
      for (let i = 0; i < N; i++) { ctx.globalAlpha = 0.22; ctx.drawImage(img, base + ((i - (N - 1) / 2) / (N - 1)) * spread, 0, W, H); }
      ctx.globalAlpha = 0.55; ctx.drawImage(img, base, 0, W, H); ctx.globalAlpha = 1;
    };
    if (out) layer(out, -e * W * 1.12);
    layer(inc, (1 - e) * W * 1.12);
    const f = Math.max(0, 1 - Math.abs(k - 0.5) / 0.22);
    if (f > 0) { ctx.fillStyle = `rgba(255,255,255,${(0.45 * f * f).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  },
  fxZoom(ctx, W, H, k, out, inc) {
    const zoomDraw = (img, sc, alpha, blur) => {
      const n = blur ? 5 : 1;
      for (let i = 0; i < n; i++) {
        const s = sc * (1 + (i / n) * 0.05 * blur);
        ctx.save(); ctx.globalAlpha = alpha / (blur ? n * 0.7 : 1);
        ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(img, 0, 0, W, H); ctx.restore();
      }
    };
    if (out && k < 0.55) { const q = k / 0.55; zoomDraw(out, 1 + q * 0.9, 1 - q, q); }
    const q = Math.max(0, (k - 0.15) / 0.85);
    const ei = 1 - Math.pow(1 - q, 3);
    if (k >= 0.15) zoomDraw(inc, 1.45 - 0.45 * ei, Math.min(1, q * 2.5), 1 - ei);
    const f = Math.max(0, 1 - Math.abs(k - 0.35) / 0.2);
    if (f > 0) { ctx.fillStyle = `rgba(255,255,255,${(0.5 * f * f).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  },
  fxGlitch(ctx, W, H, k, out, inc) {
    const seed = Math.floor(k * 40);
    const rng = VC.opening.rng(seed * 31 + 11);
    const amp = Math.pow(1 - k, 1.6);
    const base = k < 0.3 && out ? out : inc;
    ctx.drawImage(base, 0, 0, W, H);
    ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = 0.5 * amp;
    ctx.drawImage(inc, W * 0.036 * amp, 0, W, H); ctx.drawImage(inc, -W * 0.036 * amp, 0, W, H); ctx.restore();
    const n = 6 + Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) {
      const y = Math.floor(rng() * H), h = Math.max(4, Math.floor(rng() * H * 0.08));
      const dx = (rng() - 0.5) * W * 0.25 * amp;
      ctx.drawImage(rng() < 0.3 && out ? out : inc, 0, y, W, h, dx, y, W, h);
    }
    ctx.fillStyle = `rgba(255,255,255,${(0.08 * amp).toFixed(3)})`;
    for (let y = (seed * 7) % 6; y < H; y += 6) ctx.fillRect(0, y, W, 1);
    if (k < 0.08) { ctx.fillStyle = `rgba(0,0,0,${(1 - k / 0.08) * 0.6})`; ctx.fillRect(0, 0, W, H); }
  },

  // ---------- 字幕 ----------
  _segCache: {},
  tokens(text) {
    text = String(text || "").trim();
    if (this._segCache[text]) return this._segCache[text];
    let out;
    if (/\s/.test(text)) out = text.split(/\s+/).filter(Boolean);
    else if (window.Intl && Intl.Segmenter) { const seg = new Intl.Segmenter("ja", { granularity: "word" }); out = [...seg.segment(text)].map((s) => s.segment).filter((s) => s.trim()); }
    else out = [...text];
    if (!out.length) out = [text];
    this._segCache[text] = out;
    return out;
  },
  drawCaption(ctx, W, H, r, src) {
    const toks = this.tokens(r.text);
    if (!toks.length) return;
    const per = (r.end - r.start) / toks.length;
    const cur = Math.max(0, Math.min(toks.length - 1, Math.floor((src - r.start) / per)));
    const size = Math.round(H * (r.size || 0.055));
    const hasSpace = /\s/.test(r.text);
    const gap = hasSpace ? size * 0.3 : size * 0.04;
    ctx.font = `800 ${size}px ${VC.text.FONT}`;
    const widths = toks.map((t) => ctx.measureText(t).width);
    const maxW = W * 0.86;
    const lines = [];
    let line = [], lw = 0;
    toks.forEach((t, i) => {
      const w = widths[i] + (line.length ? gap : 0);
      if (line.length && lw + w > maxW) { lines.push({ idx: line, w: lw }); line = [i]; lw = widths[i]; }
      else { line.push(i); lw += w; }
    });
    if (line.length) lines.push({ idx: line, w: lw });
    const lh = size * 1.35, totalH = lines.length * lh;
    const pos = r.pos || "bottom";
    const cy = pos === "top" ? H * 0.14 + totalH / 2 : pos === "center" ? H / 2 : H * 0.86 - totalH / 2;
    const pad = size * 0.5;
    const boxW = Math.max(...lines.map((l) => l.w)) + pad * 2;
    ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = "#000";
    this.rrect(ctx, W / 2 - boxW / 2, cy - totalH / 2 - pad * 0.5, boxW, totalH + pad, size * 0.3); ctx.fill(); ctx.restore();
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    lines.forEach((l, li) => {
      let x = W / 2 - l.w / 2;
      const y = cy - totalH / 2 + lh * (li + 0.5);
      for (const i of l.idx) {
        const isCur = i === cur;
        ctx.save();
        if (isCur) { ctx.translate(x + widths[i] / 2, y); ctx.scale(1.08, 1.08); ctx.translate(-(x + widths[i] / 2), -y); }
        ctx.lineWidth = size * 0.16; ctx.lineJoin = "round"; ctx.strokeStyle = "rgba(0,0,0,.9)";
        ctx.strokeText(toks[i], x, y);
        ctx.fillStyle = isCur ? (r.color || "#facc15") : "#fff";
        ctx.fillText(toks[i], x, y);
        ctx.restore();
        x += widths[i] + gap;
      }
    });
  },
  rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },
};
