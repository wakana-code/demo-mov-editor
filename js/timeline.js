window.VC = window.VC || {};

// 結合済み「元動画」の時間軸（source）と、カット・倍速を反映した「出力」の時間軸（output）の変換
VC.timeline = {
  totalSource(clips) { return (clips || []).reduce((a, c) => a + (c.duration || 0), 0); },

  clipAt(clips, s) {
    let acc = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const d = c.duration || 0;
      if (s < acc + d || i === clips.length - 1) {
        return { clip: c, index: i, offset: acc, local: Math.max(0, Math.min(d, s - acc)) };
      }
      acc += d;
    }
    return null;
  },
  clipOffset(clips, index) {
    let acc = 0;
    for (let i = 0; i < index; i++) acc += clips[i].duration || 0;
    return acc;
  },

  // 範囲（カット・倍速）を反映したセグメント一覧
  segments(clips, ranges) {
    const total = this.totalSource(clips);
    if (total <= 0) return [];
    const clamp = (x) => Math.max(0, Math.min(total, Number(x) || 0));
    const bs = new Set([0, total]);
    for (const r of ranges || []) { bs.add(clamp(r.start)); bs.add(clamp(r.end)); }
    const b = [...bs].sort((x, y) => x - y);
    const segs = [];
    let out = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const a = b[i], c = b[i + 1];
      if (c - a <= 1e-6) continue;
      const mid = (a + c) / 2;
      let cut = false, rate = 1;
      for (const r of ranges || []) {
        if (mid >= r.start && mid < r.end) {
          if (r.type === "cut") cut = true;
          else if (r.type === "speed") rate = Math.max(0.1, Number(r.rate) || 1);
        }
      }
      const olen = cut ? 0 : (c - a) / rate;
      segs.push({ start: a, end: c, cut, rate, outStart: out, outEnd: out + olen });
      out += olen;
    }
    return segs;
  },
  outputDuration(segs) { return segs.length ? segs[segs.length - 1].outEnd : 0; },

  srcToOut(segs, s) {
    for (const g of segs) {
      if (s >= g.start && s <= g.end) return g.cut ? g.outStart : g.outStart + (s - g.start) / g.rate;
    }
    return segs.length ? segs[segs.length - 1].outEnd : 0;
  },
  outToSrc(segs, o) {
    for (const g of segs) {
      if (g.cut) continue;
      if (o >= g.outStart && o < g.outEnd) return g.start + (o - g.outStart) * g.rate;
    }
    for (let i = segs.length - 1; i >= 0; i--) if (!segs[i].cut) return Math.max(segs[i].start, segs[i].end - 0.001);
    return 0;
  },
  segAtOut(segs, o) { return segs.find((g) => !g.cut && o >= g.outStart && o < g.outEnd) || null; },
  isCutAt(segs, s) { const g = segs.find((x) => s >= x.start && s < x.end); return !!(g && g.cut); },

  captionsAt(ranges, s) { return (ranges || []).filter((r) => r.type === "caption" && s >= r.start && s < r.end); },

  // クリップの削除・並び替え後に、範囲の時刻を付け替える（範囲は「どのクリップの何秒目か」で引き継ぐ）
  remapRanges(ranges, oldClips, newClips) {
    const toLocal = (s) => {
      const ca = this.clipAt(oldClips, s);
      return ca ? { id: ca.clip.id, local: ca.local } : null;
    };
    const toGlobal = (loc) => {
      const idx = newClips.findIndex((c) => c.id === loc.id);
      if (idx === -1) return null;
      return this.clipOffset(newClips, idx) + loc.local;
    };
    const out = [];
    for (const r of ranges) {
      const a = toLocal(r.start), b = toLocal(Math.max(r.start, r.end - 1e-4));
      if (!a || !b) continue;
      const ga = toGlobal(a), gb = toGlobal(b);
      if (ga == null || gb == null) continue;
      const start = Math.min(ga, gb), end = Math.max(ga, gb) + 1e-4;
      if (end - start < 0.05) continue;
      out.push(Object.assign({}, r, { start, end }));
    }
    return out;
  },

  fmt(t) {
    t = Math.max(0, Number(t) || 0);
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  },
  fmtMs(t) {
    t = Math.max(0, Number(t) || 0);
    const m = Math.floor(t / 60), s = (t % 60).toFixed(1).padStart(4, "0");
    return `${m}:${s}`;
  },
};
