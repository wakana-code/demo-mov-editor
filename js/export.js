window.VC = window.VC || {};

// 書き出し：1フレームずつ描いてエンコード。Chrome = WebCodecs + mp4-muxer（mp4）、他 = MediaRecorder（webm）
VC.exporter = {
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

  async pickAvc(W, H, fps) {
    if (!("VideoEncoder" in window) || !window.Mp4Muxer) return null;
    const codecs = ["avc1.640033", "avc1.64002a", "avc1.640028", "avc1.4d0028", "avc1.42001f"];
    for (const codec of codecs) {
      try {
        const cfg = { codec, width: W, height: H, bitrate: Math.round(W * H * fps * 0.1), framerate: fps, latencyMode: "quality" };
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) return cfg;
      } catch (e) { /* next */ }
    }
    return null;
  },
  async canMp4(W, H, fps) { return !!(await this.pickAvc(W || 1920, H || 1080, fps || 30)); },

  seekTo(v, t) {
    return new Promise((res) => {
      t = Math.max(0, Math.min(isFinite(v.duration) ? v.duration : t, t));
      if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return res();
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); res(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 2500);
      v.currentTime = t;
    });
  },

  // opts: { canvas, P, runtime, fps, onProgress(p, text), isCancelled() }
  async run(opts) {
    const { canvas, P, runtime, fps } = opts;
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext("2d");
    const info = VC.render.info(P);
    const total = info.total;
    const nFrames = Math.max(1, Math.ceil(total * fps));
    for (const id in runtime.videos) { try { runtime.videos[id].pause(); } catch (e) {} }

    const cfg = await this.pickAvc(W, H, fps);
    if (cfg) return this.runMp4(opts, { W, H, ctx, info, nFrames, cfg });
    return this.runWebm(opts, { W, H, ctx, info, nFrames });
  },

  async prepare(P, runtime, info, T) {
    const loc = VC.render.locate(P, T, info);
    if (loc.phase === "insert") {
      const st = VC.inserts.videoState(loc.ins, loc.local);
      if (st && runtime.videos[st.id]) await this.seekTo(runtime.videos[st.id], st.time);
      return loc;
    }
    if ((loc.phase === "main" || loc.trans != null) && loc.clip) {
      const v = runtime.videos[loc.clip.id];
      if (v) await this.seekTo(v, loc.clipLocal);
    }
    return loc;
  },

  async runMp4(opts, c) {
    const { P, runtime, fps, onProgress, isCancelled } = opts;
    const { W, H, ctx, info, nFrames, cfg } = c;
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: W, height: H },
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });
    let encErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encErr = e; },
    });
    encoder.configure(cfg);
    const us = 1e6 / fps;
    const t0 = performance.now();
    for (let i = 0; i < nFrames; i++) {
      if (isCancelled && isCancelled()) { try { encoder.close(); } catch (e) {} return null; }
      if (encErr) throw encErr;
      const T = i / fps;
      const loc = await this.prepare(P, runtime, info, T);
      VC.render.draw(ctx, W, H, loc, P, runtime);
      const frame = new VideoFrame(ctx.canvas, { timestamp: Math.round(i * us), duration: Math.round(us) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 8) await this.sleep(4);
      if (onProgress && (i % 3 === 0 || i === nFrames - 1)) {
        const el = (performance.now() - t0) / 1000;
        const eta = i ? (el / (i + 1)) * (nFrames - i - 1) : 0;
        onProgress((i + 1) / nFrames, `${i + 1} / ${nFrames} フレーム　残り約 ${Math.ceil(eta)} 秒`);
      }
    }
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4" };
  },

  async runWebm(opts, c) {
    const { P, runtime, fps, onProgress, isCancelled } = opts;
    const { W, H, ctx, info, nFrames } = c;
    const stream = ctx.canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error("このブラウザは動画の書き出しに対応していません。Chrome をお使いください。");
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(W * H * fps * 0.1) });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(250);
    const frameMs = 1000 / fps;
    let next = performance.now();
    for (let i = 0; i < nFrames; i++) {
      if (isCancelled && isCancelled()) { rec.stop(); await stopped; return null; }
      const loc = await this.prepare(P, runtime, info, i / fps);
      VC.render.draw(ctx, W, H, loc, P, runtime);
      if (track.requestFrame) track.requestFrame();
      next += frameMs;
      const wait = next - performance.now();
      if (wait > 0) await this.sleep(wait); else next = performance.now();
      if (onProgress && i % 3 === 0) onProgress((i + 1) / nFrames, `${i + 1} / ${nFrames} フレーム（webm・実時間で録画中）`);
    }
    await this.sleep(300);
    rec.stop();
    await stopped;
    return { blob: new Blob(chunks, { type: "video/webm" }), ext: "webm" };
  },

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};
