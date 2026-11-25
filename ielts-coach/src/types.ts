import type { Store } from "./store";

export interface Env {
  STORE: DurableObjectNamespace<Store>;
  ASSETS: Fetcher;
  /** One-time code needed to run first setup (set with `wrangler secret put SETUP_CODE`). */
  SETUP_CODE?: string;
  /** "1" = fake Tencent and Claude replies, for local testing only. */
  MOCK?: string;
}

export interface TencentCreds {
  appId: string;
  secretId: string;
  secretKey: string;
}

export interface Secrets {
  tencent: TencentCreds;
  anthropicKey: string;
}

export interface Settings {
  /** Tencent score_coeff, 1.0 (lenient, children) .. 4.0 (strict, adults). */
  scoreCoeff: number;
  /** IANA time zone used to decide which day a practice belongs to. */
  timezone: string;
}

export const DEFAULT_SETTINGS: Settings = { scoreCoeff: 3.0, timezone: "Africa/Cairo" };

/** One phone (sound) inside a word, compacted from Tencent's PhoneInfos. */
export interface PhoneScore {
  /** Letters of the word that spell this sound (ReferenceLetter). */
  l: string;
  /** Expected phone (ReferencePhone). */
  r: string;
  /** Phone the engine heard (Phone). */
  p: string;
  /** 0-100, or null when the engine gave no score. */
  s: number | null;
  /** 1 when this phone should carry stress. */
  st?: 1;
  /** 1 when the learner stressed it. */
  ds?: 1;
  tag: number;
}

/** One word, compacted from Tencent's Words. tag: 0 ok, 1 extra, 2 missed, 3 misread, 4 not in dictionary. */
export interface WordScore {
  w: string;
  ref: string;
  s: number | null;
  tag: number;
  ph: PhoneScore[];
  /** Begin/end in ms inside the audio segment. */
  b?: number;
  e?: number;
}

export interface Assessment {
  /** Tencent SuggestedScore, 0-100. */
  score: number | null;
  /** Pronunciation accuracy, 0-100. */
  accuracy: number | null;
  /** Fluency, converted to 0-100. */
  fluency: number | null;
  /** Completeness, converted to 0-100. */
  completion: number | null;
  words: WordScore[];
  transcript: string;
}

export type AttemptType = "shadow" | "word" | "speak" | "listen";

export interface AttemptRow {
  id: number;
  ts: number;
  day: string;
  type: AttemptType;
  item: string | null;
  ref: string | null;
  data: any;
}

export interface SpeakFeedback {
  fc: number;
  lr: number;
  gra: number;
  pron: number;
  overall_zh: string;
  corrections: { original: string; better: string; why_zh: string }[];
  pron_tips: { word: string; tip_zh: string }[];
  better_answer: string;
  phrases: { en: string; zh: string }[];
}

export interface DailySummary {
  summary_zh: string;
  progress_zh: string;
  weak_points: { area: string; detail_zh: string }[];
  tomorrow_plan: { task_zh: string; minutes: number }[];
  practice_sentences: { text: string; focus: string; tip_zh: string }[];
  listening: {
    title: string;
    context_zh: string;
    lines: { speaker: "A" | "B"; text: string }[];
    questions: { label: string; answers: string[]; hint_zh: string }[];
  };
  encouragement_zh: string;
}

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
