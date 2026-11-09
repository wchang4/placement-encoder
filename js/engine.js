// engine.js
// Wraps ffmpeg.wasm: loads the encoder (cached after first visit), probes files,
// runs encodes with progress, and can cancel. Nothing here touches the page layout.
//
// Library versions are pinned and self-hosted in /vendor (see PHASE0-REPORT.md).
//
// WHY TWO INSTANCES: in this ffmpeg.wasm build, running ffprobe and ffmpeg in the
// same instance does not work reliably (ffprobe after an encode returns nothing,
// an encode after ffprobe hangs). So we keep two separate instances:
//   - "probe": only ever runs ffprobe (reading file details).
//   - "enc":   only ever runs ffmpeg (encoding).

import { FFmpeg } from '../vendor/ffmpeg/index.js';

const CORE_VERSION = '0.12.10';
const CORE_JS = './vendor/core/ffmpeg-core.js';
const CORE_WASM = './vendor/core/ffmpeg-core.wasm';

// Download a file with progress; keep it in the browser's Cache Storage so the
// ~31 MB encoder is only downloaded once. Falls back to a normal download if
// Cache Storage is unavailable (private windows, some Safari settings).
async function fetchCached(url, type, onProgress) {
  const abs = new URL(url, location.href).href;
  let cache = null;
  try { cache = await caches.open('placement-encoder-core-' + CORE_VERSION); } catch (e) { /* no cache */ }
  if (cache) {
    try {
      const hit = await cache.match(abs);
      if (hit) { const b = await hit.blob(); onProgress?.(b.size, b.size, true); return new Blob([b], { type }); }
    } catch (e) { /* ignore and download */ }
  }
  const res = await fetch(abs);
  if (!res.ok) throw new Error('Could not download ' + url + ' (HTTP ' + res.status + ')');
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.(got, total, false);
  }
  const blob = new Blob(chunks, { type });
  if (cache) { try { await cache.put(abs, new Response(blob, { headers: { 'content-type': type } })); } catch (e) { /* cache full: fine */ } }
  return blob;
}

export class Engine {
  constructor() {
    this.enc = null;          // ffmpeg instance used only for encoding
    this.prb = null;          // ffmpeg instance used only for ffprobe
    this.urls = null;         // blob URLs of the loaded core files
    this.encReady = false;
    this.prbReady = false;
    this.encMounted = false;
    this.prbMounted = false;
    this.logLines = [];       // recent encoder log lines (for error messages)
    this._capture = null;     // collects ffprobe output while probing
    this._onTime = null;
  }

  get ready() { return this.encReady && this.prbReady; }

  // Load both instances. onProgress(loadedBytes, totalBytes, fromCache) reports the download.
  async load(onProgress) {
    if (!this.urls) {
      const wasmBlob = await fetchCached(CORE_WASM, 'application/wasm', onProgress);
      const jsBlob = await fetchCached(CORE_JS, 'text/javascript');
      this.urls = { coreURL: URL.createObjectURL(jsBlob), wasmURL: URL.createObjectURL(wasmBlob) };
    }
    if (!this.prbReady) {
      this.prb = new FFmpeg();
      // ffprobe prints its result through the log; we capture those lines.
      this.prb.on('log', ({ message }) => { if (this._capture) this._capture.push(message); });
      await this.prb.load(this.urls);
      this.prbReady = true; this.prbMounted = false;
    }
    if (!this.encReady) {
      this.enc = new FFmpeg();
      this.enc.on('log', ({ message }) => {
        if (this._acap) this._acap.push(message);
        this.logLines.push(message);
        if (this.logLines.length > 400) this.logLines.shift();
        // ffmpeg prints "time=00:00:12.34" while encoding; we turn that into progress.
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(message);
        if (m && this._onTime) this._onTime(+m[1] * 3600 + +m[2] * 60 + +m[3]);
      });
      await this.enc.load(this.urls);
      this.encReady = true; this.encMounted = false;
    }
  }

  // Make a File/Blob readable by ffmpeg without copying it into memory (WORKERFS).
  async _mount(ff, blob, ext, which) {
    if (this[which + 'Mounted']) { try { await ff.unmount('/in'); } catch (e) { /* ignore */ } }
    try { await ff.createDir('/in'); } catch (e) { /* already exists */ }
    const name = 'input' + ext;
    await ff.mount('WORKERFS', { blobs: [{ name, data: blob }] }, '/in');
    this[which + 'Mounted'] = true;
    return '/in/' + name;
  }
  static extOf(file) { return (/\.[A-Za-z0-9]+$/.exec(file.name || '') || ['.bin'])[0].toLowerCase(); }

  // Mount the source for encoding. Returns the path ffmpeg should read.
  async mountForEncode(file) {
    await this.load();
    return this._mount(this.enc, file, Engine.extOf(file), 'enc');
  }

  // Read a file's technical details with ffprobe. Accepts a File or a Blob.
  // Returns ffprobe's JSON. (ffmpeg.wasm's ffprobe always returns -1 and ignores
  // "-o", so we parse the JSON from the captured log instead.)
  async probe(blob, ext) {
    await this.load();
    const path = await this._mount(this.prb, blob, ext || Engine.extOf(blob), 'prb');
    this._capture = [];
    try {
      await this.prb.ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
      const text = this._capture.join('\n');
      const start = text.indexOf('{');
      if (start < 0) throw new Error('no json');
      const probe = JSON.parse(text.slice(start));
      if (!probe.format) throw new Error('no format');
      return probe;
    } catch (e) {
      throw new Error('Could not read this file. It may not be a video, or it may use an unsupported format.');
    } finally {
      this._capture = null;
    }
  }

  // Run an encode. onTime(seconds of video done) fires while it runs.
  async encode(args, onTime) {
    await this.load();
    this.logLines = [];
    this._onTime = onTime;
    try {
      const code = await this.enc.exec(args);
      if (code !== 0) {
        const tail = this.logLines.slice(-6).join('\n');
        throw new Error('ffmpeg stopped with an error (code ' + code + ').\n' + tail);
      }
    } finally {
      this._onTime = null;
    }
  }

  // Run any ffmpeg command and hand back ALL its log lines (used by the analysis
  // passes in analyze.js, which read numbers out of the log). Does not throw on a
  // non-zero exit code; the caller decides what that means.
  async exec(args, onTime) {
    await this.load();
    this._acap = [];
    this._onTime = onTime || null;
    try {
      const code = await this.enc.exec(args);
      return { code, lines: this._acap };
    } finally {
      this._acap = null;
      this._onTime = null;
    }
  }

  // Read a finished file out of the encoder's memory, then free it there.
  async takeOutput(name) {
    const data = await this.enc.readFile(name);
    try { await this.enc.deleteFile(name); } catch (e) { /* ignore */ }
    return data;
  }

  // Stop immediately. The encoder is reloaded (from cache) on next use.
  cancel() {
    try { this.enc?.terminate(); } catch (e) { /* ignore */ }
    this.encReady = false; this.encMounted = false; this.enc = null;
  }
}
