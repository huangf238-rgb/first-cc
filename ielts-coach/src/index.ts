// Worker entry: /api/* is the backend, everything else is the phone web app in public/.

import { dailySummary, speakingFeedback, testClaude, type FeedbackInput } from "./claude";
import { Store, addDays, dayOf } from "./store";
import { compactResult, EVAL_MODES, mockAssessment, runSoe, type EvalModeName } from "./tencent";
import { ASSETS } from "./assets.gen";
import { synthesize } from "./tts";
import { AppError, type DailySummary, type Env, type WordScore } from "./types";

export { Store };

const LIMITS = { assess: 600, feedback: 80, summary: 3, tts: 3000 };
// 32 s of 16 kHz PCM16 (just under 1 MiB, so one recording fits in one WebSocket message);
// the app cuts long answers into pieces of at most ~28 s.
const MAX_AUDIO_BYTES = 32 * 32000;
const MIN_AUDIO_BYTES = 3200; // 0.1 s

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof AppError) {
    console.error("app_error", e.status, e.code, e.message);
    return json({ error: { code: e.code, message: e.message } }, e.status);
  }
  console.error("unhandled", e);
  return json({ error: { code: "internal", message: `服务器出错：${(e as Error)?.message ?? e}` } }, 500);
}

function serveAsset(pathname: string): Response {
  const file = ASSETS[pathname === "/" ? "/index.html" : pathname];
  if (!file) return new Response("Not found", { status: 404 });
  return new Response(file.body, { headers: { "content-type": file.type, "cache-control": "no-cache" } });
}

