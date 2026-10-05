import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("assistant-reply voice playback defaults off", async () => {
  const source = await readFile(new URL("./useVoiceOutput.ts", import.meta.url), "utf8");

  // The master switch and the auto-speak toggle both start off, so a fresh
  // browser never reads assistant replies aloud until the user opts in.
  assert.match(source, /readStoredToggle\(VOICE_OUTPUT_ENABLED_KEY, false\)/);
  assert.match(source, /readStoredToggle\(VOICE_AUTO_SPEAK_KEY, false\)/);
  assert.doesNotMatch(source, /readStoredToggle\(VOICE_AUTO_SPEAK_KEY, true\)/);
});
