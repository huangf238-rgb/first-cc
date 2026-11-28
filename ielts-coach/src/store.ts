// One SQLite-backed Durable Object holds everything: the user's keys, settings and every practice record.

import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_SETTINGS,
  type AttemptRow,
  type AttemptType,
  type DailySummary,
  type Env,
  type Secrets,
  type Settings,
  type WordScore,
} from "./types";

const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "YYYY-MM-DD" of a timestamp in a time zone. */
export function dayOf(ts: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface SetupFields {
  passcode?: string;
  tencentAppId?: string;
  tencentSecretId?: string;
  tencentSecretKey?: string;
  anthropicKey?: string;
}

interface SoundStat {
  sound: string;
  avg: number;
  n: number;
  letters: string[];
  examples: string[];
}

interface WordStat {
  word: string;
  avg: number;
  n: number;
  last: number;
}

export class Store extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      day TEXT NOT NULL,
      type TEXT NOT NULL,
      item TEXT,
      ref TEXT,
      data TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS summaries (day TEXT PRIMARY KEY, ts INTEGER NOT NULL, model TEXT, source TEXT, data TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tts_cache (k TEXT PRIMARY KEY, ts INTEGER NOT NULL, audio BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS quota (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind))`);
  }

  // ---------- config ----------

  private conf(k: string): string | null {
    const rows = this.sql.exec(`SELECT v FROM config WHERE k = ?`, k).toArray();
    return rows.length ? String(rows[0].v) : null;
  }

  private setConf(k: string, v: string): void {
    this.sql.exec(`INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  isConfigured(): boolean {
    return !!(this.conf("pass_hash") && this.conf("tencent_appid") && this.conf("tencent_sid") && this.conf("tencent_skey"));
  }

  hasPasscode(): boolean {
    return !!this.conf("pass_hash");
  }

  async verifyPass(pass: string): Promise<boolean> {
    const salt = this.conf("pass_salt");
    const hash = this.conf("pass_hash");
    if (!salt || !hash || !pass) return false;
    return sameString(await sha256Hex(`${salt}:${pass}`), hash);
  }

  async saveSetup(f: SetupFields): Promise<void> {
    if (f.passcode) {
      const salt = crypto.randomUUID();
      this.setConf("pass_salt", salt);
      this.setConf("pass_hash", await sha256Hex(`${salt}:${f.passcode}`));
    }
    if (f.tencentAppId) this.setConf("tencent_appid", f.tencentAppId);
    if (f.tencentSecretId) this.setConf("tencent_sid", f.tencentSecretId);
    if (f.tencentSecretKey) this.setConf("tencent_skey", f.tencentSecretKey);
    if (f.anthropicKey) this.setConf("anthropic_key", f.anthropicKey);
  }

  secrets(): Secrets | null {
    const appId = this.conf("tencent_appid");
    const secretId = this.conf("tencent_sid");
    const secretKey = this.conf("tencent_skey");
    const anthropicKey = this.conf("anthropic_key") ?? "";
    if (!appId || !secretId || !secretKey) return null;
    return { tencent: { appId, secretId, secretKey }, anthropicKey };
  }

  /** What the settings page may show: never the full secrets. */
  maskedSecrets(): { tencentAppId: string; tencentSecretId: string; anthropicKey: string } {
    const tail = (s: string | null) => (s ? `…${s.slice(-4)}` : "");
    return {
      tencentAppId: this.conf("tencent_appid") ?? "",
      tencentSecretId: tail(this.conf("tencent_sid")),
      anthropicKey: tail(this.conf("anthropic_key")),
    };
  }

  settings(): Settings {
    const raw = this.conf("settings");
    let s: Partial<Settings> = {};
    try {
      s = raw ? JSON.parse(raw) : {};
    } catch {
      s = {};
    }
    return { ...DEFAULT_SETTINGS, ...s };
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings() };
    if (typeof patch.scoreCoeff === "number" && patch.scoreCoeff >= 1 && patch.scoreCoeff <= 4) next.scoreCoeff = patch.scoreCoeff;
    if (typeof patch.timezone === "string" && patch.timezone.length < 64) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: patch.timezone });
        next.timezone = patch.timezone;
      } catch {
        /* keep the old zone */
      }
    }
    this.setConf("settings", JSON.stringify(next));
    return next;
  }

  today(): string {
    return dayOf(Date.now(), this.settings().timezone);
  }

  /** Counts one use of `kind` today; false when the daily limit is reached. */
  takeQuota(kind: string, limit: number): boolean {
    const day = this.today();
    const rows = this.sql.exec(`SELECT n FROM quota WHERE day = ? AND kind = ?`, day, kind).toArray();
    const n = rows.length ? Number(rows[0].n) : 0;
    if (n >= limit) return false;
    this.sql.exec(`INSERT INTO quota (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`, day, kind);
    return true;
  }

  // ---------- synthesized speech cache ----------

  getTts(k: string): ArrayBuffer | null {
    const rows = this.sql.exec(`SELECT audio FROM tts_cache WHERE k = ?`, k).toArray();
    return rows.length ? (rows[0].audio as ArrayBuffer) : null;
  }

  putTts(k: string, audio: ArrayBuffer): void {
    this.sql.exec(`INSERT OR REPLACE INTO tts_cache (k, ts, audio) VALUES (?, ?, ?)`, k, Date.now(), audio);
  }

  // ---------- attempts ----------

  addAttempt(type: AttemptType, item: string | null, ref: string | null, data: unknown): { id: number; day: string } {
    const ts = Date.now();
    const day = dayOf(ts, this.settings().timezone);
    const row = this.sql
      .exec(`INSERT INTO attempts (ts, day, type, item, ref, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, ts, day, type, item, ref, JSON.stringify(data))
      .one();
    return { id: Number(row.id), day };
  }

  private attemptsSince(day: string): AttemptRow[] {
    return this.sql
      .exec(`SELECT id, ts, day, type, item, ref, data FROM attempts WHERE day >= ? ORDER BY ts`, day)
      .toArray()
      .map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts),
        day: String(r.day),
        type: String(r.type) as AttemptType,
        item: r.item == null ? null : String(r.item),
        ref: r.ref == null ? null : String(r.ref),
        data: safeParse(String(r.data)),
      }));
  }

  private practiceDays(): string[] {
    return this.sql
      .exec(`SELECT DISTINCT day FROM attempts ORDER BY day DESC LIMIT 400`)
      .toArray()
      .map((r) => String(r.day));
  }

  // ---------- aggregation ----------

  private soundAndWordStats(rows: AttemptRow[]): { sounds: SoundStat[]; words: WordStat[] } {
    const sounds = new Map<string, { sum: number; n: number; letters: Map<string, number>; examples: Set<string> }>();
    const words = new Map<string, { sum: number; n: number; last: number }>();
    const visit = (w: WordScore, countWord: boolean) => {
      const label = (w.ref || w.w || "").toLowerCase();
      if (countWord && label && w.s != null && w.tag !== 2) {
        const e = words.get(label) ?? { sum: 0, n: 0, last: 0 };
        e.sum += w.s;
        e.n += 1;
        e.last = w.s;
        words.set(label, e);
      }
      for (const p of w.ph ?? []) {
        if (p.s == null || !p.r) continue;
        const key = p.r.toLowerCase();
        const e = sounds.get(key) ?? { sum: 0, n: 0, letters: new Map(), examples: new Set() };
        e.sum += p.s;
        e.n += 1;
        if (p.l) e.letters.set(p.l.toLowerCase(), (e.letters.get(p.l.toLowerCase()) ?? 0) + 1);
        if (p.s < 70 && label && e.examples.size < 6) e.examples.add(label);
        sounds.set(key, e);
      }
    };
    for (const r of rows) {
      if ((r.type === "shadow" || r.type === "word") && Array.isArray(r.data?.words)) {
        for (const w of r.data.words) visit(w, true);
      } else if (r.type === "speak" && Array.isArray(r.data?.words)) {
        for (const w of r.data.words) visit(w, false);
      }
    }
    const soundList: SoundStat[] = [...sounds.entries()]
      .filter(([, e]) => e.n >= 3)
      .map(([sound, e]) => ({
        sound,
        avg: round1(e.sum / e.n),
        n: e.n,
        letters: [...e.letters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l),
        examples: [...e.examples],
      }))
      .sort((a, b) => a.avg - b.avg);
    const wordList: WordStat[] = [...words.entries()]
      .filter(([, e]) => e.n >= 2)
      .map(([word, e]) => ({ word, avg: round1(e.sum / e.n), n: e.n, last: e.last }))
      .sort((a, b) => a.avg - b.avg);
    return { sounds: soundList, words: wordList };
  }

  report() {
    const tz = this.settings().timezone;
    const today = dayOf(Date.now(), tz);
    const rows = this.attemptsSince(addDays(today, -29));

    const days = this.practiceDays();
    let streak = 0;
    let cursor = days[0] === today ? today : addDays(today, -1);
    const daySet = new Set(days);
    while (daySet.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }

    const series: { day: string; shadowAvg: number | null; shadowN: number; speakN: number; listenN: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(today, -i);
      const dayRows = rows.filter((r) => r.day === d);
      const sh = dayRows.filter((r) => (r.type === "shadow" || r.type === "word") && typeof r.data?.score === "number");
      const a = avg(sh.map((r) => r.data.score));
      series.push({
        day: d,
        shadowAvg: a == null ? null : round1(a),
        shadowN: sh.length,
        speakN: dayRows.filter((r) => r.type === "speak").length,
        listenN: dayRows.filter((r) => r.type === "listen").length,
      });
    }

    const totals = this.sql
      .exec(`SELECT type, COUNT(*) AS n FROM attempts GROUP BY type`)
      .toArray()
      .reduce((acc: Record<string, number>, r) => ((acc[String(r.type)] = Number(r.n)), acc), {});

    const speaking = rows
      .filter((r) => r.type === "speak" && r.data?.fb)
      .slice(-10)
      .reverse()
      .map((r) => ({
        ts: r.ts,
        part: r.data.part,
        question: r.data.question,
        fc: r.data.fb.fc,
        lr: r.data.fb.lr,
        gra: r.data.fb.gra,
        pron: r.data.fb.pron,
        engine: r.data.pron?.score ?? null,
      }));
    const listening = rows
      .filter((r) => r.type === "listen")
      .slice(-10)
      .reverse()
      .map((r) => ({ ts: r.ts, title: r.data?.title, score: r.data?.score, total: r.data?.total }));

    const { sounds, words } = this.soundAndWordStats(rows);
    const recent = rows
      .slice(-15)
      .reverse()
      .map((r) => ({
        ts: r.ts,
        type: r.type,
        ref: r.ref,
        score: r.type === "listen" ? `${r.data?.score}/${r.data?.total}` : r.type === "speak" ? r.data?.fb ? bandAvg(r.data.fb) : null : r.data?.score ?? null,
      }));

    return {
      today,
      streak,
      totals,
      todayCount: rows.filter((r) => r.day === today).length,
      series,
      speaking,
      listening,
      weakSounds: sounds.slice(0, 8),
      weakWords: words.slice(0, 12),
      recent,
      latestSummary: this.latestSummary(),
    };
  }

  /** Compact JSON the evening Opus call reads. */
  digest(day: string) {
    const rows = this.attemptsSince(addDays(day, -7));
    const todayRows = rows.filter((r) => r.day === day);
    const { sounds, words } = this.soundAndWordStats(rows);
    const lowWords = (ws: WordScore[] | undefined) =>
      (ws ?? [])
        .filter((w) => w.s != null && w.s < 70)
        .sort((a, b) => (a.s ?? 0) - (b.s ?? 0))
        .slice(0, 4)
        .map((w) => ({
          word: w.ref || w.w,
          score: w.s,
          weak_sounds: w.ph.filter((p) => p.s != null && p.s < 60).map((p) => `${p.r}(${p.l})`),
        }));

    const perDay = [];
    for (let i = 7; i >= 1; i--) {
      const d = addDays(day, -i);
      const dr = rows.filter((r) => r.day === d);
      const sh = dr.filter((r) => (r.type === "shadow" || r.type === "word") && typeof r.data?.score === "number");
      const sp = dr.filter((r) => r.type === "speak" && r.data?.fb);
      perDay.push({
        day: d,
        shadow_count: sh.length,
        shadow_avg: sh.length ? round1(avg(sh.map((r) => r.data.score))!) : null,
        speaking_count: sp.length,
        speaking_band_avg: sp.length ? round1(avg(sp.map((r) => bandAvg(r.data.fb)))!) : null,
        listening: dr.filter((r) => r.type === "listen").map((r) => `${r.data?.score}/${r.data?.total}`),
      });
    }

    const yesterday = this.summaryFor(addDays(day, -1));
    return {
      date: day,
      today: {
        shadowing: todayRows
          .filter((r) => r.type === "shadow" || r.type === "word")
          .slice(-40)
          .map((r) => ({ text: r.ref, score: r.data?.score ?? null, low_words: lowWords(r.data?.words) })),
        speaking: todayRows
          .filter((r) => r.type === "speak")
          .slice(-10)
          .map((r) => ({
            part: r.data?.part,
            question: r.data?.question,
            seconds: r.data?.durationSec,
            words_per_minute: r.data?.wpm,
            engine_scores: r.data?.pron,
            bands: r.data?.fb ? { fc: r.data.fb.fc, lr: r.data.fb.lr, gra: r.data.fb.gra, pron: r.data.fb.pron } : null,
            corrections: (r.data?.fb?.corrections ?? []).slice(0, 4).map((c: any) => `${c.original} -> ${c.better}`),
            transcript: String(r.data?.transcript ?? "").slice(0, 700),
          })),
        listening: todayRows
          .filter((r) => r.type === "listen")
          .map((r) => ({ title: r.data?.title, score: r.data?.score, total: r.data?.total, wrong: r.data?.wrong ?? [] })),
      },
      previous_7_days: perDay,
      weakest_sounds_8_days: sounds.slice(0, 8),
      weakest_words_8_days: words.slice(0, 10),
      yesterday_plan: yesterday?.summary.tomorrow_plan ?? null,
    };
  }

  // ---------- summaries ----------

  saveSummary(day: string, summary: DailySummary, model: string, source: string): void {
    this.sql.exec(
      `INSERT INTO summaries (day, ts, model, source, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET ts = excluded.ts, model = excluded.model, source = excluded.source, data = excluded.data`,
      day,
      Date.now(),
      model,
      source,
      JSON.stringify(summary),
    );
  }

  private toSummary(r: Record<string, SqlStorageValue>) {
    return { day: String(r.day), ts: Number(r.ts), model: String(r.model ?? ""), source: String(r.source ?? ""), summary: safeParse(String(r.data)) as DailySummary };
  }

  summaryFor(day: string) {
    const rows = this.sql.exec(`SELECT day, ts, model, source, data FROM summaries WHERE day = ?`, day).toArray();
    return rows.length ? this.toSummary(rows[0]) : null;
  }

  latestSummary() {
    const rows = this.sql.exec(`SELECT day, ts, model, source, data FROM summaries ORDER BY day DESC LIMIT 1`).toArray();
    return rows.length ? this.toSummary(rows[0]) : null;
  }

  listeningSets(limit = 10) {
    return this.sql
      .exec(`SELECT day, data FROM summaries ORDER BY day DESC LIMIT ?`, limit)
      .toArray()
      .map((r) => ({ day: String(r.day), set: (safeParse(String(r.data)) as DailySummary)?.listening }))
      .filter((x) => x.set && Array.isArray(x.set.lines) && x.set.lines.length > 0);
  }

  countToday(): number {
    const rows = this.sql.exec(`SELECT COUNT(*) AS n FROM attempts WHERE day = ?`, this.today()).toArray();
    return Number(rows[0]?.n ?? 0);
  }

  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      settings: this.settings(),
      attempts: this.attemptsSince("0000-00-00"),
      summaries: this.sql
        .exec(`SELECT day, ts, model, source, data FROM summaries ORDER BY day`)
        .toArray()
        .map((r) => this.toSummary(r)),
    };
  }
}

function bandAvg(fb: { fc: number; lr: number; gra: number; pron: number }): number {
  return round1((fb.fc + fb.lr + fb.gra + fb.pron) / 4);
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
