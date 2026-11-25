// Claude calls: Haiku 5.5 gives quick feedback on each speaking answer,
// Opus 5.5 writes the daily summary, tomorrow's plan and new practice material.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { AppError, type DailySummary, type SpeakFeedback } from "./types";

export const FEEDBACK_MODEL = "claude-haiku-5-5";
export const SUMMARY_MODEL = "claude-opus-5-5";

// ---------- Schemas ----------

const FeedbackSchema = z.object({
  fc: z.number().describe("Fluency and Coherence band, 0-9 in half bands"),
  lr: z.number().describe("Lexical Resource band, 0-9 in half bands"),
  gra: z.number().describe("Grammatical Range and Accuracy band, 0-9 in half bands"),
  pron: z.number().describe("Pronunciation band estimate, 0-9 in half bands"),
  overall_zh: z.string().describe("2-3 short sentences in simplified Chinese: the biggest strength and the one thing to fix next"),
  corrections: z
    .array(
      z.object({
        original: z.string().describe("the learner's exact words"),
        better: z.string().describe("corrected or upgraded version"),
        why_zh: z.string().describe("short reason in simplified Chinese"),
      }),
    )
    .describe("0-5 most important corrections"),
  pron_tips: z
    .array(z.object({ word: z.string(), tip_zh: z.string().describe("mouth/tongue advice in simplified Chinese") }))
    .describe("0-3 pronunciation tips for the lowest-scoring words"),
  better_answer: z.string().describe("a natural band-7 answer to the same question that keeps the learner's ideas"),
  phrases: z
    .array(z.object({ en: z.string(), zh: z.string() }))
    .describe("3-5 useful phrases from better_answer with Chinese meaning"),
});

const SummarySchema = z.object({
  summary_zh: z.string().describe("what was practised today, 2-4 sentences, simplified Chinese"),
  progress_zh: z.string().describe("trend versus earlier days with concrete numbers, simplified Chinese"),
  weak_points: z
    .array(z.object({ area: z.string().describe("发音 / 语法 / 词汇 / 流利度 / 听力"), detail_zh: z.string() }))
    .describe("2-4 specific weak points"),
  tomorrow_plan: z
    .array(z.object({ task_zh: z.string(), minutes: z.number() }))
    .describe("3-5 tasks for tomorrow, 45-60 minutes in total"),
  practice_sentences: z
    .array(
      z.object({
        text: z.string().describe("natural English sentence, 8-16 words"),
        focus: z.string().describe("the sound or word it drills, e.g. /θ/ or 'vegetable'"),
        tip_zh: z.string(),
      }),
    )
    .describe("6-8 new sentences that drill the weakest sounds and words"),
  listening: z.object({
    title: z.string().describe("English title of the form, e.g. 'Hillside Gym - Membership Form'"),
    context_zh: z.string().describe("one-line Chinese description of the situation"),
    lines: z
      .array(z.object({ speaker: z.enum(["A", "B"]), text: z.string() }))
      .describe("14-20 lines; A is the staff member, B is the caller"),
    questions: z
      .array(
        z.object({
          label: z.string().describe("form field name, e.g. 'Surname' or 'Start date'"),
          answers: z.array(z.string()).describe("accepted answers; every one appears in the dialogue; ONE WORD AND/OR A NUMBER"),
          hint_zh: z.string().describe("explains the trap or distractor"),
        }),
      )
      .describe("6-8 form-completion questions in dialogue order"),
  }),
  encouragement_zh: z.string(),
});

// ---------- Prompts ----------

const FEEDBACK_SYSTEM = `You are an experienced IELTS Speaking examiner and a patient tutor.
The learner is a Chinese adult who passed CET-4 (about IELTS 5.0-5.5) and is aiming for overall band 6.5 (Speaking 6.0 or higher).

You receive one answer: the IELTS part and question, the transcript, the answer length and speaking rate, and scores from a pronunciation engine (0-100) with its lowest-scoring words.
The transcript comes from the pronunciation engine's speech recognition: it has no punctuation, may drop or mishear short words, and may contain recognition errors. Do not punish obvious recognition errors, and do not invent mistakes the learner did not make.

Score with the public IELTS Speaking band descriptors, in half bands, realistically rather than generously:
- fc (Fluency and Coherence): length, development of ideas, linking, and the engine fluency score. A Part 1 answer under 15 words or a Part 2 answer under 80 words cannot get more than 5 for fc.
- lr (Lexical Resource) and gra (Grammatical Range and Accuracy): from the transcript.
- pron (Pronunciation): an estimate from the engine scores and the low-scoring words. As a rough guide only, an engine accuracy around 85 suggests about band 7, around 75 about band 6, around 65 about band 5; adjust for how intelligible the low-scoring words would be.

Feedback rules:
- Every *_zh field is simplified Chinese, short and concrete.
- corrections: at most 5, the ones that matter most for the band score. "original" quotes the learner's exact words.
- pron_tips: at most 3, only for words in the low-scoring list; describe mouth and tongue position.
- better_answer: a natural band-7 answer to the same question that keeps the learner's own ideas. Part 1: 3-4 sentences. Part 2: 180-230 words. Part 3: 5-7 sentences. Plain spoken English, no lists or headings.
- phrases: 3-5 phrases taken from better_answer that the learner can reuse.`;