function store(env: Env) {
  return env.STORE.get(env.STORE.idFromName("main"));
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new AppError(400, "bad_json", "请求内容不是有效的 JSON");
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return serveAsset(url.pathname);
    try {
      return await handleApi(request, env, ctx, url);
    } catch (e) {
      return errorResponse(e);
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runDailySummary(env, "cron").catch((e) => {
        console.error("daily summary failed", e);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleApi(req: Request, env: Env, _ctx: ExecutionContext, url: URL): Promise<Response> {
  const s = store(env);
  const route = `${req.method} ${url.pathname}`;
  const mock = env.MOCK === "1";
  const mockTencent = mock || env.MOCK === "tencent"; // "tencent": fake scores only, Claude path stays real

  // ----- open routes -----
  if (route === "GET /api/status") {
    const configured = await s.isConfigured();
    return json({ configured, needsSetupCode: !configured && !!env.SETUP_CODE, mock });
  }

  if (route === "POST /api/setup") {
    const body = await readJson(req);
    const hasPass = await s.hasPasscode();
    if (hasPass) {
      if (!(await s.verifyPass(str(req.headers.get("x-pass"), 200)))) throw new AppError(401, "bad_pass", "当前口令不对");
    } else if (env.SETUP_CODE && str(body.setupCode, 200) !== env.SETUP_CODE) {
      throw new AppError(403, "bad_setup_code", "初始化码不对，请核对 Claude 给你的那串字符");
    }
    const fields = {
      passcode: str(body.passcode, 200),
      tencentAppId: str(body.tencentAppId, 40),
      tencentSecretId: str(body.tencentSecretId, 200),
      tencentSecretKey: str(body.tencentSecretKey, 200),
      anthropicKey: str(body.anthropicKey, 300),
    };
    if (!hasPass && fields.passcode.length < 4) throw new AppError(400, "short_pass", "口令至少 4 位");
    if (fields.passcode && fields.passcode.length < 4) throw new AppError(400, "short_pass", "口令至少 4 位");
    if (fields.tencentAppId && !/^\d{5,20}$/.test(fields.tencentAppId)) throw new AppError(400, "bad_appid", "腾讯云 AppID 应该是一串数字");
    if (fields.anthropicKey && !fields.anthropicKey.startsWith("sk-ant-")) throw new AppError(400, "bad_claude_key", "Claude API 密钥应该以 sk-ant- 开头");
    if (!hasPass) {
      // First setup saves everything at once; later updates may change any single field.
      const missing = [
        !fields.tencentAppId && "腾讯云 AppID",
        !fields.tencentSecretId && "SecretId",
        !fields.tencentSecretKey && "SecretKey",
      ].filter(Boolean);
      if (missing.length) throw new AppError(400, "missing", `还缺：${missing.join("、")}`);
    }
    await s.saveSetup(fields);
    return json({ ok: true, configured: await s.isConfigured() });
  }

  if (route === "POST /api/login") {
    const body = await readJson(req);
    const ok = await s.verifyPass(str(body.passcode, 200));
    if (!ok) throw new AppError(401, "bad_pass", "口令不对");
    return json({ ok: true });
  }

  // ----- everything below needs the passcode -----
  if (!(await s.verifyPass(str(req.headers.get("x-pass"), 200)))) {
    throw new AppError(401, "need_login", "请先输入口令");
  }

  if (route === "GET /api/home") {
    const [settings, latest, sets, keys, todayCount, secrets] = await Promise.all([
      s.settings(),
      s.latestSummary(),
      s.listeningSets(10),
      s.maskedSecrets(),
      s.countToday(),
      s.secrets(),
    ]);
    const claudeEnabled = mock || !!secrets?.anthropicKey;
    return json({ settings, latestSummary: latest, listeningSets: sets, keys, todayCount, mock, claudeEnabled });
  }

  if (route === "POST /api/settings") {
    const body = await readJson(req);
    return json({ settings: await s.saveSettings({ scoreCoeff: num(body.scoreCoeff) ?? undefined, timezone: str(body.timezone, 64) || undefined }) });
  }

  if (route === "POST /api/test") {
    const secrets = await s.secrets();
    if (!secrets) throw new AppError(400, "not_configured", "还没有填完密钥");
    const result: Record<string, { ok: boolean; message: string }> = {};
    if (mock) {
      result.tencent = { ok: true, message: "测试模式：没有真的连接腾讯" };
      result.claude = { ok: true, message: "测试模式：没有真的连接 Claude" };
      return json(result);
    }
    await Promise.all([
      runSoe(secrets.tencent, null, { refText: "hello", evalMode: EVAL_MODES.word, scoreCoeff: 3 }, { handshakeOnly: true, timeoutMs: 15_000 })
        .then(() => (result.tencent = { ok: true, message: "腾讯云口语评测：连接成功，密钥有效" }))
        .catch((e) => (result.tencent = { ok: false, message: (e as Error).message })),
      (secrets.anthropicKey ? testClaude(secrets.anthropicKey) : Promise.resolve(null))
        .then((name) =>
          (result.claude = name
            ? { ok: true, message: `Claude：密钥有效（${name}）` }
            : { ok: true, message: "Claude：没有填 API 密钥，点评用「复制给 Claude App」（用你的会员）" }))
        .catch((e) => (result.claude = { ok: false, message: (e as Error).message })),
    ]);
    return json(result);
  }

  if (route === "POST /api/assess") {
    const mode = (url.searchParams.get("mode") ?? "sentence") as EvalModeName;
    if (!(mode in EVAL_MODES)) throw new AppError(400, "bad_mode", "评测模式不对");
    let refText = str(url.searchParams.get("ref"), 1200).replace(/\s+/g, " ");
    if (mode !== "free" && !refText) throw new AppError(400, "no_ref", "缺少要读的原文");
    if (mode === "free") refText = "";
    const save = url.searchParams.get("save");
    const item = str(url.searchParams.get("item"), 80) || null;

    const audio = await req.arrayBuffer();
    if (audio.byteLength < MIN_AUDIO_BYTES) throw new AppError(400, "too_short", "录音太短了，请再读一次");
    if (audio.byteLength > MAX_AUDIO_BYTES) throw new AppError(413, "too_long", "这段录音太长了（单段最长约 30 秒）");
    if (audio.byteLength % 2) throw new AppError(400, "bad_audio", "录音数据格式不对");

    if (!(await s.takeQuota("assess", LIMITS.assess))) throw new AppError(429, "quota", `今天的评测次数已达上限（${LIMITS.assess} 次），明天再练`);

    let evalMode: number = EVAL_MODES[mode];
    if (mode === "sentence" && refText.split(" ").length > 30) evalMode = EVAL_MODES.paragraph;

    const settings = await s.settings();
    let result;
    if (mockTencent) {
      result = mockAssessment(refText, evalMode, audio.byteLength);
    } else {
      const secrets = await s.secrets();
      if (!secrets) throw new AppError(400, "not_configured", "还没有填完密钥");
      const msg = await runSoe(secrets.tencent, audio, { refText, evalMode, scoreCoeff: settings.scoreCoeff });
      result = compactResult(msg);
    }

    let attemptId: number | null = null;
    if (save === "shadow" || save === "word") {
      const saved = await s.addAttempt(save, item, refText, {
        score: result.score,
        accuracy: result.accuracy,
        fluency: result.fluency,
        completion: result.completion,
        words: result.words,
        seconds: Math.round((audio.byteLength / 32000) * 10) / 10,
      });
      attemptId = saved.id;
    }
    return json({ result, attemptId });
  }

  if (route === "POST /api/feedback") {
    const body = await readJson(req);
    const transcript = str(body.transcript, 4000);
    const question = str(body.question, 600);
    const part = str(body.part, 20) || "Part 1";
    const durationSec = Math.max(1, Math.min(600, num(body.durationSec) ?? 1));
    if (!question) throw new AppError(400, "no_question", "缺少题目");
    if (transcript.split(/\s+/).filter(Boolean).length < 2) {
      throw new AppError(400, "empty_answer", "没听到你说的内容，请靠近麦克风再答一次");
    }
    const words: WordScore[] = Array.isArray(body.words) ? body.words.slice(0, 600) : [];
    const pron = {
      score: num(body.pron?.score),
      accuracy: num(body.pron?.accuracy),
      fluency: num(body.pron?.fluency),
      completion: num(body.pron?.completion),
    };
    const lowWords = words
      .filter((w) => w && typeof w.s === "number" && w.s < 70 && (w.w || w.ref))
      .sort((a, b) => (a.s ?? 0) - (b.s ?? 0))
      .slice(0, 8)
      .map((w) => ({
        word: w.w || w.ref,
        score: w.s,
        weakSounds: (w.ph ?? []).filter((p) => typeof p.s === "number" && p.s < 60).map((p) => `${p.r}(${p.l})`),
      }));
    const wordCount = transcript.split(/\s+/).filter(Boolean).length;
    const input: FeedbackInput = {
      part,
      question,
      transcript,
      durationSec: Math.round(durationSec),
      wordsPerMinute: Math.round(wordCount / (durationSec / 60)),
      pron,
      lowWords,
    };

    if (!(await s.takeQuota("feedback", LIMITS.feedback))) throw new AppError(429, "quota", `今天的口语点评已达上限（${LIMITS.feedback} 次）`);
    const secrets = await s.secrets();
    if (!secrets && !mock) throw new AppError(400, "not_configured", "还没有填完密钥");
    const fb = mock || secrets?.anthropicKey ? await speakingFeedback(secrets?.anthropicKey ?? "", input, mock) : null;
    const saved = await s.addAttempt("speak", str(body.item, 80) || null, question, {
      part,
      question,
      transcript,
      durationSec: input.durationSec,
      wpm: input.wordsPerMinute,
      pron,
      words,
      fb,
    });
    return json({ feedback: fb, wordsPerMinute: input.wordsPerMinute, attemptId: saved.id });
  }

  if (route === "POST /api/listen") {
    const body = await readJson(req);
    const score = num(body.score);
    const total = num(body.total);
    if (score == null || total == null) throw new AppError(400, "bad_score", "缺少得分");
    const wrong = Array.isArray(body.wrong)
      ? body.wrong.slice(0, 20).map((w: any) => ({ n: num(w.n), label: str(w.label, 80), given: str(w.given, 80), answer: str(w.answer, 80) }))
      : [];
    const saved = await s.addAttempt("listen", str(body.setId, 80) || null, str(body.title, 200) || null, {
      setId: str(body.setId, 80),
      title: str(body.title, 200),
      score,
      total,
      wrong,
    });
    return json({ ok: true, attemptId: saved.id });
  }

  if (route === "GET /api/report") {
    return json(await s.report());
  }

  if (route === "POST /api/summary") {
    if (!(await s.takeQuota("summary", LIMITS.summary))) throw new AppError(429, "quota", `今天已经手动生成过 ${LIMITS.summary} 次总结了，明天再来`);
    const result = await runDailySummary(env, "manual");
    return json(result);
  }

  if (route === "POST /api/tts") {
    const body = await readJson(req);
    const text = str(body.text, 600).replace(/\s+/g, " ");
    const voice = Math.round(num(body.voice) ?? 0);
    const speed = Math.max(-2, Math.min(6, Math.round((num(body.speed) ?? 0) * 10) / 10));
    if (!text || text.length > 500) throw new AppError(400, "bad_text", "每段朗读最多 500 个字符");
    if (voice < 1 || voice > 99999999) throw new AppError(400, "bad_voice", "音色编号不对");
    if (mockTencent) throw new AppError(501, "tts_mock", "测试模式不合成声音");
    const key = await sha256(`${voice}|${speed}|${text}`);
    let audio = await s.getTts(key);
    if (!audio) {
      if (!(await s.takeQuota("tts", LIMITS.tts))) throw new AppError(429, "quota", "今天的朗读次数已达上限");
      const secrets = await s.secrets();
      if (!secrets) throw new AppError(400, "not_configured", "还没有填完腾讯云密钥");
      const bytes = await synthesize(secrets.tencent, text, voice, speed);
      audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      await s.putTts(key, audio);
    }
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=604800" } });
  }

  if (route === "POST /api/import-plan") {
    const body = await readJson(req);
    const summary = parsePastedPlan(str(body.text, 60000));
    const day = await s.today();
    await s.saveSummary(day, summary, "claude-app", "paste");
    return json({ ok: true, day, sentences: summary.practice_sentences.length, questions: summary.listening.questions.length });
  }

  if (route === "GET /api/digest") {
    return json(await s.digest(await s.today()));
  }

  if (route === "GET /api/export") {
    return json(await s.exportAll());
  }

  throw new AppError(404, "not_found", `没有这个接口：${route}`);
}

/** Builds today's digest, asks Opus for the evening report and saves it. */
async function runDailySummary(env: Env, source: "cron" | "manual") {
  const s = store(env);
  const settings = await s.settings();
  const day = dayOf(Date.now(), settings.timezone);
  if (source === "cron") {
    if (await s.summaryFor(day)) return { skipped: "already_done", day };
    if ((await s.countToday()) === 0) return { skipped: "no_practice_today", day };
  }
  const secrets = await s.secrets();
  const mock = env.MOCK === "1";
  if (!secrets?.anthropicKey && !mock) {
    if (source === "cron") return { skipped: "no_claude_key", day };
    throw new AppError(400, "no_claude_key", "没有填 Claude API 密钥：请用「复制给 Claude App」分析");
  }
  const digest = await s.digest(day);
  const { summary, model } = await dailySummary(secrets?.anthropicKey ?? "", digest, mock);
  await s.saveSummary(day, summary, model, source);
  return { day, model, summary, previousDay: addDays(day, -1) };
}

/** Reads the JSON block Claude was asked to append, and fills in anything missing. */
function parsePastedPlan(text: string): DailySummary {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g);
  const candidates = [...(fenced ?? []).map((b) => b.replace(/```(?:json)?/g, "").trim()).reverse()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  let data: any = null;
  for (const c of candidates) {
    try {
      data = JSON.parse(c);
      if (data && typeof data === "object") break;
    } catch {
      data = null;
    }
  }
  if (!data) throw new AppError(400, "no_json", "没找到 Claude 回答最后那段数据（{ 开头 } 结尾）。请把 Claude 的整段回答都复制过来");
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const t = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
  const L = data.listening ?? {};
  const summary: DailySummary = {
    summary_zh: t(data.summary_zh),
    progress_zh: t(data.progress_zh),
    weak_points: arr(data.weak_points).slice(0, 6).map((w: any) => ({ area: t(w?.area, 40), detail_zh: t(w?.detail_zh, 500) })),
    tomorrow_plan: arr(data.tomorrow_plan).slice(0, 8).map((p: any) => ({ task_zh: t(p?.task_zh, 300), minutes: Number(p?.minutes) || 10 })),
    practice_sentences: arr(data.practice_sentences)
      .slice(0, 12)
      .map((p: any) => ({ text: t(p?.text, 300), focus: t(p?.focus, 60), tip_zh: t(p?.tip_zh, 300) }))
      .filter((p) => /[A-Za-z]/.test(p.text)),
    listening: {
      title: t(L.title, 200) || "Coach listening",
      context_zh: t(L.context_zh, 200),
      lines: arr(L.lines).slice(0, 40).map((l: any) => ({ speaker: (l?.speaker === "B" ? "B" : "A") as "A" | "B", text: t(l?.text, 500) })).filter((l) => l.text),
      questions: arr(L.questions)
        .slice(0, 12)
        .map((q: any) => ({ label: t(q?.label, 120), answers: arr(q?.answers).map((a: unknown) => t(a, 80)).filter(Boolean), hint_zh: t(q?.hint_zh, 200) }))
        .filter((q) => q.label && q.answers.length),
    },
    encouragement_zh: t(data.encouragement_zh, 300),
  };
  if (!summary.practice_sentences.length && !summary.listening.lines.length && !summary.tomorrow_plan.length) {
    throw new AppError(400, "empty_plan", "这段数据里没有跟读句、听力或计划，请确认复制的是 Claude 的完整回答");
  }
  return summary;
}

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
