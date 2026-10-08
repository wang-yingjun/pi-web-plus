import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  appendTranscript,
  composeTranscript,
  detectSpeechLocale,
  DEFAULT_VOICE_INPUT_LOCALE,
  DEFAULT_VOICE_RATE,
  extractSpeakableText,
  MAX_VOICE_RATE,
  MIN_VOICE_RATE,
  normalizeVoiceInputLocale,
  normalizeVoiceRate,
  resolveStoredVoice,
  splitForSpeech,
  VOICE_INPUT_LOCALES,
  voiceLocaleForAppLocale,
} = await createJiti(import.meta.url).import("./voice.ts");

test("resolveStoredVoice matches by voiceURI then name, else null", () => {
  const voices = [
    { name: "Tingting", lang: "zh-CN", voiceURI: "com.apple.tingting", localService: true },
    { name: "Meijia", lang: "zh-TW", voiceURI: "com.apple.meijia", localService: true },
  ];
  // voiceURI is the stable identifier and wins.
  assert.equal(resolveStoredVoice(voices, { name: "old", lang: "zh-CN", voiceURI: "com.apple.meijia" })?.name, "Meijia");
  // Falls back to name when the URI changed.
  assert.equal(resolveStoredVoice(voices, { name: "Tingting", lang: "zh-CN", voiceURI: "stale" })?.name, "Tingting");
  // Nothing matches -> null so the caller auto-picks.
  assert.equal(resolveStoredVoice(voices, { name: "Nope", lang: "zh-CN", voiceURI: "nope" }), null);
  assert.equal(resolveStoredVoice(voices, null), null);
});

test("recognition defaults to Simplified Chinese", () => {
  assert.equal(DEFAULT_VOICE_INPUT_LOCALE, "zh-CN");
  // The exposed list starts with Simplified Chinese so it is the first option.
  assert.equal(VOICE_INPUT_LOCALES[0].id, "zh-CN");
});

test("normalizeVoiceInputLocale accepts known tags and defaults otherwise", () => {
  assert.equal(normalizeVoiceInputLocale("zh-TW"), "zh-TW");
  assert.equal(normalizeVoiceInputLocale("en-US"), "en-US");
  assert.equal(normalizeVoiceInputLocale("fr-FR"), "zh-CN");
  assert.equal(normalizeVoiceInputLocale(null), "zh-CN");
  assert.equal(normalizeVoiceInputLocale(undefined), "zh-CN");
});

test("voiceLocaleForAppLocale maps the three UI locales", () => {
  assert.equal(voiceLocaleForAppLocale("en"), "en-US");
  assert.equal(voiceLocaleForAppLocale("zh-CN"), "zh-CN");
  assert.equal(voiceLocaleForAppLocale("zh-TW"), "zh-TW");
  // Region and script variants collapse onto the built-in locales.
  assert.equal(voiceLocaleForAppLocale("zh-Hans"), "zh-CN");
  assert.equal(voiceLocaleForAppLocale("zh-HK"), "zh-TW");
  assert.equal(voiceLocaleForAppLocale("fr"), "en-US");
});

test("normalizeVoiceRate clamps and defaults invalid input", () => {
  assert.equal(normalizeVoiceRate(1.25), 1.25);
  assert.equal(normalizeVoiceRate(0.1), MIN_VOICE_RATE);
  assert.equal(normalizeVoiceRate(9), MAX_VOICE_RATE);
  assert.equal(normalizeVoiceRate("nonsense"), DEFAULT_VOICE_RATE);
  assert.equal(normalizeVoiceRate(Number.NaN), DEFAULT_VOICE_RATE);
  // Rounds to two decimals so a range slider cannot create float noise.
  assert.equal(normalizeVoiceRate(1.234), 1.23);
});

test("composeTranscript joins final and interim without doubling spaces", () => {
  assert.equal(composeTranscript("hello", "world"), "hello world");
  assert.equal(composeTranscript("hello ", " world"), "hello world");
  assert.equal(composeTranscript("", "world"), "world");
  assert.equal(composeTranscript("hello", ""), "hello");
  // Chinese runs are concatenated without a space.
  assert.equal(composeTranscript("你好", "世界"), "你好世界");
});

test("appendTranscript preserves existing composer text", () => {
  assert.equal(appendTranscript("", "hello"), "hello");
  assert.equal(appendTranscript("hello", "world"), "hello world");
  assert.equal(appendTranscript("hello ", "world"), "hello world");
  assert.equal(appendTranscript("看", "这个"), "看这个");
  // Whitespace-only additions are ignored.
  assert.equal(appendTranscript("hello", "   "), "hello");
});

test("extractSpeakableText strips code and markup, keeps prose", () => {
  assert.equal(extractSpeakableText("Hello **world**"), "Hello world");
  assert.equal(
    extractSpeakableText("Read this:\n```js\nconst x = 1;\n```\nDone"),
    "Read this: Done",
  );
  assert.equal(extractSpeakableText("Use `npm install` now"), "Use now");
  assert.equal(extractSpeakableText("- one\n- two"), "one two");
  assert.equal(extractSpeakableText("# Heading\nSee [docs](https://x.y)"), "Heading See docs");
  assert.equal(extractSpeakableText("```\nonly code\n```"), null);
  assert.equal(extractSpeakableText(""), null);
});

test("detectSpeechLocale follows the text, not the UI locale", () => {
  // Chinese prose wins even when it embeds English terms — the mixed case that
  // previously picked an English voice and read the Chinese as gibberish.
  assert.equal(detectSpeechLocale("运行 npm run dev 即可。"), "zh-CN");
  assert.equal(detectSpeechLocale("这是一个很长的中文回复，里面提到 npm、README、api。"), "zh-CN");
  assert.equal(detectSpeechLocale("好的"), "zh-CN");
  // English text stays English even with a stray CJK word.
  assert.equal(detectSpeechLocale("The file is at /usr/local and v2.0.1 works."), "en-US");
  assert.equal(detectSpeechLocale("Here is a summary."), "en-US");
  // The fallback selects which Chinese variant, not whether Chinese is used.
  assert.equal(detectSpeechLocale("你好世界", "zh-TW"), "zh-TW");
});

test("extractSpeakableText drops URLs and paths that read as gibberish", () => {
  const out = extractSpeakableText(
    "改好了。详见 https://example.com/docs/v2/api，文件在 /usr/local/bin/node。",
  );
  assert.ok(out && !out.includes("http"));
  assert.ok(out && !out.includes("/usr/local"));
  assert.match(out, /改好了/);
});

test("splitForSpeech chunks long text on sentence and word boundaries", () => {
  assert.deepEqual(splitForSpeech("Hello world."), ["Hello world."]);
  assert.deepEqual(splitForSpeech(""), []);
  assert.deepEqual(splitForSpeech("   "), []);

  const long = `${"word ".repeat(80)}end`;
  const chunks = splitForSpeech(long, 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 50, `chunk too long: ${chunk.length}`);
  // No text is lost when chunking.
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), long.replace(/\s+/g, " ").trim());
});

test("splitForSpeech hard-cuts a single unbreakable run", () => {
  const chunks = splitForSpeech("x".repeat(500), 100);
  assert.equal(chunks.join(""), "x".repeat(500));
  assert.ok(chunks.every((chunk) => chunk.length <= 100));
});
