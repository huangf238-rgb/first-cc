// Tencent Cloud text-to-speech (TextToVoice, API 3.0, TC3-HMAC-SHA256 signing).

import { AppError, type TencentCreds } from "./types";

const HOST = "tts.tencentcloudapi.com";
const SERVICE = "tts";
const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

/** Builds the TC3 Authorization header. Exported so it can be checked against an independent implementation. */
export async function tc3Authorization(creds: TencentCreds, action: string, payload: string, timestamp: number) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const signedHeaders = "content-type;host;x-tc-action";
  const canonical = [
    "POST",
    "/",
    "",
    `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`,
    signedHeaders,
    await sha256Hex(payload),
  ].join("\n");
  const scope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), scope, await sha256Hex(canonical)].join("\n");
  const kDate = await hmac(enc.encode(`TC3${creds.secretKey}`), date);
  const kService = await hmac(kDate, SERVICE);
  const kSigning = await hmac(kService, "tc3_request");
  const sig = Array.from(new Uint8Array(await hmac(kSigning, stringToSign)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `TC3-HMAC-SHA256 Credential=${creds.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
}

/** Returns MP3 bytes for up to ~500 characters of English. */
export async function synthesize(creds: TencentCreds, text: string, voiceType: number, speed: number): Promise<Uint8Array> {
  const payload = JSON.stringify({
    Text: text,
    SessionId: crypto.randomUUID(),
    VoiceType: voiceType,
    PrimaryLanguage: 2, // English
    Codec: "mp3",
    SampleRate: 16000,
    Speed: speed,
    Volume: 0,
    ModelType: 1,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  let resp: Response;
  try {
    resp = await fetch(`https://${HOST}/`, {
      method: "POST",
      headers: {
        Authorization: await tc3Authorization(creds, "TextToVoice", payload, timestamp),
        "Content-Type": "application/json; charset=utf-8",
        Host: HOST,
        "X-TC-Action": "TextToVoice",
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": "2019-08-23",
        "X-TC-Region": "ap-guangzhou",
      },
      body: payload,
    });
  } catch (e) {
    throw new AppError(502, "tts_network", `连不上腾讯语音合成：${(e as Error).message}`);
  }
  const data: any = await resp.json().catch(() => ({}));
  const err = data?.Response?.Error;
  if (err) {
    console.error("tencent_tts_error", JSON.stringify(err));
    const hint = /ServerNotOpen|NotOpen|未开通/i.test(`${err.Code} ${err.Message}`)
      ? "（请在腾讯云控制台开通「语音合成」服务）"
      : /Balance|Arrear|欠费|余额/i.test(`${err.Code} ${err.Message}`)
        ? "（语音合成免费额度已用完或账户欠费）"
        : "";
    throw new AppError(502, "tts_error", `腾讯语音合成出错 ${err.Code}：${err.Message}${hint}`);
  }
  const b64 = data?.Response?.Audio;
  if (typeof b64 !== "string" || !b64) throw new AppError(502, "tts_empty", "腾讯语音合成没有返回声音");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- Cloudflare Workers AI ----------

export const AURA_SPEAKERS = ["luna", "thalia", "helena", "apollo", "orion", "arcas"];

async function toBytes(result: unknown): Promise<Uint8Array> {
  if (result instanceof ReadableStream) return new Uint8Array(await new Response(result).arrayBuffer());
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Uint8Array) return result;
  const audio = (result as any)?.audio;
  if (typeof audio === "string") {
    const bin = atob(audio);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new AppError(502, "ai_tts_shape", "Workers AI 返回的声音格式无法识别");
}

export function audioType(b: Uint8Array): string {
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 ? "audio/wav" : "audio/mpeg";
}

/** Deepgram Aura-2 first; if that fails (e.g. the free daily allowance is used up), MeloTTS. */
export async function synthesizeWorkersAI(ai: Ai, text: string, speaker: string): Promise<{ bytes: Uint8Array; engine: string }> {
  try {
    const r = await (ai as any).run("@cf/deepgram/aura-2-en", { text, speaker, encoding: "mp3" });
    return { bytes: await toBytes(r), engine: "aura-2" };
  } catch (e) {
    console.error("aura_failed", String((e as Error)?.message ?? e));
  }
  try {
    const r = await (ai as any).run("@cf/myshell-ai/melotts", { prompt: text, lang: "en" });
    return { bytes: await toBytes(r), engine: "melotts" };
  } catch (e) {
    console.error("melotts_failed", String((e as Error)?.message ?? e));
    throw new AppError(502, "ai_tts_failed", `Cloudflare 语音合成失败：${(e as Error)?.message ?? e}`);
  }
}
