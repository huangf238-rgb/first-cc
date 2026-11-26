// Worker entry: /api/* is the backend, everything else is the phone web app in public/.

import { dailySummary, speakingFeedback, testClaude, type FeedbackInput } from "./claude";
import { Store, addDays, dayOf } from "./store";
import { compactResult, EVAL_MODES, mockAssessment, runSoe, type EvalModeName } from "./tencent";
import { ASSETS } from "./assets.gen";
import { AppError, type Env, type WordScore } from "./types";

export { Store };

const LIMITS = { assess: 600, feedback: 80, summary: 3 };
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
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
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
        !fields.anthropicKey && "Claude API 密钥",
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
    const [settings, latest, sets, keys, todayCount] = await Promise.all([
      s.settings(),
      s.latestSummary(),
      s.listeningSets(10),
      s.maskedSecrets(),
      s.countToday(),
    ]);
    return json({ settings, latestSummary: latest, listeningSets: sets, keys, todayCount, mock });
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
      testClaude(secrets.anthropicKey)
        .then((name) => (result.claude = { ok: true, message: `Claude：密钥有效（${name}）` }))
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
    if (mock) {
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
    const fb = await speakingFeedback(secrets?.anthropicKey ?? "", input, mock);
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
  if (!secrets && !mock) throw new AppError(400, "not_configured", "还没有填完密钥");
  const digest = await s.digest(day);
  const { summary, model } = await dailySummary(secrets?.anthropicKey ?? "", digest, mock);
  await s.saveSummary(day, summary, model, source);
  return { day, model, summary, previousDay: addDays(day, -1) };
}
