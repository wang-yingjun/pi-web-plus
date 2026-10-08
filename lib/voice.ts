// Pure helpers and shared types for the browser-native voice features.
// Everything here is environment-free so it can be unit tested without a
// browser: the hooks in hooks/useVoiceInput.ts and hooks/useVoiceOutput.ts own
// the actual Web Speech API wiring.

/** BCP-47 tags that the Web Speech API understands for the three UI locales. */
export const VOICE_LOCALES = ["en-US", "zh-CN", "zh-TW"] as const;
export type VoiceLocale = (typeof VOICE_LOCALES)[number];

/** localStorage keys, mirroring the existing `pi-sound-enabled` convention. */
export const VOICE_INPUT_ENABLED_KEY = "pi-voice-input-enabled";
export const VOICE_OUTPUT_ENABLED_KEY = "pi-voice-output-enabled";
// v2: auto-speak now follows the hands-free mode instead of persisting the
// value hands-free forced on. The old key may hold a stale `true`, so it is
// deliberately not read; the new key defaults to off.
export const VOICE_AUTO_SPEAK_KEY = "pi-voice-auto-speak-v2";
export const VOICE_RATE_KEY = "pi-voice-rate";
export const VOICE_INPUT_LOCALE_KEY = "pi-voice-input-locale";
export const VOICE_OUTPUT_VOICE_KEY = "pi-voice-output-voice";
export const VOICE_HANDS_FREE_KEY = "pi-voice-hands-free";
export const VOICE_NEURAL_KEY = "pi-voice-neural";

/**
 * Microsoft Edge neural voices (free via the Edge Read Aloud API), picked per
 * speech-recognition locale. Much more natural than system speechSynthesis
 * voices, especially for Chinese.
 */
export const EDGE_TTS_VOICES: Record<VoiceLocale, string> = {
  "zh-CN": "zh-CN-XiaoxiaoNeural",
  "zh-TW": "zh-TW-HsiaoChenNeural",
  "en-US": "en-US-AvaNeural",
};

/** Silence length (ms) after which hands-free dictation auto-sends. */
export const VOICE_HANDS_FREE_SILENCE_MS = 1100;

/**
 * Identity of a speech-synthesis voice. The Web Speech API's `voiceURI` is the
 * stable identifier; `name` is a readable fallback. Empty means "let the hook
 * auto-pick a voice for the detected language".
 */
export interface VoiceSelection {
  name: string;
  lang: string;
  voiceURI: string;
}

/** Read the persisted preferred voice, or null when none was chosen. */
export function readStoredVoiceSelection(): VoiceSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(VOICE_OUTPUT_VOICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoiceSelection>;
    if (!parsed || typeof parsed.name !== "string" || !parsed.name) return null;
    return {
      name: parsed.name,
      lang: typeof parsed.lang === "string" ? parsed.lang : "",
      voiceURI: typeof parsed.voiceURI === "string" ? parsed.voiceURI : "",
    };
  } catch {
    return null;
  }
}

/**
 * Find the persisted voice in the current voice list. Matches on voiceURI when
 * present (stable across renames), otherwise on name.
 */
export function resolveStoredVoice(
  voices: SpeechSynthesisVoice[],
  selection: VoiceSelection | null,
): SpeechSynthesisVoice | null {
  if (!selection || !voices.length) return null;
  if (selection.voiceURI) {
    const byUri = voices.find((voice) => voice.voiceURI === selection.voiceURI);
    if (byUri) return byUri;
  }
  return voices.find((voice) => voice.name === selection.name) ?? null;
}

/** Speech-recognition languages the UI exposes. */
export const VOICE_INPUT_LOCALES: ReadonlyArray<{ id: VoiceLocale; label: string }> = [
  { id: "zh-CN", label: "中文（简体）" },
  { id: "zh-TW", label: "中文（繁體）" },
  { id: "en-US", label: "English (US)" },
];

/**
 * Recognition defaults to Simplified Chinese regardless of the UI language,
 * because dictation is typically used with a Chinese-speaking model. Users can
 * still change it in settings.
 */
export const DEFAULT_VOICE_INPUT_LOCALE: VoiceLocale = "zh-CN";

