window.VC = window.VC || {};

// フレーム合成：出力時間 T → フェーズ・動画の位置 → Canvas に描く
VC.render = {
  snaps: {},     // カット直前フレームのスナップショット（cutId → canvas）
  _inc: null,    // 作業用キャンバス（カット演出の「入ってくる映像」）

  info(P) {
    const stingDur = VC.sting.duration(P);
    const openDur = VC.opening.duration(P);
    const segs = VC.timeline.segments(P.clips, P.ranges);
    const outDur = VC.timeline.outputDuration(segs);
    const edDur = VC.ending.duration(P);
    const opDur = stingDur + openDur;
    return { stingDur, openDur, opDur, segs, outDur, edDur, total: opDur + outDur + edDur, srcTotal: VC.timeline.totalSource(P.clips) };
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
      const k = VC.opening.transitionK(P, local);
      if (k != null && P.clips.length) { const f = this.firstMainClip(P, info); loc.trans = k; loc.clip = f.clip; loc.clipLocal = f.clipLocal; }
      return loc;
    }
    const o = T - info.opDur;
    if (o < info.outDur && P.clips.length) {
      const seg = VC.timeline.segAtOut(info.segs, o) || info.segs.filter((g) => !g.cut).pop();
      const src = seg ? Math.min(seg.end - 1e-4, seg.start + (o - seg.outStart) * seg.rate) : 0;
      const ca = VC.timeline.clipAt(P.clips, src);
      return { phase: "main", local: o, seg, src, clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0, info };
    }
    return { phase: "ending", local: Math.max(0, T - info.opDur - info.outDur), info };
  },

  locateSrc(P, src, info) {
    info = info || this.info(P);
    const ca = VC.timeline.clipAt(P.clips, src);
    const seg = info.segs.find((g) => src >= g.start && src < g.end) || null;
    return { phase: "main", local: VC.timeline.srcToOut(info.segs, src), src, seg: seg && !seg.cut ? seg : null, clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0, info, scrub: true };
  },

  draw(ctx, W, H, loc, P, runtime) {
    if (loc.phase === "sting") { VC.sting.draw(ctx, W, H, P); return; }
    if (loc.phase === "opening") {
      if (loc.trans != null) {
        const v = loc.clip ? runtime.videos[loc.clip.id] : null;
        const drawMain = v && v.videoWidth ? (c, w, h) => this.drawVideo(c, w, h, v) : null;
        VC.opening.drawTransition(ctx, W, H, loc.trans, P, drawMain);
        return;
      }
      VC.opening.draw(ctx, W, H, loc.local, P, runtime.images);
      return;
    }
    if (loc.phase === "ending") { VC.ending.draw(ctx, W, H, loc.local, P); return; }

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
    }
    for (const c of VC.timeline.captionsAt(P.ranges, loc.src)) this.drawCaption(ctx, W, H, c, loc.src);

    // カット直前のフレームを保存しておく（次のカット演出で「出ていく映像」に使う）
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

  // ---------- カット演出 ----------
  drawCutFx(ctx, W, H, k, type, out, inc) {
    if (type === "zoom") return this.fxZoom(ctx, W, H, k, out, inc);
    if (type === "glitch") return this.fxGlitch(ctx, W, H, k, out, inc);
    return this.fxWhip(ctx, W, H, k, out, inc);
  },

  // ウィップ：前の映像が高速で左へ飛び、次の映像が右から飛び込む。モーションブラー＋一瞬のフラッシュ
  fxWhip(ctx, W, H, k, out, inc) {
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const speed = Math.sin(Math.PI * k);
    const N = 7;
    const spread = W * 0.14 * speed;
    const layer = (img, base) => {
      for (let i = 0; i < N; i++) {
        const off = base + ((i - (N - 1) / 2) / (N - 1)) * spread;
        ctx.globalAlpha = 0.22;
        ctx.drawImage(img, off, 0, W, H);
      }
      ctx.globalAlpha = 0.55;
      ctx.drawImage(img, base, 0, W, H);
      ctx.globalAlpha = 1;
    };
    if (out) layer(out, -e * W * 1.12);
    layer(inc, (1 - e) * W * 1.12);
    const f = Math.max(0, 1 - Math.abs(k - 0.5) / 0.22);
    if (f > 0) { ctx.fillStyle = `rgba(255,255,255,${(0.45 * f * f).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  },

  // パンチズーム：前の映像が拡大しながら消え、次の映像が寄りから等倍に落ち着く
  fxZoom(ctx, W, H, k, out, inc) {
    const eo = 1 - Math.pow(1 - k, 3);
    const zoomDraw = (img, sc, alpha, blur) => {
      const n = blur ? 5 : 1;
      for (let i = 0; i < n; i++) {
        const s = sc * (1 + (i / n) * 0.05 * blur);
        ctx.save();
        ctx.globalAlpha = alpha / (blur ? n * 0.7 : 1);
        ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
        ctx.drawImage(img, 0, 0, W, H);
        ctx.restore();
      }
    };
    if (out && k < 0.55) { const q = k / 0.55; zoomDraw(out, 1 + q * 0.9, 1 - q, q); }
    const q = Math.max(0, (k - 0.15) / 0.85);
    const ei = 1 - Math.pow(1 - q, 3);
    if (k >= 0.15) zoomDraw(inc, 1.45 - 0.45 * ei, Math.min(1, q * 2.5), 1 - ei);
    const f = Math.max(0, 1 - Math.abs(k - 0.35) / 0.2);
    if (f > 0) { ctx.fillStyle = `rgba(255,255,255,${(0.5 * f * f).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    void eo;
  },

  // グリッチ：横に裂けたスライス＋RGBずれ＋走査線。前半は前の映像が混ざる
  fxGlitch(ctx, W, H, k, out, inc) {
    const seed = Math.floor(k * 40);
    const rng = VC.opening.rng(seed * 31 + 11);
    const amp = Math.pow(1 - k, 1.6);
    const base = k < 0.3 && out ? out : inc;
    ctx.drawImage(base, 0, 0, W, H);
    // RGBずれ
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.5 * amp;
    ctx.drawImage(inc, W * 0.012 * amp * 3, 0, W, H);
    ctx.drawImage(inc, -W * 0.012 * amp * 3, 0, W, H);
    ctx.restore();
    // スライス
    const n = 6 + Math.floor(rng() * 6);
    for (let i = 0; i < n; i++) {
      const y = Math.floor(rng() * H), h = Math.max(4, Math.floor(rng() * H * 0.08));
      const dx = (rng() - 0.5) * W * 0.25 * amp;
      const src = rng() < 0.3 && out ? out : inc;
      ctx.drawImage(src, 0, y, W, h, dx, y, W, h);
    }
    // 走査線
    ctx.fillStyle = `rgba(255,255,255,${(0.08 * amp).toFixed(3)})`;
    for (let y = (seed * 7) % 6; y < H; y += 6) ctx.fillRect(0, y, W, 1);
    // 暗転フラッシュ
    if (k < 0.08) { ctx.fillStyle = `rgba(0,0,0,${(1 - k / 0.08) * 0.6})`; ctx.fillRect(0, 0, W, H); }
  },

  // ---------- 字幕 ----------
  _segCache: {},
  tokens(text) {
    text = String(text || "").trim();
    if (this._segCache[text]) return this._segCache[text];
    let out;
    if (/\s/.test(text)) out = text.split(/\s+/).filter(Boolean);
    else if (window.Intl && Intl.Segmenter) {
      const seg = new Intl.Segmenter("ja", { granularity: "word" });
      out = [...seg.segment(text)].map((s) => s.segment).filter((s) => s.trim());
    } else out = [...text];
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
    const lh = size * 1.35;
    const totalH = lines.length * lh;
    const pos = r.pos || "bottom";
    const cy = pos === "top" ? H * 0.14 + totalH / 2 : pos === "center" ? H / 2 : H * 0.86 - totalH / 2;
    const pad = size * 0.5;
    const boxW = Math.max(...lines.map((l) => l.w)) + pad * 2;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = "#000";
    this.rrect(ctx, W / 2 - boxW / 2, cy - totalH / 2 - pad * 0.5, boxW, totalH + pad, size * 0.3);
    ctx.fill();
    ctx.restore();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    lines.forEach((l, li) => {
      let x = W / 2 - l.w / 2;
      const y = cy - totalH / 2 + lh * (li + 0.5);
      for (const i of l.idx) {
        const isCur = i === cur;
        ctx.save();
        if (isCur) { ctx.translate(x + widths[i] / 2, y); ctx.scale(1.08, 1.08); ctx.translate(-(x + widths[i] / 2), -y); }
        ctx.lineWidth = size * 0.16;
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(0,0,0,.9)";
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
