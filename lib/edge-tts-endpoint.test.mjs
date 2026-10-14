import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { buildEdgeTtsSynthUrl, installEdgeTtsSynthUrl, EDGE_TTS_SYNTH_BASE, EDGE_TTS_SEC_MS_GEC_VERSION } =
  await jiti.import("./edge-tts-endpoint.ts");
const { MsEdgeTTS } = await jiti.import("msedge-tts");

test("buildEdgeTtsSynthUrl carries the v2 token on the proven host", () => {
  const url = buildEdgeTtsSynthUrl({ secMsGec: "ABC-DEF", connectionId: "CID" });
  assert.ok(url.startsWith(`${EDGE_TTS_SYNTH_BASE}?`));
  assert.ok(url.includes("TrustedClientToken="));
  assert.ok(url.includes("&Sec-MS-GEC=ABC-DEF"));
  assert.ok(url.includes(`&Sec-MS-GEC-Version=${EDGE_TTS_SEC_MS_GEC_VERSION}`));
  assert.ok(url.includes("&ConnectionId=CID"));
  // The version prefix is what the service checks alongside the token format.
  assert.ok(EDGE_TTS_SEC_MS_GEC_VERSION.startsWith("2-"));
});

test("installEdgeTtsSynthUrl rewires MsEdgeTTS to emit a v2 token", async () => {
  installEdgeTtsSynthUrl();
  const url = await MsEdgeTTS.getSynthUrl();
  assert.ok(url.startsWith(`${EDGE_TTS_SYNTH_BASE}?`));
  assert.match(url, /Sec-MS-GEC-Version=2-/);
  assert.match(url, /Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/);
});