/** Validate a stored/selected recognition locale, falling back to the default. */
export function normalizeVoiceInputLocale(value: unknown): VoiceLocale {
  return VOICE_LOCALES.includes(value as VoiceLocale) ? value as VoiceLocale : DEFAULT_VOICE_INPUT_LOCALE;
}

/** Read the persisted recognition language, defaulting to Simplified Chinese. */
export function readStoredVoiceInputLocale(): VoiceLocale {
  if (typeof window === "undefined") return DEFAULT_VOICE_INPUT_LOCALE;
  try {
    return normalizeVoiceInputLocale(window.localStorage.getItem(VOICE_INPUT_LOCALE_KEY));
  } catch {
    return DEFAULT_VOICE_INPUT_LOCALE;
  }
}

export const DEFAULT_VOICE_RATE = 1;
export const MIN_VOICE_RATE = 0.5;
export const MAX_VOICE_RATE = 2;

/**
 * Map an app locale (as used by lib/i18n) to a speech-recognition locale.
 * Falls back to en-US for anything that is not one of the built-in Chinese
 * locales, which matches resolveBrowserLocale()'s English default.
 */
export function voiceLocaleForAppLocale(appLocale: string): VoiceLocale {
  const normalized = appLocale.toLowerCase();
  if (normalized === "zh-tw" || normalized.startsWith("zh-tw-")
    || normalized === "zh-hk" || normalized.startsWith("zh-hk-")
    || normalized === "zh-mo" || normalized.startsWith("zh-mo-")
    || normalized === "zh-hant" || normalized.startsWith("zh-hant-")) {
    return "zh-TW";
  }
  if (normalized === "zh-cn" || normalized.startsWith("zh-cn-")
    || normalized === "zh" || normalized.startsWith("zh-")
    || normalized === "zh-sg" || normalized.startsWith("zh-sg-")
    || normalized === "zh-hans" || normalized.startsWith("zh-hans-")) {
    return "zh-CN";
  }
  return "en-US";
}

/**
 * Clamp and validate a stored/passed speech rate. Non-finite values and
 * out-of-range values fall back to the default so a corrupt localStorage entry
 * cannot make speech synthesis throw.
 */
export function normalizeVoiceRate(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_VOICE_RATE;
  if (parsed < MIN_VOICE_RATE) return MIN_VOICE_RATE;
  if (parsed > MAX_VOICE_RATE) return MAX_VOICE_RATE;
  return Math.round(parsed * 100) / 100;
}

