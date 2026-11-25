import { LISTEN_SETS, SHADOW_GROUPS, SPEAK_QUESTIONS } from "./content.js";

// ===================== helpers =====================

const $ = (s, r = document) => r.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (typeof v === "boolean" || k === "value") el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Drops null/false entries before handing nodes to append/replaceChildren (which would print "null"). */
const clean = (xs) => xs.flat(Infinity).filter((x) => x != null && x !== false);

const local = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode: settings just won't persist */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

let toastTimer;
function toast(msg, ms = 3800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fmtSec = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
};
const fmtDay = (d) => (d ? `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日` : "");
const round = (v) => (v == null ? "—" : String(Math.round(v)));

function scoreClass(s) {
  if (s == null) return "";
  return s >= 80 ? "s-good" : s >= 60 ? "s-ok" : "s-bad";
}
function textClass(s) {
  if (s == null) return "";
  return s >= 80 ? "text-good" : s >= 60 ? "text-ok" : "text-bad";
}

// ===================== state =====================

const S = {
  pass: local.get("ielts.pass", ""),
  home: null,
  view: "shadow",
  prefs: Object.assign({ voiceA: "", voiceB: "", rate: 1 }, local.get("ielts.prefs", {})),
  focusWords: [],
  speak: { part: "Part 1", qid: null },
  listenSetId: null,
  report: null,
};

function savePrefs() {
  local.set("ielts.prefs", S.prefs);
}

// ===================== API =====================

async function api(path, { method = "GET", body, raw } = {}) {
  const opts = { method, headers: {} };
  if (S.pass) opts.headers["x-pass"] = S.pass;
  if (raw) {
    opts.body = raw;
    opts.headers["content-type"] = "application/octet-stream";
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["content-type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw Object.assign(new Error("网络连接失败，请检查网络后再试"), { code: "network" });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = Object.assign(new Error(data?.error?.message || `请求失败（${res.status}）`), {
      code: data?.error?.code,
      status: res.status,
    });
    if (res.status === 401 && data?.error?.code === "need_login") {
      S.pass = "";
      local.del("ielts.pass");
      setTimeout(boot, 0);
    }
    throw err;
  }
  return data;
}

function bumpToday() {
  if (S.home) S.home.todayCount = (S.home.todayCount || 0) + 1;
  renderTopMeta();
}

// ===================== text to speech (the phone's own English voices) =====================

const TTS = {
  ok: typeof window.speechSynthesis !== "undefined",
  voices: [],
  current: null,
  load() {
    if (!this.ok) return;
    try {
      this.voices = speechSynthesis.getVoices().filter((v) => /^en[-_]/i.test(v.lang));
    } catch {
      this.voices = [];
    }
  },
  pick(which) {
    const name = which === "B" ? S.prefs.voiceB : S.prefs.voiceA;
    const chosen = this.voices.find((v) => v.name === name);
    if (chosen) return chosen;
    const gb = this.voices.filter((v) => /en[-_]GB/i.test(v.lang));
    const rest = this.voices.filter((v) => !/en[-_]GB/i.test(v.lang));
    const pool = [...gb, ...rest];
    if (!pool.length) return null;
    if (which === "B") {
      const a = this.pick("A");
      return pool.find((v) => v !== a) || pool[0];
    }
    return pool[0];
  },
  speak(lines, btn, rateMul = 1) {
    if (!this.ok) {
      toast("这个浏览器不能朗读，请用 Safari 打开");
      return;
    }
    if (btn && this.current === btn) {
      this.stop();
      return;
    }
    this.stop();
    if (!this.voices.length) this.load();
    const list = typeof lines === "string" ? [{ text: lines }] : lines;
    this.mark(btn);
    list.forEach((ln, i) => {
      const u = new SpeechSynthesisUtterance(ln.text);
      const v = this.pick(ln.voice || "A");
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else u.lang = "en-GB";
      u.rate = clamp((S.prefs.rate || 1) * rateMul, 0.5, 1.6);
      if (i === list.length - 1) {
        u.onend = u.onerror = () => {
          if (this.current === btn) this.mark(null);
        };
      }
      speechSynthesis.speak(u);
    });
  },
  stop() {
    if (this.ok) speechSynthesis.cancel();
    this.mark(null);
  },
  mark(btn) {
    if (this.current && this.current !== btn) {
      this.current.classList.remove("playing");
      if (this.current.dataset.label) this.current.textContent = this.current.dataset.label;
    }
    this.current = btn || null;
    if (btn) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.classList.add("playing");
      btn.textContent = "■ 停止";
    }
  },
};
if (TTS.ok) {
  TTS.load();
  try {
    speechSynthesis.addEventListener("voiceschanged", () => TTS.load());
  } catch {
    /* older Safari */
  }
}

// ===================== recording =====================

function micError(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("没有麦克风权限。请在 iPhone「设置 › Safari › 麦克风」里允许，或点地址栏左边的「大小」按钮 › 网站设置 › 麦克风 › 允许");
  }
  if (name === "NotFoundError") return new Error("没找到麦克风");
  return new Error(`无法开始录音：${(e && e.message) || e}`);
}

