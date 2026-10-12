window.VC = window.VC || {};

// 埋め込み：スライド（文字／画像／動画）と動画モンタージュ
VC.inserts = {
  SIZE_MULT: { 1: 0.55, 2: 0.75, 3: 1, 4: 1.3, 5: 1.7, 6: 2.2, 7: 2.8 },

  newSlide() { return { id: VC.store.uid("s"), html: "", dur: 2.5, bg: null, fg: null, pos: "center", align: "center", images: [], video: null, ranges: [] }; },
  newSlides() { return { id: VC.store.uid("ins"), type: "slides", at: null, slides: [this.newSlide()] }; },
  newMontage() { return { id: VC.store.uid("ins"), type: "montage", at: null, videos: [], montageDur: 4, intervalStart: 0.5, intervalEnd: 0.08, accel: 2, lastHold: 0.4 }; },
  normalize(ins) {
    if (!ins || !ins.id) return null;
    if (ins.type === "montage") {
      ins.videos = Array.isArray(ins.videos) ? ins.videos : [];
      const d = this.newMontage();
      for (const k of ["montageDur", "intervalStart", "intervalEnd", "accel", "lastHold"]) if (ins[k] == null) ins[k] = d[k];
    } else {
      ins.type = "slides";
      ins.slides = Array.isArray(ins.slides) && ins.slides.length ? ins.slides : [this.newSlide()];
      for (const s of ins.slides) {
        if (!s.id) s.id = VC.store.uid("s");
        if (!Array.isArray(s.ranges)) s.ranges = [];
        if (!Array.isArray(s.images)) s.images = [];
        if (s.dur == null) s.dur = 2.5;
        if (!s.pos) s.pos = "center";
        if (!s.align) s.align = "center";
        if (s.html == null) s.html = "";
      }
    }
    if (ins.at === undefined) ins.at = null;
    return ins;
  },
  label(ins) {
    return ins.type === "montage"
      ? `🎞 モンタージュ（${ins.videos.length}本）`
      : `💬 スライド（${ins.slides.length}枚${ins.slides.some((s) => s.video) ? "・動画" : ""}${ins.slides.some((s) => s.images.length) ? "・画像" : ""}）`;
  },
  videoRefs(ins) { return ins.type === "montage" ? ins.videos.slice() : ins.slides.filter((s) => s.video).map((s) => s.video); },
  imageRefs(ins) { return ins.type === "montage" ? [] : ins.slides.reduce((a, s) => a.concat(s.images || []), []); },
  colorsOf(slide, P) {
    const base = (P && P.colors) || VC.styles.defaultColors(P && P.style);
    return { bg: (slide && slide.bg) || base.bg, fg: (slide && slide.fg) || base.fg, font: base.font };
  },

  // ---------- スライド ----------
  slideSegs(slide) { return slide.video ? VC.timeline.segments([slide.video], slide.ranges || []) : []; },
  slideDuration(slide) {
    if (slide.video) { const d = VC.timeline.outputDuration(this.slideSegs(slide)); return d > 0 ? d : 0.1; }
    return Math.max(0.3, Number(slide.dur) || 2.5);
  },
  duration(ins) {
    if (ins.type === "montage") return this.montageDuration(ins);
    return ins.slides.reduce((a, s) => a + this.slideDuration(s), 0);
  },
  slideAt(ins, t) {
    let acc = 0;
    for (const s of ins.slides) {
      const d = this.slideDuration(s);
      if (t < acc + d) return { slide: s, local: t - acc, dur: d };
      acc += d;
    }
    const last = ins.slides[ins.slides.length - 1];
    return last ? { slide: last, local: this.slideDuration(last) - 0.001, dur: this.slideDuration(last) } : null;
  },
  slideVideoState(slide, t) {
    if (!slide.video) return null;
    const segs = this.slideSegs(slide);
    const seg = VC.timeline.segAtOut(segs, t) || segs.filter((g) => !g.cut).pop();
    if (!seg) return null;
    const src = Math.max(0, Math.min(seg.end - 1e-4, seg.start + (t - seg.outStart) * seg.rate));
    return { id: slide.video.id, time: src, rate: seg.rate, src, seg };
  },

  // 画像：x,y,w,h はステージに対する比率（0..1）、sx,sy,sw,sh は元画像に対する切り取り比率（0..1）
  newImage(id, name, natW, natH, W, H) {
    const w = 0.42;
    const h = (w * W * natH / natW) / H;
    return { id, name: name || "image", x: (1 - w) / 2, y: (1 - h) / 2, w, h, sx: 0, sy: 0, sw: 1, sh: 1 };
  },
  drawImages(ctx, W, H, slide, runtime) {
    for (const im of slide.images || []) {
      const img = runtime.images[im.id];
      if (!img || !img.naturalWidth) continue;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      try { ctx.drawImage(img, im.sx * nw, im.sy * nh, Math.max(1, im.sw * nw), Math.max(1, im.sh * nh), im.x * W, im.y * H, im.w * W, im.h * H); } catch (e) {}
    }
  },

  // ---------- 文字（contenteditable の HTML → 行と装飾） ----------
  parseHtml(html) {
    const root = document.createElement("div");
    root.innerHTML = html || "";
    const lines = [[]];
    const BLOCK = { DIV: 1, P: 1, LI: 1, H1: 1, H2: 1, H3: 1 };
    const cur = () => lines[lines.length - 1];
    const newline = () => lines.push([]);
    const walk = (node, st) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) {
          const parts = ch.nodeValue.replace(/\u00a0/g, " ").split("\n");
          parts.forEach((p, i) => { if (i) newline(); if (p) cur().push({ text: p, u: st.u, b: st.b, size: st.size }); });
          continue;
        }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName;
        if (tag === "BR") { newline(); continue; }
        const ns = Object.assign({}, st);
        if (tag === "U") ns.u = true;
        if (tag === "B" || tag === "STRONG") ns.b = true;
        if (tag === "FONT" && ch.getAttribute("size")) ns.size = Math.max(1, Math.min(7, Number(ch.getAttribute("size")) || 3));
        const style = ch.getAttribute("style") || "";
        if (/underline/.test(style)) ns.u = true;
        if (/font-weight:\s*(bold|[6-9]00)/.test(style)) ns.b = true;
        const isBlock = !!BLOCK[tag];
        if (isBlock && cur().length) newline();
        walk(ch, ns);
        if (isBlock && cur().length) newline();
      }
    };
    walk(root, { u: false, b: false, size: 3 });
    while (lines.length && !lines[lines.length - 1].length) lines.pop();
    return lines.map((l) => (l.length ? l : [{ text: " ", u: false, b: false, size: 3 }]));
  },
  plainLength(lines) { return lines.reduce((a, l) => a + l.reduce((b, r) => b + [...r.text].length, 0), 0); },
  hasText(slide) { const lines = this.parseHtml(slide.html); return this.plainLength(lines) > 0 && lines.some((l) => l.some((r) => r.text.trim())); },

  // opts: { static, noText, noImages, noBg }
  drawSlide(ctx, W, H, slide, t, P, runtime, opts) {
    opts = opts || {};
    const colors = this.colorsOf(slide, P);
    VC.text.use(colors);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    const dur = this.slideDuration(slide);
    const hasVideo = !!slide.video;
    if (hasVideo) {
      const st = this.slideVideoState(slide, t);
      const v = st ? runtime.videos[st.id] : null;
      if (v && v.videoWidth) VC.render.drawVideo(ctx, W, H, v);
      else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); }
      if (st) for (const c of VC.timeline.captionsAt(slide.ranges, st.src)) VC.render.drawCaption(ctx, W, H, c, st.src);
    }
    if (!opts.noImages) this.drawImages(ctx, W, H, slide, runtime);
    if (!opts.noText) {
      const lines = this.parseHtml(slide.html);
      if (this.plainLength(lines) && lines.some((l) => l.some((r) => r.text.trim()))) {
        this.drawText(ctx, W, H, lines, t, dur, P, colors, { pos: slide.pos || "center", align: slide.align || "center", overMedia: hasVideo || (slide.images || []).length > 0, static: !!opts.static });
      }
    }
  },

  // 文字のアニメーション：型に合わせる（typewriter＝タイプ→じわっと左→一瞬で退場 / classic＝行ごとにポップイン→フェード）
  drawText(ctx, W, H, lines, t, dur, P, colors, o) {
    o = o || {};
    const pos = o.pos || "center", align = o.align || "center";
    const tw = VC.opening.isType(P, "typewriter");
    const base = H * 0.07;
    const laid = lines.map((l) => {
      const runs = l.map((r) => {
        const size = base * (this.SIZE_MULT[r.size] || 1);
        ctx.font = `${r.b ? 800 : 600} ${size}px ${VC.text.FONT}`;
        return Object.assign({}, r, { size, w: ctx.measureText(r.text).width });
      });
      const w = runs.reduce((a, r) => a + r.w, 0);
      const h = Math.max(base, ...runs.map((r) => r.size)) * 1.3;
      return { runs, w, h };
    });
    const maxW = W * 0.86;
    const widest = Math.max(1, ...laid.map((l) => l.w));
    const sc = Math.min(1, maxW / widest);
    const totalH = laid.reduce((a, l) => a + l.h, 0) * sc;
    const cy = pos === "top" ? H * 0.12 + totalH / 2 : pos === "bottom" ? H * 0.88 - totalH / 2 : H / 2;
    const lineX = (lw) => (align === "left" ? W * 0.07 : align === "right" ? W * 0.93 - lw : W / 2 - lw / 2);
    let alpha = 1, dx = 0, shownChars = Infinity, lineAnim = null, blur = 0;
    const exit = 0.22;
    const N = this.plainLength(lines);
    if (o.static) {
      // 編集画面用：全文を静止表示
    } else if (tw) {
      const charDur = Math.min(0.05, (dur * 0.5) / Math.max(1, N));
      const stay = Math.max(0.1, dur - exit);
      const drift = W * 0.018;
      if (t < stay) {
        shownChars = Math.min(N, Math.floor(t / charDur) + 1);
        const f = Math.min(1, t / stay);
        dx = drift - 2 * drift * (1 - Math.pow(1 - f, 1.6));
      } else {
        const q = Math.min(1, (t - stay) / exit);
        const e = q * q * q;
        dx = -drift - e * W * 1.3;
        blur = Math.sin(Math.PI * q);
        alpha = o.overMedia ? 1 - q : 1 - Math.max(0, q - 0.8) / 0.2;
      }
    } else {
      lineAnim = laid.map((_, i) => {
        const q = Math.max(0, Math.min(1, (t - i * 0.16) / 0.28));
        return { a: q, sc: 1.18 - 0.18 * (1 - Math.pow(1 - q, 3)) };
      });
      if (t > dur - exit) alpha = Math.max(0, (dur - t) / exit);
    }
    if (o.overMedia) {
      ctx.save();
      ctx.globalAlpha = 0.55 * alpha;
      ctx.fillStyle = colors.bg;
      const bw = widest * sc + base;
      const bl = lineX(widest * sc) - base / 2;
      VC.render.rrect(ctx, bl + dx, cy - totalH / 2 - base * 0.3, bw, totalH + base * 0.6, base * 0.3);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let y = cy - totalH / 2, count = 0, cursor = null;
    laid.forEach((l, li) => {
      const lh = l.h * sc, ly = y + lh / 2;
      const lw = l.w * sc;
      let x = lineX(lw) + dx;
      const la = lineAnim ? lineAnim[li] : null;
      ctx.save();
      if (la) { const cx = x + lw / 2; ctx.translate(cx, ly); ctx.scale(la.sc, la.sc); ctx.translate(-cx, -ly); }
      for (const r of l.runs) {
        const size = r.size * sc;
        ctx.font = `${r.b ? 800 : 600} ${size}px ${VC.text.FONT}`;
        let text = r.text;
        if (shownChars !== Infinity) {
          const chars = [...text];
          const take = Math.max(0, Math.min(chars.length, shownChars - count));
          count += chars.length;
          text = chars.slice(0, take).join("");
          if (take < chars.length && !cursor) cursor = { x: x + ctx.measureText(text).width, y: ly, size };
        }
        ctx.fillStyle = colors.fg;
        if (blur > 0) for (let i = 1; i <= 4; i++) { ctx.globalAlpha = alpha * 0.1; ctx.fillText(text, x + i * blur * W * 0.03, ly); }
        ctx.globalAlpha = alpha * (la ? la.a : 1);
        ctx.fillText(text, x, ly);
        if (r.u && text.trim()) ctx.fillRect(x, ly + size * 0.45, ctx.measureText(text).width, Math.max(1.5, size * 0.07));
        x += r.w * sc;
      }
      ctx.restore();
      y += lh;
    });
    if (cursor) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = colors.fg;
      ctx.fillRect(cursor.x + cursor.size * 0.08, cursor.y - cursor.size * 0.5, Math.max(2, cursor.size * 0.07), cursor.size);
    }
    ctx.restore();
  },

  // ---------- 動画モンタージュ ----------
  montageDuration(ins) { return Math.max(0.5, Number(ins.montageDur) || 4) + Math.max(0, Number(ins.lastHold) || 0); },
  montageSlots(ins) {
    const d = Math.max(0.5, Number(ins.montageDur) || 4);
    const times = VC.opening.switchTimes({ montageDur: d, intervalStart: Number(ins.intervalStart) || 0.5, intervalEnd: Number(ins.intervalEnd) || 0.08, accel: Number(ins.accel) || 2 });
    const n = ins.videos.length;
    const offs = ins.videos.map(() => 0);
    return times.map((t, i) => {
      const dur = (i < times.length - 1 ? times[i + 1] : d) - t;
      if (!n) return { t, dur, idx: -1, hue: (i * 47) % 360 };
      const idx = i % n;
      const v = ins.videos[idx];
      const vd = Number(v.duration) || 0;
      const rs = Math.max(0, Math.min(vd, Number(v.start) || 0));
      const re = Math.max(rs + 0.05, Math.min(vd, v.end == null ? vd : Number(v.end)));
      let st = rs + offs[idx];
      if (st + dur > re) { offs[idx] = 0; st = rs; }
      offs[idx] += dur;
      if (rs + offs[idx] >= re) offs[idx] = 0;
      return { t, dur, idx, id: v.id, start: st, hue: (i * 47) % 360 };
    });
  },
  montageState(ins, t) {
    const slots = this.montageSlots(ins);
    if (!slots.length) return null;
    const d = Math.max(0.5, Number(ins.montageDur) || 4);
    const tt = Math.min(t, d - 1e-3);
    let s = slots[0];
    for (const x of slots) { if (x.t <= tt) s = x; else break; }
    if (!s || s.idx < 0) return null;
    return { id: s.id, time: s.start + Math.min(tt - s.t, s.dur), rate: 1, slot: s };
  },
  drawMontage(ctx, W, H, ins, t, P, runtime) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const st = this.montageState(ins, t);
    const v = st ? runtime.videos[st.id] : null;
    if (v && v.videoWidth) { VC.render.drawVideoCover(ctx, W, H, v); return; }
    const slots = this.montageSlots(ins);
    let s = slots[0];
    for (const x of slots) { if (x.t <= t) s = x; else break; }
    const hue = s ? s.hue : 200;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${hue}, 60%, 40%)`); g.addColorStop(1, `hsl(${(hue + 60) % 360}, 60%, 22%)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.font = `700 ${Math.round(H * 0.06)}px ${VC.text.FONTS.sans}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(ins.videos.length ? "読み込み中…" : "動画を追加してください", W / 2, H / 2);
  },

  // ---------- 共通 ----------
  videoState(ins, t) {
    if (ins.type === "montage") return this.montageState(ins, t);
    const sa = this.slideAt(ins, t);
    return sa ? this.slideVideoState(sa.slide, sa.local) : null;
  },
  draw(ctx, W, H, ins, t, P, runtime) {
    if (ins.type === "montage") { this.drawMontage(ctx, W, H, ins, t, P, runtime); return; }
    const sa = this.slideAt(ins, t);
    if (sa) this.drawSlide(ctx, W, H, sa.slide, sa.local, P, runtime);
  },
};
