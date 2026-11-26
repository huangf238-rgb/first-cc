// Tencent Cloud Smart Oral Evaluation, new version (SOE-N), over its WebSocket API.
// Protocol taken from Tencent's official Go SDK (tencentcloud-speech-sdk-go v1.0.25, soe/speaking_assessment.go):
//   wss://soe.cloud.tencent.com/soe/api/{AppID}?{sorted params}&signature=...
//   signature = base64(HMAC-SHA1(SecretKey, "soe.cloud.tencent.com/soe/api/{AppID}?" + sorted raw params))
//   server sends a handshake JSON, client sends audio frames, then {"type":"end"}, server replies with final=1.
// We use rec_mode=1 (one whole recording per connection, max 60 s per Tencent's docs).

import { AppError, type Assessment, type PhoneScore, type TencentCreds, type WordScore } from "./types";

const HOST = "soe.cloud.tencent.com";
const PATH = "soe/api";

export const EVAL_MODES = { word: 0, sentence: 1, paragraph: 2, free: 3 } as const;
export type EvalModeName = keyof typeof EVAL_MODES;

export interface SoeParams {
  refText: string;
  evalMode: number;
  scoreCoeff: number;
  sentenceInfo?: 0 | 1;
}

const enc = new TextEncoder();

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Builds the signed connection URL. Exported so the signature can be checked against the Go SDK. */
export async function buildSoeUrl(
  creds: TencentCreds,
  p: SoeParams,
  nowMs: number = Date.now(),
  voiceId: string = crypto.randomUUID(),
): Promise<{ url: string; signString: string; signature: string }> {
  const ts = Math.floor(nowMs / 1000);
  const q: Record<string, string> = {
    secretid: creds.secretId,
    timestamp: String(ts),
    expired: String(ts + 24 * 60 * 60),
    nonce: String(ts),
    voice_id: voiceId,
    voice_format: "1", // WAV (16 kHz, 16-bit, mono), the format Tencent's own example sends
    text_mode: "0",
    ref_text: p.refText,
    keyword: "",
    eval_mode: String(p.evalMode),
    score_coeff: p.scoreCoeff.toFixed(1),
    server_engine_type: "16k_en",
    sentence_info_enabled: String(p.sentenceInfo ?? 0),
    rec_mode: "1",
  };
  const keys = Object.keys(q).sort();
  const raw = keys.map((k) => `${k}=${q[k]}`).join("&");
  const signString = `${HOST}/${PATH}/${creds.appId}?${raw}`;
  const signature = await hmacSha1Base64(creds.secretKey, signString);
  const query = keys.map((k) => `${k}=${encodeURIComponent(q[k])}`).join("&");
  const url = `https://${HOST}/${PATH}/${encodeURIComponent(creds.appId)}?${query}&signature=${encodeURIComponent(signature)}`;
  return { url, signString, signature };
}

function soeError(code: unknown, message: string): AppError {
  const c = String(code);
  const hint: Record<string, string> = {
    "4001": "参数不对",
    "4002": "腾讯云密钥验证失败，请检查 SecretId / SecretKey",
    "4003": "这个 AppID 还没有开通口语评测（新版），或资源包已用完",
    "4004": "资源包已用完或账户欠费",
  };
  const extra = hint[c] ? `（${hint[c]}）` : "";
  return new AppError(502, `tencent_${c}`, `腾讯评测出错 ${c}：${message}${extra}`);
}

async function openSocket(url: string): Promise<WebSocket> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Upgrade: "websocket" } });
  } catch (e) {
    throw new AppError(502, "tencent_network", `连不上腾讯评测服务：${(e as Error).message}`);
  }
  const ws = resp.webSocket;
  if (!ws) {
    const body = await resp.text().catch(() => "");
    console.error("tencent_handshake_http", resp.status, body.slice(0, 500));
    throw new AppError(502, "tencent_http", `腾讯评测拒绝连接（HTTP ${resp.status}）${body.slice(0, 200)}`);
  }
  ws.accept();
  return ws;
}

/** Wraps raw 16 kHz mono PCM16 in a 44-byte WAV header. */
export function pcmToWav(pcm: ArrayBuffer, sampleRate = 16000): ArrayBuffer {
  const out = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(out);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  new Uint8Array(out, 44).set(new Uint8Array(pcm));
  return out;
}

/**
 * Sends one recording (raw 16 kHz mono PCM16, at most ~60 s) and resolves with Tencent's final message.
 * When `handshakeOnly` is set, closes right after the server accepts the credentials (used by "test connection").
 */