const SUMMARY_SYSTEM = `You are the personal IELTS coach of a Chinese adult learner (CET-4 level, about IELTS 5.0-5.5) who is aiming for overall band 6.5: Listening 7, Speaking 6.
Every evening you receive a JSON digest of today's practice in their phone app and the last 7 days of history. The app has three practice tabs:
- 跟读 (shadowing): the learner reads a sentence aloud and a pronunciation engine scores every word and sound from 0 to 100. Sounds are given as engine phone codes with the letters that spell them.
- 口语 (speaking): IELTS Speaking Part 1/2/3 answers, with band estimates and corrections from a quick review.
- 听力 (listening): IELTS Section 1 form-completion tasks.

Write the evening report:
- summary_zh: what was practised today. If nothing was practised today, say so plainly and make tomorrow's plan an easy restart.
- progress_zh: the trend compared with earlier days, with concrete numbers from the digest. Do not invent numbers.
- weak_points: 2-4 specific weak points (sounds with example words, grammar patterns from corrections, listening traps), each tied to evidence in the digest.
- tomorrow_plan: 3-5 tasks, 45-60 minutes in total, each naming the tab to use.
- practice_sentences: 6-8 new natural sentences on common IELTS topics that drill the weakest sounds and words, 8-16 words each.
- listening: one new, original IELTS Section 1 style phone call (A is a staff member, B is the caller) with 14-20 lines and 6-8 form-completion questions in dialogue order. Each answer is ONE WORD AND/OR A NUMBER and appears word for word in the dialogue. Include realistic traps: a speaker corrects themselves, spells a name letter by letter, or gives a number then changes it. Accept natural variants in "answers" (for example "6.45", "6:45"). Do not copy real exam material.
- encouragement_zh: one sentence.
All *_zh fields are simplified Chinese.`;

// ---------- Errors ----------

export function claudeError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof Anthropic.AuthenticationError) {
    return new AppError(502, "claude_auth", "Claude API 密钥无效，请在「设置」里重新填写");
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new AppError(502, "claude_permission", `Claude API 密钥没有权限：${e.message}`);
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AppError(429, "claude_rate_limit", "Claude 请求太频繁，请等一分钟再试");
  }
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(e.message)) {
      return new AppError(402, "claude_credit", "Claude API 余额不足，请到 platform.claude.com 充值");
    }
    return new AppError(502, "claude_bad_request", `Claude 请求出错：${e.message}`);
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AppError(502, "claude_network", "暂时连不上 Claude，请稍后再试");
  }
  if (e instanceof Anthropic.APIError) {
    return new AppError(502, "claude_error", `Claude 出错（${e.status ?? "?"}）：${e.message}`);
  }
  return new AppError(500, "claude_unknown", (e as Error)?.message ?? String(e));
}

function client(apiKey: string, timeoutMs: number): Anthropic {
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 });
}

/** Checks the key without spending tokens. */
export async function testClaude(apiKey: string): Promise<string> {
  try {
    const m = await client(apiKey, 20_000).models.retrieve(FEEDBACK_MODEL);
    return m.display_name || m.id;
  } catch (e) {
    throw claudeError(e);
  }
}

// ---------- Speaking feedback (Haiku 5.5) ----------

export interface FeedbackInput {
  part: string;
  question: string;
  transcript: string;
  durationSec: number;
  wordsPerMinute: number;
  pron: { score: number | null; accuracy: number | null; fluency: number | null; completion: number | null };
  lowWords: { word: string; score: number | null; weakSounds: string[] }[];
}

const half = (n: number) => Math.min(9, Math.max(0, Math.round(n * 2) / 2));

export async function speakingFeedback(apiKey: string, input: FeedbackInput, mock: boolean): Promise<SpeakFeedback> {
  if (mock) return mockFeedback(input);
  let msg;
  try {
    msg = await client(apiKey, 90_000).messages.parse({
      model: FEEDBACK_MODEL,
      max_tokens: 6000,
      system: FEEDBACK_SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(FeedbackSchema) },
      messages: [{ role: "user", content: JSON.stringify(input, null, 1) }],
    });
  } catch (e) {
    throw claudeError(e);
  }
  if (msg.stop_reason === "refusal") throw new AppError(502, "claude_refusal", "Claude 拒绝点评这段内容，请换个回答再试");
  if (msg.stop_reason === "max_tokens") throw new AppError(502, "claude_truncated", "Claude 的点评太长被截断了，请再试一次");
  const out = msg.parsed_output;
  if (!out) throw new AppError(502, "claude_parse", "Claude 返回的格式不对，请再试一次");
  return { ...out, fc: half(out.fc), lr: half(out.lr), gra: half(out.gra), pron: half(out.pron) };
}