/** Read a boolean toggle, defaulting when the key is absent or unreadable. */
export function readStoredToggle(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

/**
 * Join a finalized recognition transcript with the live interim transcript.
 * The Web Speech API reports them separately, and both can contain surrounding
 * whitespace, so callers normalize before inserting into the composer.
 */
export function composeTranscript(finalText: string, interimText: string): string {
  const final = finalText.replace(/\s+$/u, "");
  const interim = interimText.replace(/^\s+/u, "");
  if (!interim) return final;
  if (!final) return interim;
  // Chinese text has no inter-word spaces; insert one only between Latin runs.
  const needsSpace = /[A-Za-z0-9]$/u.test(final) && /^[A-Za-z0-9]/u.test(interim);
  return needsSpace ? `${final} ${interim}` : `${final}${interim}`;
}

/**
 * Append recognized speech to whatever the user already typed, keeping a
 * separating space when the existing text ends in a word character.
 */
export function appendTranscript(existing: string, transcript: string): string {
  const addition = transcript.trim();
  if (!addition) return existing;
  if (!existing) return addition;
  const needsSpace = /[A-Za-z0-9]$/u.test(existing) && /^[A-Za-z0-9]/u.test(addition);
  return needsSpace ? `${existing} ${addition}` : `${existing}${addition}`;
}

/**
 * Strip the parts of an assistant message that should never be read aloud:
 * fenced code blocks and inline code. Returns null when nothing speakable is
 * left, so the caller can skip speaking entirely.
 */
export function extractSpeakableText(markdown: string): string | null {
  if (!markdown) return null;
  const withoutFences = markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/~~~[\s\S]*?~~~/gu, " ");
  const withoutInline = withoutFences.replace(/`[^`\n]*`/gu, " ");
  const withoutLinks = withoutInline.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
  // URLs and file paths are read character by character ("v2", "slash"), so
  // drop them entirely; if they were the point of a sentence the link text (for
  // markdown links) or surrounding prose already carries the meaning.
  const withoutUrls = withoutLinks
    .replace(/\b(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(/\b[A-Za-z]:\\[^\s]+/gu, " ")
    .replace(/(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]+/gu, " ")
    .replace(/\b[\w.-]+\.[a-z]{2,4}\b(?:\/[\w.-]*)*/giu, " ");
  const withoutMarkers = withoutUrls
    .replace(/^[ \t]*#{1,6}[ \t]*/gmu, "")
    .replace(/^[ \t]*[-*+][ \t]+/gmu, "")
    .replace(/^[ \t]*>[ \t]?/gmu, "")
    .replace(/\|/gu, " ")
    .replace(/[*_~]{1,3}/gu, "");
  const collapsed = withoutMarkers
    .replace(/\s*\n\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length ? collapsed : null;
}

/**
 * Guess the speech locale from the text itself rather than the UI language.
 * An English voice reading Chinese characters produces exactly the kind of
 * gibberish the wrong-locale bug caused, so the text must win.
 *
 * Counts CJK characters: if a meaningful share of the text is Han, prefer the
 * matching Chinese locale; otherwise fall back to `fallback` (the UI locale).
 */
export function detectSpeechLocale(text: string, fallback: VoiceLocale = "zh-CN"): VoiceLocale {
  const han = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  // Chinese replies routinely embed English terms (npm, README, api), so the
  // presence of Han wins unless the passage is overwhelmingly Latin — which is
  // how an English sentence that merely quotes one Chinese word reads.
  const preferChinese = fallback === "zh-TW" ? "zh-TW" : "zh-CN";
  if (han >= 2 && han * 4 >= latin) return preferChinese;
  if (han > 0 && latin < 24) return preferChinese;
  return "en-US";
}

/**
 * Split long text into speech-sized chunks. SpeechSynthesis can silently drop
 * or truncate very long utterances on some engines, so callers enqueue several
 * short utterances instead of one huge one. Splits on sentence boundaries,
 * then on whitespace, then hard-cuts as a last resort.
 */
/**
 * Return the longest prefix of `text` that ends with a complete sentence
 * boundary (。！？…；\n, or .!? followed by whitespace/Chinese), or null while no
 * complete sentence has accumulated yet. Used to speak a reply sentence by
 * sentence while the agent is still generating it.
 */
export function firstCompleteSentences(text: string, minLength = 8): string | null {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    let boundary = false;
    if (ch === "\n" || ch === "。" || ch === "！" || ch === "？" || ch === "…" || ch === "；") {
      boundary = true;
    } else if (ch === "." || ch === "!" || ch === "?") {
      const next = text[i + 1];
      boundary = next === undefined || next === " " || /[\u4e00-\u9fff]/.test(next);
    }
    if (boundary && i + 1 >= minLength) {
      return text.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * Strip everything but letters/digits/Han so a recognition transcript can be
 * compared against the text currently being spoken (echo detection).
 */
export function normalizeForEcho(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Whether a recognition transcript captured while the assistant is speaking
 * is just the assistant's own voice picked up by the microphone. Compares the
 * normalized transcript against the normalized spoken text in both directions
 * so partial transcriptions of either side still match.
 */
export function isEchoSpeech(transcript: string, spoken: string): boolean {
  const t = normalizeForEcho(transcript);
  const s = normalizeForEcho(spoken);
  if (!s) return false;
  // Very short captures during playback are indistinguishable from echo and
  // are dropped to avoid the assistant interrupting itself.
  if (t.length < 4) return true;
  return s.includes(t) || t.includes(s.slice(0, Math.min(s.length, 24)));
}

export function splitForSpeech(text: string, maxLength = 220): string[] {
  const limit = Math.max(1, Math.floor(maxLength));
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  const chunks: string[] = [];
  const sentences = trimmed.match(/[^.!?。！？\n]+[.!?。！？]*\s*/gu) ?? [trimmed];
  let current = "";
  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      flush();
      let rest = sentence.trim();
      while (rest.length > limit) {
        let cut = rest.lastIndexOf(" ", limit);
        if (cut <= 0) cut = limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) current = rest;
      continue;
    }
    if ((current + sentence).trim().length > limit) flush();
    current += sentence;
  }
  flush();
  return chunks.filter((chunk) => chunk.length > 0);
}