class Recorder {
  async start(opts) {
    this.opts = opts;
    this.chunks = [];
    this.total = 0;
    this.elapsed = 0;
    this.noise = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.heard = false;
    this.closing = false;
    this.stopped = false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("这个浏览器不能录音。请用 iPhone 自带的 Safari 打开这个网址");
    }
    // Created inside the tap so iOS lets it start.
    this.ctx = new Ctx();
    const resumed = this.ctx.resume ? this.ctx.resume().catch(() => {}) : Promise.resolve();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      try {
        this.ctx.close();
      } catch {
        /* ignore */
      }
      throw micError(e);
    }
    await resumed;
    if (this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        /* keep going; the meter will show if audio flows */
      }
    }
    this.rate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(this.ctx.destination);
    let node = null;
    if (this.ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        await this.ctx.audioWorklet.addModule("/recorder-worklet.js");
        node = new AudioWorkletNode(this.ctx, "pcm-capture");
        node.port.onmessage = (e) => this.onChunk(e.data);
      } catch {
        node = null;
      }
    }
    if (!node) {
      node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this.onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    this.node = node;
    this.source.connect(node);
    node.connect(this.sink);
    this.startedAt = performance.now();
    this.tick = setInterval(() => {
      const s = (performance.now() - this.startedAt) / 1000;
      if (opts.onTick) opts.onTick(s);
      if (s >= opts.maxSec) this.requestStop();
    }, 200);
  }

  onChunk(f) {
    if (this.stopped) return;
    this.chunks.push(f);
    this.total += f.length;
    if (this.closing) return;
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / Math.max(1, f.length));
    const ms = (f.length / this.rate) * 1000;
    this.elapsed += ms;
    if (this.opts.onLevel) this.opts.onLevel(rms);
    if (this.elapsed < 350) {
      this.noise.push(rms);
      return;
    }
    const thr = Math.max(0.012, (median(this.noise) || 0.002) * 3);
    if (rms > thr) {
      this.speechMs += ms;
      if (this.speechMs > 250) this.heard = true;
      this.silenceMs = 0;
    } else if (this.heard) {
      this.silenceMs += ms;
      if (this.opts.autoStopMs && this.silenceMs > this.opts.autoStopMs) this.requestStop();
    }
  }

  requestStop() {
    if (this.closing) return;
    if (this.opts.onAutoStop) this.opts.onAutoStop();
  }

  async stop() {
    if (this.stopped || this.closing) return null;
    this.closing = true;
    clearInterval(this.tick);
    try {
      if (this.node && this.node.port) this.node.port.postMessage("flush");
    } catch {
      /* ScriptProcessor has no port */
    }
    await new Promise((r) => setTimeout(r, 80));
    this.stopped = true;
    for (const n of [this.source, this.node, this.sink]) {
      try {
        if (n) n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    try {
      if (this.ctx) await this.ctx.close();
    } catch {
      /* ignore */
    }
    if (!this.rate || !this.total) return { pcm: new Int16Array(0), seconds: 0, heard: false };
    const all = new Float32Array(this.total);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    const pcm = toInt16(normalize(trimSilence(downsample(all, this.rate, 16000), 16000)));
    return { pcm, seconds: pcm.length / 16000, heard: this.heard };
  }
}

function downsample(buf, inRate, outRate) {
  if (inRate === outRate) return buf;
  const ratio = inRate / outRate;
  const outLen = Math.floor(buf.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(buf.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += buf[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

function trimSilence(buf, sr) {
  const n = Math.round(sr * 0.02);
  const frames = [];
  for (let i = 0; i < buf.length; i += n) {
    let s = 0;
    const end = Math.min(buf.length, i + n);
    for (let j = i; j < end; j++) s += buf[j] * buf[j];
    frames.push(Math.sqrt(s / Math.max(1, end - i)));
  }
  let max = 0;
  for (const f of frames) if (f > max) max = f;
  if (max < 0.004) return buf;
  const thr = Math.max(0.006, max * 0.06);
  let first = 0;
  while (first < frames.length && frames[first] <= thr) first++;
  let last = frames.length - 1;
  while (last > first && frames[last] <= thr) last--;
  const pad = Math.round(0.3 / 0.02);
  return buf.subarray(Math.max(0, (first - pad) * n), Math.min(buf.length, (last + 1 + pad) * n));
}

function normalize(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 0.005 || peak >= 0.5) return buf;
  const g = Math.min(8, 0.7 / peak);
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g;
  return out;
}

function toInt16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** Cuts a long answer into pieces of at most ~28 s, at the quietest moment. */
function splitPcm(pcm, sr = 16000, maxSec = 28, minSec = 16) {
  const segs = [];
  const max = maxSec * sr;
  const min = minSec * sr;
  const win = sr / 10;
  let start = 0;
  while (pcm.length - start > max) {
    let best = start + max;
    let bestE = Infinity;
    for (let i = start + min; i + win <= start + max; i += win / 2) {
      let e = 0;
      for (let j = i; j < i + win; j++) e += pcm[j] * pcm[j];
      if (e < bestE) {
        bestE = e;
        best = i + win / 2;
      }
    }
    segs.push(pcm.subarray(start, best));
    start = best;
  }
  segs.push(pcm.subarray(start));
  return segs.filter((s) => s.length >= sr * 0.6);
}

function pcmBody(pcm) {
  return pcm.slice().buffer;
}

let activeRec = null;

/** Wires one record button: tap to start, tap again (or silence / time limit) to stop. */
async function toggleRecord(btn, statusEl, { maxSec, autoStopMs, onResult }) {
  if (activeRec) {
    if (activeRec.btn === btn) await activeRec.finish();
    else toast("先停止正在进行的录音");
    return;
  }
  TTS.stop();
  const rec = new Recorder();
  const label = btn.textContent;
  const bar = h("div");
  const timer = h("span", { class: "timer", style: "font-size:1rem", text: "0:00" });
  statusEl.replaceChildren(
    h("div", { class: "rec-status" }, h("span", { class: "dot" }), h("span", { text: "正在录音" }), timer, h("span", { class: "tiny muted", text: `最长 ${fmtSec(maxSec)}` })),
    h("div", { class: "meter" }, bar),
  );
  statusEl.hidden = false;
  let finishing = false;
  const end = async (submit) => {
    if (finishing) return;
    finishing = true;
    const out = await rec.stop();
    if (activeRec === ctl) activeRec = null;
    btn.classList.remove("rec");
    btn.textContent = label;
    btn.disabled = false;
    statusEl.replaceChildren();
    statusEl.hidden = true;
    if (out && submit) onResult(out);
  };
  const ctl = { btn, finish: () => end(true), cancel: () => end(false) };
  activeRec = ctl;
  btn.disabled = true;
  try {
    await rec.start({
      maxSec,
      autoStopMs,
      onLevel: (r) => (bar.style.width = `${Math.min(100, r * 500)}%`),
      onTick: (s) => (timer.textContent = fmtSec(s)),
      onAutoStop: () => ctl.finish(),
    });
  } catch (e) {
    if (activeRec === ctl) activeRec = null;
    finishing = true;
    btn.disabled = false;
    statusEl.replaceChildren();
    statusEl.hidden = true;
    toast(e.message, 6000);
    return;
  }
  if (finishing) return; // cancelled (tab switch) while the microphone was starting
  btn.disabled = false;
  btn.classList.add("rec");
  btn.textContent = "■ 停止";
}

async function assess(pcm, { mode, ref, save, item }) {
  const qs = new URLSearchParams({ mode, save: save || "none" });
  if (ref) qs.set("ref", ref);
  if (item) qs.set("item", item);
  return api(`/api/assess?${qs}`, { method: "POST", raw: pcmBody(pcm) });
}

// ===================== pronunciation display =====================

// ARPAbet-style codes to IPA, for showing sounds the way Chinese textbooks write them.
const IPA = {
  aa: "ɑː", ae: "æ", ah: "ʌ", ao: "ɔː", aw: "aʊ", ax: "ə", ay: "aɪ", b: "b", ch: "tʃ", d: "d", dh: "ð", eh: "e", er: "ɜː",
  ey: "eɪ", f: "f", g: "g", hh: "h", ih: "ɪ", iy: "iː", jh: "dʒ", k: "k", l: "l", m: "m", n: "n", ng: "ŋ", ow: "əʊ",
  oy: "ɔɪ", p: "p", r: "r", s: "s", sh: "ʃ", t: "t", th: "θ", uh: "ʊ", uw: "uː", v: "v", w: "w", y: "j", z: "z", zh: "ʒ",
};
function ipa(code) {
  if (!code) return "";
  const c = String(code).toLowerCase().replace(/[0-9]/g, "");
  return IPA[c] || code;
}

const TAG_TEXT = { 1: "多读的词", 2: "漏读", 3: "读错", 4: "词典里没有这个词" };

function verdict(s) {
  if (s == null) return "没有得到分数";
  if (s >= 85) return "很清楚，接近母语者";
  if (s >= 75) return "不错，个别音再练练";
  if (s >= 60) return "能听懂，有几个音要改";
  return "要多练：先慢速听，再跟读";
}

function subScore(name, v) {
  return v == null ? null : h("span", {}, `${name} `, h("b", { text: round(v) }));
}

function renderAssessment(r, { title } = {}) {
  const wrap = h("div", { class: "stack" });
  const head = h(
    "div",
    { class: "scoreline" },
    h("span", { class: `bigscore ${textClass(r.score)}`, text: round(r.score) }),
    h(
      "div",
      { class: "stack", style: "gap:2px" },
      h("span", { class: "small", text: title ? `${title}：${verdict(r.score)}` : verdict(r.score) }),
      h("div", { class: "subscores" }, subScore("准确", r.accuracy), subScore("流利", r.fluency), subScore("完整", r.completion)),
    ),
  );
  const words = h("div", { class: "words" });
  const detail = h("div", { class: "detail", hidden: true });
  let selected = null;
  for (const w of r.words || []) {
    const label = w.ref || w.w;
    if (!label) continue;
    const cls = w.tag === 2 ? "s-miss" : w.tag === 1 ? "s-extra" : scoreClass(w.s);
    const chip = h("button", { type: "button", class: `chip ${cls}`, text: label });
    chip.addEventListener("click", () => {
      if (selected) selected.classList.remove("selected");
      if (selected === chip) {
        selected = null;
        detail.hidden = true;
        return;
      }
      selected = chip;
      chip.classList.add("selected");
      detail.replaceChildren(...clean(wordDetail(w, label)));
      detail.hidden = false;
    });
    words.append(chip);
  }
  wrap.append(head, words, h("p", { class: "tiny muted", text: "点任意一个词，看每个音的得分。绿色＝好，橙色＝还行，红色＝要练。" }), detail);
  return wrap;
}

function wordDetail(w, label) {
  const tag = TAG_TEXT[w.tag];
  const phones = h(
    "div",
    { class: "phones" },
    (w.ph || []).map((p) =>
      h(
        "div",
        { class: `phone ${scoreClass(p.s)}` },
        h("span", { class: "letters", text: p.l || "·" }),
        h("span", { class: "ipa", text: `/${ipa(p.r)}/` }),
        h("span", { class: "sc", text: p.s == null ? "—" : `${Math.round(p.s)} 分${p.st && !p.ds ? " · 应重读" : ""}` }),
      ),
    ),
  );
  const listen = h("button", { type: "button", class: "btn small", text: "▶ 听这个词" });
  listen.addEventListener("click", () => TTS.speak(label, listen, 0.8));
  const drillBox = h("div");
  const drill = h("button", { type: "button", class: "btn small", text: "单练这个词" });
  drill.addEventListener("click", () => {
    drillBox.replaceChildren(practiceItem({ text: label.replace(/[^A-Za-z'-]/g, ""), mode: "word", item: `word:${label.toLowerCase()}` }));
  });
  const heard = w.ph?.some((p) => p.p && p.r && p.p !== p.r)
    ? h("p", { class: "tiny muted", text: `听起来像：${w.ph.map((p) => `/${ipa(p.p)}/`).join(" ")}` })
    : null;
  return [
    h("div", { class: "row" }, h("b", { text: label }), h("span", { class: textClass(w.s), text: w.s == null ? "" : `${Math.round(w.s)} 分` }), tag ? h("span", { class: "warn", text: tag }) : null),
    w.ph?.length ? phones : h("p", { class: "small muted", text: "这个词没有分音素的结果" }),
    heard,
    h("div", { class: "row" }, listen, drill),
    drillBox,
  ];
}

// ===================== practice item (one sentence or word) =====================

function practiceItem({ text, tip, mode = "sentence", item }) {
  const box = h("div", { class: "sent" });
  const play = h("button", { type: "button", class: "btn small", text: "▶ 原声" });
  play.addEventListener("click", () => TTS.speak(text, play));
  const slow = h("button", { type: "button", class: "btn small", text: "慢速" });
  slow.addEventListener("click", () => TTS.speak(text, slow, 0.7));
  const recBtn = h("button", { type: "button", class: "btn small primary", text: mode === "word" ? "读这个词" : "跟读" });
  const status = h("div", { hidden: true });
  const resultEl = h("div", { class: "result", hidden: true });
  recBtn.addEventListener("click", () =>
    toggleRecord(recBtn, status, {
      maxSec: mode === "word" ? 6 : 20,
      autoStopMs: mode === "word" ? 900 : 1500,
      onResult: async (out) => {
        if (!out.heard || out.seconds < 0.3) {
          toast("没听到声音，请靠近麦克风再读一次");
          return;
        }
        resultEl.hidden = false;
        resultEl.replaceChildren(h("p", { class: "muted small", text: "腾讯评分中…" }));
        try {
          const r = await assess(out.pcm, { mode, ref: text, save: mode === "word" ? "word" : "shadow", item });
          resultEl.replaceChildren(renderAssessment(r.result));
          bumpToday();
        } catch (e) {
          resultEl.replaceChildren(h("p", { class: "warn", text: e.message }));
        }
      },
    }),
  );
  box.append(
    ...clean([
      h("p", { class: "en", text }),
      tip ? h("p", { class: "tip", text: tip }) : null,
      h("div", { class: "row" }, play, slow, recBtn),
      status,
      resultEl,
    ]),
  );
  return box;
}

// ===================== views =====================

function viewShadow() {
  const root = h("div", { class: "stack", style: "gap:14px" });

  if (S.focusWords.length) {
    const close = h("button", { type: "button", class: "btn small ghost", text: "收起" });
    close.addEventListener("click", () => {
      S.focusWords = [];
      render();
    });
    root.append(
      h(
        "section",
        { class: "card" },
        h("div", { class: "section-title" }, h("h2", { text: "薄弱词专项" }), h("span", { class: "spacer" }), close),
        h("p", { class: "small muted", text: "从学习报告里挑出来的低分词，一个一个读到 80 分以上。" }),
        S.focusWords.map((w) => practiceItem({ text: w, mode: "word", item: `word:${w}` })),
      ),
    );
  }

  const latest = S.home?.latestSummary;
  const recs = latest?.summary?.practice_sentences || [];
  if (recs.length) {
    root.append(
      h(
        "section",
        { class: "card" },
        h("div", { class: "section-title" }, h("h2", { text: "今日推荐" }), h("span", { class: "sub", text: `教练根据 ${fmtDay(latest.day)} 的练习生成` })),
        recs.map((r, i) => practiceItem({ text: r.text, tip: `${r.focus} · ${r.tip_zh}`, item: `rec:${latest.day}:${i}` })),
      ),
    );
  }

  const input = h("textarea", { id: "customText", placeholder: "粘贴或输入任何一句英文，比如你口语答案里的一句话", rows: 2 });
  const holder = h("div");
  const go = h("button", { type: "button", class: "btn", text: "练这句" });
  go.addEventListener("click", () => {
    const t = input.value.replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]/.test(t)) {
      toast("请输入英文句子");
      return;
    }
    if (t.split(" ").length > 30) {
      toast("一句最多 30 个词，长段落请分开练");
      return;
    }
    holder.replaceChildren(practiceItem({ text: t, item: "custom" }));
  });
  root.append(
    h("section", { class: "card" }, h("h2", { text: "自己选句子" }), input, h("div", { class: "row" }, go), holder),
  );

  SHADOW_GROUPS.forEach((g, gi) => {
    const det = h(
      "details",
      { class: "card", open: gi === 0 && !recs.length },
      h("summary", {}, g.title),
      h(
        "div",
        { class: "stack", style: "gap:10px;margin-top:8px" },
        h("p", { class: "small muted", text: g.tip }),
        g.items.map((t, i) => practiceItem({ text: t, item: `${g.id}:${i}` })),
      ),
    );
    root.append(det);
  });
  return root;
}

function viewSpeak() {
  const part = S.speak.part;
  const list = SPEAK_QUESTIONS[part];
  let q = list.find((x) => x.id === S.speak.qid) || list[0];
  S.speak.qid = q.id;

  const seg = h(
    "div",
    { class: "seg", role: "group", "aria-label": "选择 Part" },
    ["Part 1", "Part 2", "Part 3"].map((p) => {
      const b = h("button", { type: "button", "aria-pressed": String(p === part), text: p });
      b.addEventListener("click", () => {
        S.speak.part = p;
        S.speak.qid = null;
        render();
      });
      return b;
    }),
  );
  const sel = h("select", { id: "questionSelect", "aria-label": "选择题目" }, list.map((x) => h("option", { value: x.id, selected: x.id === q.id, text: `${x.topic}：${x.q}` })));
  sel.addEventListener("change", () => {
    S.speak.qid = sel.value;
    render();
  });
  const another = h("button", { type: "button", class: "btn small", text: "换一题" });
  another.addEventListener("click", () => {
    const others = list.filter((x) => x.id !== q.id);
    S.speak.qid = others[Math.floor(Math.random() * others.length)].id;
    render();
  });

  const listenQ = h("button", { type: "button", class: "btn small", text: "▶ 听考官提问" });
  listenQ.addEventListener("click", () => TTS.speak(q.cue ? `${q.q} You should say: ${q.cue.join(", ")}` : q.q, listenQ));
  let prep = null;
  if (part === "Part 2") {
    prep = h("button", { type: "button", class: "btn small", text: "准备 1 分钟" });
    let timer = null;
    prep.addEventListener("click", () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
        prep.textContent = "准备 1 分钟";
        return;
      }
      let left = 60;
      prep.textContent = `准备中 ${left}s（点击取消）`;
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          timer = null;
          prep.textContent = "准备 1 分钟";
          toast("时间到，点「开始回答」说 1–2 分钟");
          return;
        }
        prep.textContent = `准备中 ${left}s（点击取消）`;
      }, 1000);
    });
  }

  const maxSec = part === "Part 2" ? 150 : part === "Part 3" ? 90 : 60;
  const recBtn = h("button", { type: "button", class: "btn primary big", text: "开始回答" });
  const status = h("div", { hidden: true });
  const out = h("div", { class: "stack" });
  recBtn.addEventListener("click", () =>
    toggleRecord(recBtn, status, {
      maxSec,
      autoStopMs: 0,
      onResult: (res) => processAnswer(res, q, part, out),
    }),
  );

  const lengthTip =
    part === "Part 1" ? "Part 1 每题答 2–4 句（约 20–30 秒）。" : part === "Part 2" ? "Part 2 先准备 1 分钟，再连续说 1–2 分钟。" : "Part 3 说出观点、理由和例子（约 40–60 秒）。";

  return h(
    "div",
    { class: "stack", style: "gap:14px" },
    h("section", { class: "card" }, h("div", { class: "row" }, seg, h("span", { class: "spacer" }), another), sel),
    h(
      "section",
      { class: "card" },
      h("span", { class: "instr", text: `${part} · ${q.topic}` }),
      h("p", { class: "question", text: q.q }),
      q.cue ? h("div", {}, h("p", { class: "small muted", text: "You should say:" }), h("ul", { class: "cue" }, q.cue.map((c) => h("li", { text: c })))) : null,
      h("div", { class: "row" }, listenQ, prep),
      h("p", { class: "small muted", text: `${lengthTip}说完点「停止」，先由腾讯给发音打分，再由 Claude 点评。` }),
      recBtn,
      status,
    ),
    out,
  );
}

async function processAnswer(res, q, part, out) {
  if (!res.heard || res.seconds < 1) {
    toast("没听到你的回答，请靠近麦克风再说一次");
    return;
  }
  const segs = splitPcm(res.pcm);
  const step1 = h("div", { class: "doing", text: `① 腾讯评分（共 ${segs.length} 段）…` });
  const step2 = h("div", { class: "muted", text: "② Claude 点评" });
  const card = h("section", { class: "card" }, h("h2", { text: "正在分析你的回答" }), h("div", { class: "steps" }, step1, step2));
  out.replaceChildren(card);
  card.scrollIntoView({ behavior: "smooth", block: "start" });

  const results = [];
  const durations = [];
  try {
    for (let i = 0; i < segs.length; i++) {
      step1.textContent = `① 腾讯评分：第 ${i + 1}/${segs.length} 段…`;
      const r = await assess(segs[i], { mode: "free" });
      results.push(r.result);
      durations.push(segs[i].length / 16000);
    }
  } catch (e) {
    card.replaceChildren(h("h2", { text: "评分没完成" }), h("p", { class: "warn", text: e.message }));
    return;
  }
  const merged = mergeResults(results, durations);
  step1.className = "done";
  step1.textContent = `① 腾讯评分完成：发音 ${round(merged.score)} 分`;
  if (merged.transcript.split(" ").filter(Boolean).length < 2) {
    card.append(h("p", { class: "warn", text: "腾讯没识别出你说的内容。请在安静的地方、靠近麦克风再答一次。" }));
    return;
  }
  step2.className = "doing";
  step2.textContent = "② Claude 点评中（约 10–20 秒）…";
  try {
    const fb = await api("/api/feedback", {
      method: "POST",
      body: {
        part,
        question: q.q,
        item: q.id,
        transcript: merged.transcript,
        durationSec: res.seconds,
        pron: { score: merged.score, accuracy: merged.accuracy, fluency: merged.fluency, completion: merged.completion },
        words: merged.words.map(({ b, e, ...w }) => w),
      },
    });
    bumpToday();
    out.replaceChildren(renderFeedback(fb.feedback, merged, fb.wordsPerMinute, res.seconds));
  } catch (e) {
    step2.className = "warn";
    step2.textContent = `② Claude 点评失败：${e.message}`;
    card.append(renderAssessment(merged, { title: "腾讯发音评分" }));
  }
}

function mergeResults(results, durations) {
  const total = durations.reduce((a, b) => a + b, 0) || 1;
  const wavg = (key) => {
    let sum = 0;
    let weight = 0;
    results.forEach((r, i) => {
      if (typeof r[key] === "number") {
        sum += r[key] * durations[i];
        weight += durations[i];
      }
    });
    return weight ? sum / weight : null;
  };
  return {
    score: wavg("score"),
    accuracy: wavg("accuracy"),
    fluency: wavg("fluency"),
    completion: null,
    words: results.flatMap((r) => r.words || []),
    transcript: results
      .map((r) => r.transcript || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
    seconds: total,
  };
}

function renderFeedback(fb, merged, wpm, seconds) {
  const band = (k, v) => h("div", { class: "band" }, h("span", { class: "v", text: v == null ? "—" : String(v) }), h("span", { class: "k", text: k }));
  const play = h("button", { type: "button", class: "btn small", text: "▶ 听示范" });
  play.addEventListener("click", () => TTS.speak(fb.better_answer, play));
  const speedNote = wpm < 90 ? "偏慢，多用连接词把句子连起来" : wpm > 170 ? "偏快，注意停顿和清晰度" : "语速合适";
  return h(
    "div",
    { class: "stack", style: "gap:14px" },
    h(
      "section",
      { class: "card" },
      h("div", { class: "section-title" }, h("h2", { text: "考官估分" }), h("span", { class: "sub", text: "Claude Haiku 5.5 点评 · 仅供参考" })),
      h("div", { class: "bands" }, band("流利连贯", fb.fc), band("词汇", fb.lr), band("语法", fb.gra), band("发音（估）", fb.pron)),
      h("p", { text: fb.overall_zh }),
      h("p", { class: "small muted", text: `回答 ${Math.round(seconds)} 秒，约 ${wpm} 词/分钟，${speedNote}。` }),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", { text: "你说的内容（机器识别，可能有误）" }),
      renderAssessment(merged, { title: "腾讯发音分" }),
    ),
    fb.corrections?.length
      ? h(
          "section",
          { class: "card" },
          h("h2", { text: "逐句修改" }),
          fb.corrections.map((c) =>
            h("div", { class: "fix" }, h("span", { class: "o", text: c.original }), h("span", { class: "b", text: `→ ${c.better}` }), h("span", { class: "small muted", text: c.why_zh })),
          ),
        )
      : null,
    fb.pron_tips?.length
      ? h(
          "section",
          { class: "card" },
          h("h2", { text: "发音提示" }),
          fb.pron_tips.map((t) => h("p", {}, h("b", { text: `${t.word}：` }), t.tip_zh)),
        )
      : null,
    h(
      "section",
      { class: "card" },
      h("div", { class: "row" }, h("h2", { text: "7 分示范回答" }), h("span", { class: "spacer" }), play),
      h("p", { class: "model", text: fb.better_answer }),
      h("p", { class: "small muted", text: "听两遍示范，然后不看文字，用自己的话再答一遍。" }),
    ),
    fb.phrases?.length
      ? h(
          "section",
          { class: "card" },
          h("h2", { text: "可以背下来的表达" }),
          h("div", { class: "phrases" }, fb.phrases.map((p) => h("div", {}, h("b", { text: p.en }), ` · ${p.zh}`))),
        )
      : null,
  );
}

function allListenSets() {
  const ai = (S.home?.listeningSets || []).map((x) => ({ ...x.set, id: `coach-${x.day}`, source: `教练 ${fmtDay(x.day)}` }));
  return [...ai, ...LISTEN_SETS.map((s) => ({ ...s, source: "内置" }))];
}

const normAnswer = (s) => String(s || "").toLowerCase().replace(/£/g, "").replace(/[^a-z0-9]/g, "");

function viewListen() {
  const sets = allListenSets();
  let set = sets.find((s) => s.id === S.listenSetId) || sets[0];
  S.listenSetId = set.id;

  const sel = h("select", { id: "listenSelect", "aria-label": "选择听力" }, sets.map((s) => h("option", { value: s.id, selected: s.id === set.id, text: `${s.source} · ${s.title}` })));
  sel.addEventListener("change", () => {
    S.listenSetId = sel.value;
    render();
  });

  const play = h("button", { type: "button", class: "btn primary", text: "▶ 播放录音" });
  play.addEventListener("click", () => TTS.speak(set.lines.map((l) => ({ text: l.text, voice: l.speaker === "A" ? "A" : "B" })), play));

  const rows = set.questions.map((q, i) => {
    const input = h("input", { type: "text", id: `ans-${i}`, autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": `第 ${i + 1} 题` });
    const key = h("div", { class: "key", hidden: true });
    const row = h("div", { class: "q" }, h("span", { class: "num", text: String(i + 1) }), h("span", { class: "label", text: q.label }), input, key);
    return { q, input, key, row };
  });
  const score = h("p", { class: "small" });
  let saved = false;
  const check = h("button", { type: "button", class: "btn primary", text: "核对答案" });
  check.addEventListener("click", async () => {
    let n = 0;
    const wrong = [];
    rows.forEach(({ q, input, key, row }, i) => {
      const ok = q.answers.some((a) => normAnswer(a) === normAnswer(input.value)) && input.value.trim() !== "";
      row.classList.toggle("right", ok);
      row.classList.toggle("wrong", !ok);
      key.hidden = ok;
      key.textContent = ok ? "" : `答案：${q.answers[0]}${q.hint_zh ? `（${q.hint_zh}）` : ""}`;
      if (ok) n += 1;
      else wrong.push({ n: i + 1, label: q.label, given: input.value.trim(), answer: q.answers[0] });
    });
    score.textContent = `${n} / ${rows.length}${n === rows.length ? " · 全对！" : " · 对照原文找出漏听的地方"}`;
    if (!saved) {
      saved = true;
      try {
        await api("/api/listen", { method: "POST", body: { setId: set.id, title: set.title, score: n, total: rows.length, wrong } });
        bumpToday();
      } catch (e) {
        toast(`成绩没保存上：${e.message}`);
      }
    }
  });
  const reset = h("button", { type: "button", class: "btn", text: "重做" });
  reset.addEventListener("click", () => {
    saved = false;
    score.textContent = "";
    rows.forEach(({ input, key, row }) => {
      input.value = "";
      key.hidden = true;
      row.classList.remove("right", "wrong");
    });
  });

  return h(
    "div",
    { class: "stack", style: "gap:14px" },
    h("section", { class: "card" }, h("h2", { text: "雅思听力 Section 1" }), sel, h("p", { class: "small muted", text: `${set.context_zh || ""}。真实考试只放一遍：先读题、预测要填什么，再播放。` })),
    h(
      "section",
      { class: "card" },
      h("div", { class: "row" }, play, h("span", { class: "tiny muted", text: "两个人用两种声音朗读" })),
      h("p", { class: "instr", text: "Write ONE WORD AND/OR A NUMBER for each answer" }),
      h("div", { class: "form" }, h("div", { class: "form-title", text: set.title }), rows.map((r) => r.row)),
      h("div", { class: "row" }, check, reset, score),
      h(
        "details",
        {},
        h("summary", {}, "听力原文（做完再看）"),
        h("div", { class: "script", style: "margin-top:8px" }, set.lines.map((l) => h("p", {}, h("b", { text: l.speaker === "A" ? "STAFF" : "CALLER" }), l.text))),
      ),
    ),
  );
}

function viewReport() {
  const root = h("div", { class: "stack", style: "gap:14px" }, h("p", { class: "loading", text: "正在读取学习记录…" }));
  api("/api/report")
    .then((r) => {
      S.report = r;
      root.replaceChildren(...clean(reportBody(r)));
    })
    .catch((e) => root.replaceChildren(h("p", { class: "warn", text: e.message })));
  return root;
}

function reportBody(r) {
  const last7 = r.series.slice(-7).filter((d) => d.shadowAvg != null);
  const shadow7 = last7.length ? last7.reduce((a, d) => a + d.shadowAvg * d.shadowN, 0) / last7.reduce((a, d) => a + d.shadowN, 0) : null;
  const sp = r.speaking.slice(0, 5);
  const spAvg = sp.length ? sp.reduce((a, s) => a + (s.fc + s.lr + s.gra + s.pron) / 4, 0) / sp.length : null;
  const tile = (k, v, sub) => h("div", { class: "tile" }, h("span", { class: "v", text: v }), h("span", { class: "k", text: k }), sub ? h("span", { class: "tiny muted", text: sub }) : null);

  const sum = r.latestSummary;
  const gen = h("button", { type: "button", class: "btn primary", text: sum?.day === r.today ? "重新生成今日总结" : "生成今日总结" });
  const genNote = h("p", { class: "tiny muted", text: "每晚 21:30（开罗时间）自动生成；也可以练完后手动生成，每天最多 3 次。" });
  gen.addEventListener("click", async () => {
    gen.disabled = true;
    gen.textContent = "Claude Opus 正在分析（约 1 分钟）…";
    try {
      await api("/api/summary", { method: "POST" });
      S.home = await api("/api/home");
      toast("今日总结已生成");
      render();
    } catch (e) {
      gen.disabled = false;
      gen.textContent = "生成今日总结";
      toast(e.message, 6000);
    }
  });

  const copy = h("button", { type: "button", class: "btn small", text: "复制学习数据" });
  copy.addEventListener("click", () => {
    const text = JSON.stringify({ ...r, latestSummary: undefined, coachSummary: sum?.summary }, null, 1);
    navigator.clipboard
      .writeText(text)
      .then(() => toast("已复制，可以粘贴到 Claude 聊天里让它分析"))
      .catch(() => toast("复制失败，请手动截图报告页"));
  });

  return [
    h(
      "section",
      { class: "tiles" },
      tile("连续练习", `${r.streak} 天`),
      tile("今天练习", `${r.todayCount} 次`),
      tile("跟读近 7 天平均", round(shadow7), "腾讯发音分，满分 100"),
      tile("口语近 5 次平均", spAvg == null ? "—" : spAvg.toFixed(1), "雅思分数估计"),
    ),
    h("section", { class: "card" }, h("h2", { text: "最近 14 天跟读平均分" }), chart(r.series)),
    sum ? summaryCard(sum, gen, genNote) : h("section", { class: "card" }, h("h2", { text: "教练总结" }), h("p", { class: "small muted", text: "还没有总结。今天练完后点下面的按钮，Claude Opus 会分析你的练习，安排明天的计划、推荐跟读句，再出一套新听力。" }), gen, genNote),
    weakSoundsCard(r.weakSounds),
    weakWordsCard(r.weakWords),
    r.speaking.length
      ? h(
          "section",
          { class: "card" },
          h("h2", { text: "口语记录" }),
          h(
            "div",
            { class: "list" },
            r.speaking.map((s) =>
              h(
                "div",
                {},
                h("span", { class: "grow small" }, `${s.part} · ${s.question}`),
                h("span", { class: "num", text: ((s.fc + s.lr + s.gra + s.pron) / 4).toFixed(1) }),
              ),
            ),
          ),
        )
      : null,
    h(
      "section",
      { class: "card" },
      h("div", { class: "row" }, h("h2", { text: "最近练习" }), h("span", { class: "spacer" }), copy),
      r.recent.length
        ? h(
            "div",
            { class: "list" },
            r.recent.map((a) =>
              h(
                "div",
                {},
                h("span", { class: "tiny muted", style: "width:4.2rem", text: new Date(a.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }),
                h("span", { class: "grow small", text: `${{ shadow: "跟读", word: "单词", speak: "口语", listen: "听力" }[a.type] || a.type} · ${a.ref || ""}` }),
                h("span", { class: "num", text: a.score == null ? "—" : typeof a.score === "number" ? Math.round(a.score) : a.score }),
              ),
            ),
          )
        : h("p", { class: "small muted", text: "还没有练习记录。" }),
    ),
  ];
}

function chart(series) {
  const W = 340;
  const H = 130;
  const pad = { l: 26, r: 6, t: 10, b: 20 };
  const bw = (W - pad.l - pad.r) / series.length;
  const y = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "最近 14 天跟读平均分");
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const v of [0, 50, 100]) {
    el("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) });
    el("text", { x: pad.l - 4, y: y(v) + 3, "text-anchor": "end" }, String(v));
  }
  series.forEach((d, i) => {
    const x = pad.l + i * bw;
    if (d.shadowAvg != null) {
      el("rect", { class: "bar", x: x + bw * 0.18, y: y(d.shadowAvg), width: bw * 0.64, height: Math.max(1, y(0) - y(d.shadowAvg)), rx: 2 });
    }
    if ((series.length - 1 - i) % 2 === 0) {
      el("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }, `${Number(d.day.slice(5, 7))}/${Number(d.day.slice(8, 10))}`);
    }
  });
  return svg;
}

function summaryCard(sum, gen, genNote) {
  const s = sum.summary || {};
  return h(
    "section",
    { class: "card" },
    h("div", { class: "section-title" }, h("h2", { text: "教练总结" }), h("span", { class: "sub", text: `${fmtDay(sum.day)} · Claude Opus 5.5` })),
    h("p", { text: s.summary_zh }),
    s.progress_zh ? h("p", { class: "small", text: s.progress_zh }) : null,
    s.weak_points?.length ? h("div", { class: "stack" }, h("h3", { text: "要补的地方" }), s.weak_points.map((w) => h("p", { class: "small" }, h("b", { text: `${w.area}：` }), w.detail_zh))) : null,
    s.tomorrow_plan?.length ? h("div", { class: "stack" }, h("h3", { text: "明天的计划" }), h("ol", { class: "plan" }, s.tomorrow_plan.map((t) => h("li", { class: "small", text: `${t.task_zh}（${t.minutes} 分钟）` })))) : null,
    s.encouragement_zh ? h("p", { class: "small muted", text: s.encouragement_zh }) : null,
    h("p", { class: "tiny muted", text: "推荐跟读句在「跟读」页最上面，新听力在「听力」页的下拉框里。" }),
    gen,
    genNote,
  );
}

function weakSoundsCard(list) {
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "最弱的音（近 30 天）" }),
    list.length
      ? h(
          "div",
          { class: "list" },
          list.map((s) => {
            const b = h("button", { type: "button", class: "btn small", text: "练这些词" });
            b.addEventListener("click", () => {
              S.focusWords = s.examples.slice(0, 6);
              go("shadow");
            });
            return h(
              "div",
              {},
              h("span", { class: "num", style: "min-width:3.2rem", text: `/${ipa(s.sound)}/` }),
              h("span", { class: "grow small" }, `${s.letters.length ? `字母 ${s.letters.join("、")} · ` : ""}平均 `, h("b", { class: textClass(s.avg), text: String(Math.round(s.avg)) }), ` 分 · ${s.n} 次${s.examples.length ? ` · 例：${s.examples.slice(0, 3).join(", ")}` : ""}`),
              s.examples.length ? b : null,
            );
          }),
        )
      : h("p", { class: "small muted", text: "跟读几句之后，这里会列出你最常读不准的音。" }),
  );
}

function weakWordsCard(list) {
  return h(
    "section",
    { class: "card" },
    h("h2", { text: "最常读不准的词" }),
    list.length
      ? h(
          "div",
          { class: "words" },
          list.map((w) => {
            const c = h("button", { type: "button", class: `chip ${scoreClass(w.avg)}`, text: `${w.word} ${Math.round(w.avg)}` });
            c.addEventListener("click", () => {
              S.focusWords = [w.word];
              go("shadow");
            });
            return c;
          }),
        )
      : h("p", { class: "small muted", text: "同一个词至少读过两次才会统计。" }),
    list.length ? h("p", { class: "tiny muted", text: "点一个词就去单独练它。" }) : null,
  );
}

function viewSettings() {
  const st = S.home?.settings || { scoreCoeff: 3, timezone: "Africa/Cairo" };
  const keys = S.home?.keys || {};

  const strict = h(
    "div",
    { class: "seg", role: "group", "aria-label": "评分严格度" },
    [
      [2, "宽松"],
      [3, "标准"],
      [4, "严格"],
    ].map(([v, label]) => {
      const b = h("button", { type: "button", "aria-pressed": String(Number(st.scoreCoeff) === v), text: label });
      b.addEventListener("click", async () => {
        try {
          const r = await api("/api/settings", { method: "POST", body: { scoreCoeff: v } });
          S.home.settings = r.settings;
          toast(`评分改为「${label}」`);
          render();
        } catch (e) {
          toast(e.message);
        }
      });
      return b;
    }),
  );

  const zones = ["Africa/Cairo", "Asia/Shanghai", "Asia/Dubai", "Europe/London", "Asia/Singapore"];
  if (!zones.includes(st.timezone)) zones.unshift(st.timezone);
  const tz = h("select", { id: "tzSelect" }, zones.map((z) => h("option", { value: z, selected: z === st.timezone, text: z })));
  tz.addEventListener("change", async () => {
    try {
      const r = await api("/api/settings", { method: "POST", body: { timezone: tz.value } });
      S.home.settings = r.settings;
      toast("时区已保存");
    } catch (e) {
      toast(e.message);
    }
  });

  TTS.load();
  const voiceSel = (which) => {
    const sel = h(
      "select",
      { id: `voice${which}` },
      h("option", { value: "", text: "自动选择（优先英音）" }),
      TTS.voices.map((v) => h("option", { value: v.name, selected: (which === "A" ? S.prefs.voiceA : S.prefs.voiceB) === v.name, text: `${v.name}（${v.lang}）` })),
    );
    sel.addEventListener("change", () => {
      if (which === "A") S.prefs.voiceA = sel.value;
      else S.prefs.voiceB = sel.value;
      savePrefs();
    });
    return sel;
  };
  const rate = h("select", { id: "rateSelect" }, [0.8, 0.9, 1, 1.1].map((r) => h("option", { value: String(r), selected: Number(S.prefs.rate) === r, text: `${r}×` })));
  rate.addEventListener("change", () => {
    S.prefs.rate = Number(rate.value);
    savePrefs();
  });
  const tryA = h("button", { type: "button", class: "btn small", text: "试听" });
  tryA.addEventListener("click", () =>
    TTS.speak(
      [
        { text: "Good morning. How can I help you?", voice: "A" },
        { text: "Hi, I'd like to book a table for two, please.", voice: "B" },
      ],
      tryA,
    ),
  );

  const testOut = h("div", { class: "stack" });
  const test = h("button", { type: "button", class: "btn", text: "测试连接" });
  test.addEventListener("click", async () => {
    test.disabled = true;
    testOut.replaceChildren(h("p", { class: "small muted", text: "正在测试…" }));
    try {
      const r = await api("/api/test", { method: "POST" });
      testOut.replaceChildren(...Object.values(r).map((x) => h("p", { class: x.ok ? "ok-text" : "warn", text: `${x.ok ? "✓" : "✗"} ${x.message}` })));
    } catch (e) {
      testOut.replaceChildren(h("p", { class: "warn", text: e.message }));
    }
    test.disabled = false;
  });

  const f = {
    appId: h("input", { type: "text", id: "upAppId", inputmode: "numeric", placeholder: keys.tencentAppId || "腾讯云 AppID" }),
    sid: h("input", { type: "password", id: "upSid", placeholder: `SecretId ${keys.tencentSecretId || ""}`, autocomplete: "off" }),
    skey: h("input", { type: "password", id: "upSkey", placeholder: "SecretKey", autocomplete: "off" }),
    ak: h("input", { type: "password", id: "upAk", placeholder: `Claude API 密钥 ${keys.anthropicKey || ""}`, autocomplete: "off" }),
    pass: h("input", { type: "password", id: "upPass", placeholder: "新口令（不改就留空）", autocomplete: "new-password" }),
  };
  const saveKeys = h("button", { type: "button", class: "btn", text: "保存修改" });
  saveKeys.addEventListener("click", async () => {
    const body = {
      tencentAppId: f.appId.value.trim(),
      tencentSecretId: f.sid.value.trim(),
      tencentSecretKey: f.skey.value.trim(),
      anthropicKey: f.ak.value.trim(),
      passcode: f.pass.value,
    };
    if (!Object.values(body).some(Boolean)) {
      toast("没有要修改的内容");
      return;
    }
    try {
      await api("/api/setup", { method: "POST", body });
      if (body.passcode) {
        S.pass = body.passcode;
        local.set("ielts.pass", S.pass);
      }
      Object.values(f).forEach((i) => (i.value = ""));
      S.home = await api("/api/home");
      toast("已保存");
      render();
    } catch (e) {
      toast(e.message, 6000);
    }
  });

  const logout = h("button", { type: "button", class: "btn ghost", text: "退出（这台手机忘记口令）" });
  logout.addEventListener("click", () => {
    S.pass = "";
    local.del("ielts.pass");
    boot();
  });

  return h(
    "div",
    { class: "stack", style: "gap:14px" },
    h("section", { class: "card" }, h("h2", { text: "发音评分严格度" }), strict, h("p", { class: "small muted", text: "腾讯的“苛刻指数”。标准适合大多数成人；想更快发现小问题就选严格。" })),
    h("section", { class: "card" }, h("h2", { text: "朗读声音" }), h("label", { class: "field" }, h("span", { text: "主声音（句子、考官、听力里的工作人员）" }), voiceSel("A")), h("label", { class: "field" }, h("span", { text: "第二个人（听力里的来电者）" }), voiceSel("B")), h("div", { class: "row" }, h("label", { class: "field", style: "flex:1" }, h("span", { text: "语速" }), rate), tryA), h("p", { class: "tiny muted", text: "声音来自 iPhone 系统。想要更自然的英音，可以在「设置 › 辅助功能 › 朗读内容 › 声音 › 英语（英国）」里下载增强版声音。" })),
    h("section", { class: "card" }, h("h2", { text: "时区" }), tz, h("p", { class: "tiny muted", text: "决定每天的练习从几点算起，以及晚上自动总结的日期。" })),
    h("section", { class: "card" }, h("h2", { text: "连接状态" }), h("p", { class: "small muted", text: `腾讯云 AppID ${keys.tencentAppId || "—"} · SecretId ${keys.tencentSecretId || "—"} · Claude 密钥 ${keys.anthropicKey || "—"}` }), test, testOut),
    h("section", { class: "card" }, h("h2", { text: "修改密钥或口令" }), h("p", { class: "small muted", text: "只填要改的项，其他留空。" }), f.appId, f.sid, f.skey, f.ak, f.pass, saveKeys),
    h("section", { class: "card" }, h("h2", { text: "其他" }), h("p", { class: "small muted", text: "为防止意外扣费，每天最多：发音评测 600 次，口语点评 80 次，手动生成总结 3 次。" }), logout),
  );
}

// ===================== setup & login =====================

function viewSetup(status) {
  const f = {
    code: h("input", { type: "text", id: "setupCode", autocomplete: "off", autocapitalize: "off", placeholder: "Claude 在聊天里给你的初始化码" }),
    pass: h("input", { type: "password", id: "newPass", autocomplete: "new-password", placeholder: "至少 4 位，以后在新手机上登录要用" }),
    pass2: h("input", { type: "password", id: "newPass2", autocomplete: "new-password", placeholder: "再输入一次" }),
    appId: h("input", { type: "text", id: "appId", inputmode: "numeric", autocomplete: "off", placeholder: "一串数字，在腾讯云「账号信息」里" }),
    sid: h("input", { type: "password", id: "secretId", autocomplete: "off", placeholder: "AKID 开头" }),
    skey: h("input", { type: "password", id: "secretKey", autocomplete: "off" }),
    ak: h("input", { type: "password", id: "anthropicKey", autocomplete: "off", placeholder: "sk-ant- 开头" }),
  };
  const msg = h("div", { class: "stack" });
  const submit = h("button", { type: "button", class: "btn primary big", text: "保存并测试连接" });
  submit.addEventListener("click", async () => {
    if (f.pass.value.length < 4) return toast("口令至少 4 位");
    if (f.pass.value !== f.pass2.value) return toast("两次输入的口令不一样");
    submit.disabled = true;
    msg.replaceChildren(h("p", { class: "small muted", text: "正在保存…" }));
    try {
      await api("/api/setup", {
        method: "POST",
        body: {
          setupCode: f.code.value.trim(),
          passcode: f.pass.value,
          tencentAppId: f.appId.value.trim(),
          tencentSecretId: f.sid.value.trim(),
          tencentSecretKey: f.skey.value.trim(),
          anthropicKey: f.ak.value.trim(),
        },
      });
      S.pass = f.pass.value;
      local.set("ielts.pass", S.pass);
      msg.replaceChildren(h("p", { class: "small muted", text: "已保存，正在测试腾讯和 Claude…" }));
      const r = await api("/api/test", { method: "POST" });
      const lines = Object.values(r).map((x) => h("p", { class: x.ok ? "ok-text" : "warn", text: `${x.ok ? "✓" : "✗"} ${x.message}` }));
      const enter = h("button", { type: "button", class: "btn primary", text: "开始练习" });
      enter.addEventListener("click", boot);
      const allOk = Object.values(r).every((x) => x.ok);
      msg.replaceChildren(
        ...clean([lines, allOk ? null : h("p", { class: "small", text: "有一项没通过：可以先进入 App，在「设置」里修改对应的密钥。" }), enter]),
      );
    } catch (e) {
      msg.replaceChildren(h("p", { class: "warn", text: e.message }));
      submit.disabled = false;
    }
  });
  const field = (label, input, hint) => h("label", { class: "field" }, h("span", { text: label }), input, hint ? h("span", { class: "tiny muted", style: "font-weight:400", text: hint }) : null);
  return h(
    "div",
    { class: "stack", style: "gap:14px" },
    h("section", { class: "card" }, h("h2", { text: "第一次使用：填写设置" }), h("p", { class: "small muted", text: "这些信息只保存在你自己的服务器里。只需要填一次，以后打开就能直接练。" })),
    h(
      "section",
      { class: "card" },
      status.needsSetupCode ? field("初始化码", f.code) : null,
      field("设置一个口令", f.pass),
      field("确认口令", f.pass2),
    ),
    h("section", { class: "card" }, h("h3", { text: "腾讯云 口语评测" }), field("AppID", f.appId), field("SecretId", f.sid, "腾讯云控制台 › 访问管理 › API 密钥"), field("SecretKey", f.skey)),
    h("section", { class: "card" }, h("h3", { text: "Claude" }), field("Claude API 密钥", f.ak, "platform.claude.com › API Keys")),
    submit,
    msg,
  );
}

function viewLogin() {
  const input = h("input", { type: "password", id: "loginPass", autocomplete: "current-password", placeholder: "输入口令" });
  const btn = h("button", { type: "button", class: "btn primary big", text: "进入" });
  const go = async () => {
    btn.disabled = true;
    try {
      await api("/api/login", { method: "POST", body: { passcode: input.value } });
      S.pass = input.value;
      local.set("ielts.pass", S.pass);
      boot();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  return h("section", { class: "card" }, h("h2", { text: "输入口令" }), h("p", { class: "small muted", text: "就是第一次设置时你自己定的口令。" }), input, btn);
}

// ===================== shell & routing =====================

const VIEWS = { shadow: viewShadow, speak: viewSpeak, listen: viewListen, report: viewReport, settings: viewSettings };

function renderTopMeta() {
  const t = $("#topMeta");
  if (!S.home) {
    t.textContent = "";
    return;
  }
  t.textContent = `今天已练 ${S.home.todayCount || 0} 次`;
}

function go(view) {
  if (location.hash.slice(1) === view) render();
  else location.hash = view;
}

function render() {
  if (activeRec) activeRec.cancel();
  TTS.stop();
  const view = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : "shadow";
  S.view = view;
  document.querySelectorAll(".tabs button").forEach((b) => {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  const main = $("#main");
  main.replaceChildren(VIEWS[view]());
  window.scrollTo(0, 0);
}

function showBanner() {
  const notes = [];
  if (S.home?.mock) notes.push("测试模式：评分和点评都是假数据。");
  const ua = navigator.userAgent || "";
  if (/MicroMessenger|FBAN|FBAV|Instagram|Line\//i.test(ua)) notes.push("你在 App 内置浏览器里打开的，可能无法录音。请点右上角「…」选择「在 Safari 中打开」。");
  else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) notes.push("这个浏览器不能录音。请用 iPhone 自带的 Safari 打开这个网址。");
  const b = $("#banner");
  b.textContent = notes.join(" ");
  b.hidden = !notes.length;
}

async function boot() {
  const main = $("#main");
  $("#tabs").hidden = true;
  S.home = null;
  renderTopMeta();
  let status;
  try {
    status = await api("/api/status");
  } catch (e) {
    main.replaceChildren(h("p", { class: "warn", text: e.message }));
    return;
  }
  if (!status.configured) {
    main.replaceChildren(viewSetup(status));
    return;
  }
  if (!S.pass) {
    main.replaceChildren(viewLogin());
    return;
  }
  try {
    S.home = await api("/api/home");
  } catch (e) {
    if (e.status === 401) {
      S.pass = "";
      local.del("ielts.pass");
      main.replaceChildren(viewLogin());
      return;
    }
    main.replaceChildren(h("p", { class: "warn", text: e.message }));
    return;
  }
  $("#tabs").hidden = false;
  renderTopMeta();
  showBanner();
  render();
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
window.addEventListener("hashchange", () => {
  if (S.home) render();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && activeRec) activeRec.cancel();
});

boot();
