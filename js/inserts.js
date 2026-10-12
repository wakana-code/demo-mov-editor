window.VC = window.VC || {};

// 埋め込み（デッキ）：ページ＝スライド（文字／画像／動画）またはモンタージュ用ページ
// 連続するモンタージュページ（同じ group）は1つの「モンタージュブロック」として加速切り替えで流れる
VC.inserts = {
  SIZE_MULT: { 1: 0.55, 2: 0.75, 3: 1, 4: 1.3, 5: 1.7, 6: 2.2, 7: 2.8 },

  newPage(kind) {
    return { id: VC.store.uid("s"), kind: kind || "slide", html: "", dur: 2.5, bg: null, fg: null, pos: "center", align: "center", images: [], video: null, ranges: [], group: null };
  },
  newGroup() { return { montageDur: 4, intervalStart: 0.5, intervalEnd: 0.08, accel: 2, lastHold: 0.4 }; },
  newDeck() { return { id: VC.store.uid("ins"), type: "deck", at: null, name: "", pages: [this.newPage("slide")], groups: {} }; },

  normalize(ins) {
    if (!ins || !ins.id) return null;
    // 旧形式からの移行
    if (ins.type === "montage") {
      const gid = VC.store.uid("g");
      const g = Object.assign(this.newGroup(), { montageDur: ins.montageDur, intervalStart: ins.intervalStart, intervalEnd: ins.intervalEnd, accel: ins.accel, lastHold: ins.lastHold });
      const pages = (ins.videos || []).map((v) => Object.assign(this.newPage("montage"), { video: v, group: gid }));
      ins = { id: ins.id, type: "deck", at: ins.at, name: "モンタージュ", pages, groups: { [gid]: g } };
    } else if (ins.type === "slides") {
      ins = { id: ins.id, type: "deck", at: ins.at, name: "", pages: ins.slides || [], groups: {} };
    }
    ins.type = "deck";
    ins.groups = ins.groups && typeof ins.groups === "object" ? ins.groups : {};
    for (const gid in ins.groups) ins.groups[gid] = Object.assign(this.newGroup(), ins.groups[gid]);
    ins.pages = Array.isArray(ins.pages) && ins.pages.length ? ins.pages : [this.newPage("slide")];
    for (const p of ins.pages) {
      if (!p.id) p.id = VC.store.uid("s");
      if (!p.kind) p.kind = "slide";
      if (p.group === undefined) p.group = null;
      if (p.kind === "montage" && !(p.group && ins.groups[p.group])) { p.kind = "slide"; p.group = null; }
      if (!Array.isArray(p.ranges)) p.ranges = [];
      if (!Array.isArray(p.images)) p.images = [];
      if (p.dur == null) p.dur = 2.5;
      if (!p.pos) p.pos = "center";
      if (!p.align) p.align = "center";
      if (p.html == null) p.html = "";
      if (p.video === undefined) p.video = null;
    }
    if (ins.at === undefined) ins.at = null;
    if (ins.name == null) ins.name = "";
    return ins;
  },

  label(deck) {
    const nm = String(deck.name || "").trim();
    const nM = deck.pages.filter((p) => p.kind === "montage").length;
    return `🧩 ${nm || `スライド（${deck.pages.length}ページ${nM ? `・モンタージュ${nM}` : ""}）`}`;
  },
  videoRefs(deck) { return deck.pages.filter((p) => p.video).map((p) => p.video); },
  imageRefs(deck) { return deck.pages.reduce((a, p) => a.concat(p.images || []), []); },
  colorsOf(page, P) {
    const base = (P && P.colors) || VC.styles.defaultColors(P && P.style);
    return { bg: (page && page.bg) || base.bg, fg: (page && page.fg) || base.fg, font: base.font };
  },

  // ---------- 長さ・位置 ----------
  useRange(v) {
    const d = Number(v.duration) || 0;
    const s = Math.max(0, Math.min(d, Number(v.start) || 0));
    const e = Math.max(s + 0.05, Math.min(Math.max(d, s + 0.05), v.end == null ? d : Number(v.end)));
    return { start: s, end: e, dur: e - s };
  },
  pageSegs(page) { return page.video && page.kind !== "montage" ? VC.timeline.segments([page.video], page.ranges || []) : []; },
  pageDuration(page) {
    if (page.kind === "montage") return page.video ? this.useRange(page.video).dur : 1;
    if (page.video) { const d = VC.timeline.outputDuration(this.pageSegs(page)); return d > 0 ? d : 0.1; }
    return Math.max(0.3, Number(page.dur) || 2.5);
  },
  pageVideoState(page, t) {
    if (!page.video) return null;
    if (page.kind === "montage") {
      const r = this.useRange(page.video);
      const time = Math.min(r.end - 1e-3, r.start + Math.max(0, t));
      return { id: page.video.id, time, rate: 1, src: time, seg: null };
    }
    const segs = this.pageSegs(page);
    const seg = VC.timeline.segAtOut(segs, t) || segs.filter((g) => !g.cut).pop();
    if (!seg) return null;
    const src = Math.max(0, Math.min(seg.end - 1e-4, seg.start + (t - seg.outStart) * seg.rate));
    return { id: page.video.id, time: src, rate: seg.rate, src, seg };
  },

  montageDuration(g) { return Math.max(0.5, Number(g.montageDur) || 4) + Math.max(0, Number(g.lastHold) || 0); },

  // 連続するモンタージュページをまとめたブロック列
  blocks(deck) {
    const out = [];
    let i = 0;
    while (i < deck.pages.length) {
      const p = deck.pages[i];
      if (p.kind === "montage" && p.group && deck.groups[p.group]) {
        const gid = p.group, pages = [];
        while (i < deck.pages.length && deck.pages[i].kind === "montage" && deck.pages[i].group === gid) pages.push(deck.pages[i++]);
        out.push({ kind: "montage", gid, g: deck.groups[gid], pages, dur: this.montageDuration(deck.groups[gid]) });
      } else {
        out.push({ kind: "slide", page: p, dur: this.pageDuration(p) });
        i++;
      }
    }
    return out;
  },
  duration(deck) { return this.blocks(deck).reduce((a, b) => a + b.dur, 0); },
  blockAt(deck, t) {
    const bs = this.blocks(deck);
    let acc = 0;
    for (const b of bs) {
      if (t < acc + b.dur) return { block: b, local: t - acc, start: acc };
      acc += b.dur;
    }
    const last = bs[bs.length - 1];
    return last ? { block: last, local: last.dur - 0.001, start: acc - last.dur } : null;
  },
  pageOffset(deck, pageId) {
    let acc = 0;
    for (const b of this.blocks(deck)) {
      if (b.kind === "slide" ? b.page.id === pageId : b.pages.some((p) => p.id === pageId)) return acc;
      acc += b.dur;
    }
    return 0;
  },
  blockOfPage(deck, pageId) { return this.blocks(deck).find((b) => (b.kind === "slide" ? b.page.id === pageId : b.pages.some((p) => p.id === pageId))) || null; },

  // ---------- モンタージュ ----------
  blockVideos(block) { return block.pages.map((p) => p.video).filter(Boolean); },
  montageSlots(g, videos) {
    const d = Math.max(0.5, Number(g.montageDur) || 4);
    const times = VC.opening.switchTimes({ montageDur: d, intervalStart: Number(g.intervalStart) || 0.5, intervalEnd: Number(g.intervalEnd) || 0.08, accel: Number(g.accel) || 2 });
    const n = videos.length;
    const offs = videos.map(() => 0);
    return times.map((t, i) => {
      const dur = (i < times.length - 1 ? times[i + 1] : d) - t;
      if (!n) return { t, dur, idx: -1, hue: (i * 47) % 360 };
      const idx = i % n;
      const v = videos[idx];
      const r = this.useRange(v);
      let st = r.start + offs[idx];
      if (st + dur > r.end) { offs[idx] = 0; st = r.start; }
      offs[idx] += dur;
      if (r.start + offs[idx] >= r.end) offs[idx] = 0;
      return { t, dur, idx, id: v.id, start: st, hue: (i * 47) % 360 };
    });
  },
  montageState(block, t) {
    const videos = this.blockVideos(block);
    const slots = this.montageSlots(block.g, videos);
    if (!slots.length) return null;
    const d = Math.max(0.5, Number(block.g.montageDur) || 4);
    const tt = Math.min(t, d - 1e-3);
    let s = slots[0];
    for (const x of slots) { if (x.t <= tt) s = x; else break; }
    if (!s || s.idx < 0) return null;
    return { id: s.id, time: s.start + Math.min(tt - s.t, s.dur), rate: 1, slot: s };
  },
  drawMontageBlock(ctx, W, H, block, t, runtime) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const st = this.montageState(block, t);
    const v = st ? runtime.videos[st.id] : null;
    if (v && v.videoWidth) { VC.render.drawVideoCover(ctx, W, H, v); return; }
    const slots = this.montageSlots(block.g, this.blockVideos(block));
    let s = slots[0];
    for (const x of slots) { if (x.t <= t) s = x; else break; }
    const hue = s ? s.hue : 200;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${hue}, 60%, 40%)`); g.addColorStop(1, `hsl(${(hue + 60) % 360}, 60%, 22%)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.7)";
    ctx.font = `700 ${Math.round(H * 0.06)}px ${VC.text.FONTS.sans}`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(this.blockVideos(block).length ? "読み込み中…" : "モンタージュ用の動画がありません", W / 2, H / 2);
  },

  // ---------- 画像 ----------
  newImage(id, name, natW, natH, W, H) {
    const w = 0.42;
    const h = (w * W * natH / natW) / H;
    return { id, name: name || "image", x: (1 - w) / 2, y: (1 - h) / 2, w, h, sx: 0, sy: 0, sw: 1, sh: 1 };
  },
  drawImages(ctx, W, H, page, runtime) {
    for (const im of page.images || []) {
      const img = runtime.images[im.id];
      if (!img || !img.naturalWidth) continue;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      try { ctx.drawImage(img, im.sx * nw, im.sy * nh, Math.max(1, im.sw * nw), Math.max(1, im.sh * nh), im.x * W, im.y * H, im.w * W, im.h * H); } catch (e) {}
    }
  },

  // ---------- 文字 ----------
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
  hasText(page) { const lines = this.parseHtml(page.html); return this.plainLength(lines) > 0 && lines.some((l) => l.some((r) => r.text.trim())); },

  // ---------- ページ描画 ----------
  // opts: { static（全文を静止表示）, live（動画要素の今のフレームをそのまま描く）, noText, noImages }
  drawPage(ctx, W, H, page, t, P, runtime, opts) {
    opts = opts || {};
    const colors = this.colorsOf(page, P);
    VC.text.use(colors);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, W, H);
    const hasVideo = !!page.video;
    if (hasVideo) {
      const st = opts.live ? null : this.pageVideoState(page, t);
      const v = runtime.videos[page.video.id];
      if (v && v.videoWidth) { if (page.kind === "montage") VC.render.drawVideoCover(ctx, W, H, v); else VC.render.drawVideo(ctx, W, H, v); }
      else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); }
      if (page.kind !== "montage") {
        const src = st ? st.src : (opts.src != null ? opts.src : null);
        if (src != null) for (const c of VC.timeline.captionsAt(page.ranges, src)) VC.render.drawCaption(ctx, W, H, c, src);
      }
    }
    if (!opts.noImages) this.drawImages(ctx, W, H, page, runtime);
    if (!opts.noText && this.hasText(page)) {
      this.drawText(ctx, W, H, this.parseHtml(page.html), t, this.pageDuration(page), P, colors, { pos: page.pos || "center", align: page.align || "center", overMedia: hasVideo || (page.images || []).length > 0, static: !!opts.static });
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

  // ---------- デッキ全体 ----------
  videoState(deck, t) {
    const ba = this.blockAt(deck, t);
    if (!ba) return null;
    if (ba.block.kind === "montage") return this.montageState(ba.block, ba.local);
    return this.pageVideoState(ba.block.page, ba.local);
  },
  draw(ctx, W, H, deck, t, P, runtime) {
    const ba = this.blockAt(deck, t);
    if (!ba) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); return; }
    if (ba.block.kind === "montage") this.drawMontageBlock(ctx, W, H, ba.block, ba.local, runtime);
    else this.drawPage(ctx, W, H, ba.block.page, ba.local, P, runtime);
  },
};
