window.VC = window.VC || {};

// フレーム合成：出力時間 T → どのフェーズ・どの動画の何秒目か → Canvas に描く
VC.render = {
  PHASES: { OPEN: "opening", MAIN: "main", END: "ending" },

  info(P) {
    const opDur = VC.opening.duration(P.opening);
    const segs = VC.timeline.segments(P.clips, P.ranges);
    const outDur = VC.timeline.outputDuration(segs);
    const edDur = VC.ending.duration(P.ending);
    return { opDur, segs, outDur, edDur, total: opDur + outDur + edDur, srcTotal: VC.timeline.totalSource(P.clips) };
  },

  // T（全体の出力時間）から描画に必要な情報を求める
  locate(P, T, info) {
    info = info || this.info(P);
    if (T < info.opDur) return { phase: "opening", local: T, info };
    const o = T - info.opDur;
    if (o < info.outDur && P.clips.length) {
      const seg = VC.timeline.segAtOut(info.segs, o) || info.segs.filter((g) => !g.cut).pop();
      const src = seg ? Math.min(seg.end - 1e-4, seg.start + (o - seg.outStart) * seg.rate) : 0;
      const ca = VC.timeline.clipAt(P.clips, src);
      return { phase: "main", local: o, seg, src, clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0, info };
    }
    return { phase: "ending", local: Math.max(0, T - info.opDur - info.outDur), info };
  },

  // ソース時刻を直接指定（カット区間のスクラブ表示用）
  locateSrc(P, src, info) {
    info = info || this.info(P);
    const ca = VC.timeline.clipAt(P.clips, src);
    return { phase: "main", local: VC.timeline.srcToOut(info.segs, src), src, clip: ca ? ca.clip : null, clipLocal: ca ? ca.local : 0, info };
  },

  draw(ctx, W, H, loc, P, runtime) {
    if (loc.phase === "opening") { VC.opening.draw(ctx, W, H, loc.local, P.opening, runtime.images); return; }
    if (loc.phase === "ending") { VC.ending.draw(ctx, W, H, loc.local, P.ending); return; }
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const v = loc.clip ? runtime.videos[loc.clip.id] : null;
    if (v && v.videoWidth) this.drawVideo(ctx, W, H, v);
    const caps = VC.timeline.captionsAt(P.ranges, loc.src);
    for (const c of caps) this.drawCaption(ctx, W, H, c, loc.src);
  },

  drawVideo(ctx, W, H, v) {
    const sc = Math.min(W / v.videoWidth, H / v.videoHeight);
    const dw = v.videoWidth * sc, dh = v.videoHeight * sc;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  },

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

  // カラオケ字幕：現在の単語だけ色が変わり、進行とともに移動する
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