// ---------- Daily summary (Opus 5.5) ----------

export async function dailySummary(apiKey: string, digest: unknown, mock: boolean): Promise<{ summary: DailySummary; model: string }> {
  if (mock) return { summary: mockSummary(), model: "mock" };
  let msg;
  try {
    msg = await client(apiKey, 300_000).beta.messages.parse({
      model: SUMMARY_MODEL,
      max_tokens: 16000,
      // If Opus declines on a safety classifier, the API re-runs the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SUMMARY_SYSTEM,
      output_config: { effort: "medium", format: betaZodOutputFormat(SummarySchema) },
      messages: [{ role: "user", content: JSON.stringify(digest, null, 1) }],
    });
  } catch (e) {
    throw claudeError(e);
  }
  if (msg.stop_reason === "refusal") throw new AppError(502, "claude_refusal", "Claude 没有生成今天的总结（被安全规则拦下），请明天再试");
  if (msg.stop_reason === "max_tokens") throw new AppError(502, "claude_truncated", "总结太长被截断了，请再试一次");
  const out = msg.parsed_output;
  if (!out) throw new AppError(502, "claude_parse", "Claude 返回的格式不对，请再试一次");
  return { summary: out, model: msg.model };
}

// ---------- Local test doubles (MOCK=1) ----------

function mockFeedback(input: FeedbackInput): SpeakFeedback {
  return {
    fc: 5.5,
    lr: 5,
    gra: 5,
    pron: 5.5,
    overall_zh: `（测试数据）回答长度 ${Math.round(input.durationSec)} 秒，观点清楚；下一步多用连接词把理由展开。`,
    corrections: [{ original: "my mind is more clear", better: "my mind is clearer", why_zh: "clear 的比较级是 clearer" }],
    pron_tips: input.lowWords.slice(0, 2).map((w) => ({ word: w.word, tip_zh: "（测试）放慢速度，把词尾辅音读完整。" })),
    better_answer:
      "I'd say I'm definitely a morning person. My mind feels much clearer after a good night's sleep, so I usually do my reading before breakfast. In the evening I'm often too tired to focus.",
    phrases: [
      { en: "I'd say I'm definitely a morning person", zh: "我应该算是早起型的人" },
      { en: "my mind feels much clearer", zh: "头脑清醒得多" },
      { en: "too tired to focus", zh: "累得没法集中注意力" },
    ],
  };
}

function mockSummary(): DailySummary {
  return {
    summary_zh: "（测试数据）今天完成了跟读和一道口语题。",
    progress_zh: "（测试数据）跟读平均分比前几天高 3 分。",
    weak_points: [{ area: "发音", detail_zh: "th 的咬舌音还不稳定，例如 think、north。" }],
    tomorrow_plan: [
      { task_zh: "跟读：今日推荐句 6 句，每句读到 80 分以上", minutes: 15 },
      { task_zh: "口语：Part 1 两道题，各答两遍", minutes: 15 },
      { task_zh: "听力：新的 Section 1 练习", minutes: 15 },
    ],
    practice_sentences: [
      { text: "I think three of my friends prefer the north side of the city.", focus: "/θ/", tip_zh: "舌尖放在上下牙之间轻轻送气。" },
      { text: "Very few people would live in a village without a bus service.", focus: "/v/ /w/", tip_zh: "v 上齿碰下唇，w 圆唇不碰牙。" },
    ],
    listening: {
      title: "Hillside Gym - Membership Form",
      context_zh: "（测试数据）打电话办健身房会员",
      lines: [
        { speaker: "A", text: "Hillside Gym, how can I help?" },
        { speaker: "B", text: "Hi, I'd like to join. My name is Laura Benson, that's B-E-N-S-O-N." },
        { speaker: "A", text: "Thanks. Which plan would you like, monthly or yearly?" },
        { speaker: "B", text: "Monthly, please. And I'd like to start on the fourteenth. Sorry, the fifteenth." },
      ],
      questions: [
        { label: "Surname", answers: ["Benson"], hint_zh: "注意听拼写" },
        { label: "Plan", answers: ["monthly"], hint_zh: "yearly 是干扰项" },
        { label: "Start date", answers: ["15th", "fifteenth", "15"], hint_zh: "说话人改口了" },
      ],
    },
    encouragement_zh: "（测试数据）坚持每天练，进步会很明显。",
  };
}