export async function runSoe(
  creds: TencentCreds,
  pcm: ArrayBuffer | null,
  p: SoeParams,
  opts: { handshakeOnly?: boolean; timeoutMs?: number } = {},
): Promise<any> {
  const { url } = await buildSoeUrl(creds, p);
  const ws = await openSocket(url);
  const timeoutMs = opts.timeoutMs ?? 45_000;

  return await new Promise((resolve, reject) => {
    let stage: "handshake" | "sent" | "done" = "handshake";
    const finish = (fn: () => void) => {
      if (stage === "done") return;
      stage = "done";
      clearTimeout(timer);
      try {
        ws.close(1000, "done");
      } catch {
        /* already closed */
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new AppError(504, "tencent_timeout", "腾讯评测超时，请再试一次"))),
      timeoutMs,
    );

    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: any;
      try {
        const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        msg = JSON.parse(text);
      } catch {
        finish(() => reject(new AppError(502, "tencent_bad_reply", "腾讯评测返回了无法识别的数据")));
        return;
      }
      if (msg.code !== 0) {
        console.error("tencent_reply", JSON.stringify(msg).slice(0, 500));
        finish(() => reject(soeError(msg.code, msg.message || "unknown")));
        return;
      }
      if (stage === "handshake") {
        if (opts.handshakeOnly || !pcm) {
          finish(() => resolve(msg));
          return;
        }
        stage = "sent";
        ws.send(pcmToWav(pcm));
        ws.send(JSON.stringify({ type: "end" }));
        return;
      }
      if (msg.final === 1) finish(() => resolve(msg));
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      finish(() => reject(new AppError(502, "tencent_closed", `腾讯评测连接被关闭（${ev.code} ${ev.reason || ""}）`)));
    });
    ws.addEventListener("error", () => {
      finish(() => reject(new AppError(502, "tencent_ws_error", "腾讯评测连接出错")));
    });
  });
}

function score100(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10) / 10;
}

function ratioTo100(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round((n <= 1 ? n * 100 : n) * 10) / 10;
}

/** Turns Tencent's final message into the small shape the app stores and draws. */
export function compactResult(msg: any): Assessment {
  const r = msg?.result ?? {};
  const words: WordScore[] = (Array.isArray(r.Words) ? r.Words : []).map((w: any): WordScore => {
    const ph: PhoneScore[] = (Array.isArray(w.PhoneInfos) ? w.PhoneInfos : []).map((p: any): PhoneScore => {
      const out: PhoneScore = {
        l: String(p.ReferenceLetter ?? ""),
        r: String(p.ReferencePhone ?? ""),
        p: String(p.Phone ?? ""),
        s: score100(p.PronAccuracy),
        tag: Number(p.MatchTag ?? 0),
      };
      if (p.Stress) out.st = 1;
      if (p.DetectedStress) out.ds = 1;
      return out;
    });
    const out: WordScore = {
      w: String(w.Word ?? ""),
      ref: String(w.ReferenceWord ?? ""),
      s: score100(w.PronAccuracy),
      tag: Number(w.MatchTag ?? 0),
      ph,
    };
    if (Number.isFinite(w.MemBeginTime)) out.b = w.MemBeginTime;
    if (Number.isFinite(w.MemEndTime)) out.e = w.MemEndTime;
    return out;
  });
  const transcript = words
    .filter((w) => w.tag !== 2)
    .map((w) => w.w || w.ref)
    .filter(Boolean)
    .join(" ");
  return {
    score: score100(r.SuggestedScore),
    accuracy: score100(r.PronAccuracy),
    fluency: ratioTo100(r.PronFluency),
    completion: ratioTo100(r.PronCompletion),
    words,
    transcript,
  };
}

// ---------- Local test double (MOCK=1): plausible scores without calling Tencent ----------

const MOCK_PHONES: Record<string, string[]> = {
  th: ["th"],
  sh: ["sh"],
  ch: ["ch"],
  ng: ["ng"],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function mockAssessment(refText: string, evalMode: number, audioBytes: number): Assessment {
  const seconds = audioBytes / 32000;
  const source =
    evalMode === EVAL_MODES.free
      ? "Well I think studying in the morning is better for me because my mind is more clear and I can focus on reading"
      : refText;
  const tokens = source.split(/\s+/).filter(Boolean);
  const words: WordScore[] = tokens.map((tok, i) => {
    const clean = tok.replace(/[^A-Za-z']/g, "");
    const s = 55 + (hash(clean.toLowerCase() + i) % 45);
    const ph: PhoneScore[] = [];
    let j = 0;
    while (j < clean.length) {
      const two = clean.slice(j, j + 2).toLowerCase();
      if (MOCK_PHONES[two]) {
        ph.push({ l: clean.slice(j, j + 2), r: MOCK_PHONES[two][0], p: MOCK_PHONES[two][0], s: Math.max(20, s - 25), tag: 0 });
        j += 2;
      } else {
        const ch = clean[j].toLowerCase();
        ph.push({ l: clean[j], r: ch, p: ch, s: Math.min(100, s + (hash(ch + i) % 10)), tag: 0 });
        j += 1;
      }
    }
    return { w: clean, ref: evalMode === EVAL_MODES.free ? "" : clean, s, tag: s < 60 ? 3 : 0, ph, b: i * 400, e: i * 400 + 350 };
  });
  const avg = words.reduce((a, w) => a + (w.s ?? 0), 0) / Math.max(1, words.length);
  return {
    score: Math.round(avg * 10) / 10,
    accuracy: Math.round(avg * 10) / 10,
    fluency: Math.min(100, Math.round(60 + seconds)),
    completion: evalMode === EVAL_MODES.free ? null : 100,
    words,
    transcript: words.map((w) => w.w).join(" "),
  };
}
