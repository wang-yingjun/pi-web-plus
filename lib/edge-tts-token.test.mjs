import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { generateSecMsGecV2 } = await jiti.import("./edge-tts-token.ts");

// Reference values produced by edge_tts.drm.generate_sec_ms_gec_v2(ts) from
// https://github.com/rany2/edge-tts — pinned so a port regression is caught.
const REFERENCE = {
  0: "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
  1234567890: "BA405D1577B8E0CE-61F01E88539977A1A1E969572D82EECFA45FB1E5DEBD122D6ACBAF0054F959E5",
  1700000000: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
  1760000000: "6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D",
  1760400000: "F3E7AA1D0E82AD85-0BB8E511444B3FA2EB3371B2B4255C4F9F702AB439E6F4F4055E708AB81FF422",
  1760427000: "6201EC61900093A7-A71F2C75E84B616C2E3006738E0A3914D5C5B25C3C4E511E9ABBDE4E5ACA82BD",
};

test("generateSecMsGecV2 matches the reference implementation", () => {
  for (const [timestamp, expected] of Object.entries(REFERENCE)) {
    assert.equal(generateSecMsGecV2(Number(timestamp)), expected, `timestamp ${timestamp}`);
  }
});

test("generateSecMsGecV2 uses the <16 hex>-<64 hex> v2 format", () => {
  const token = generateSecMsGecV2(1760400000);
  assert.match(token, /^[0-9A-F]{16}-[0-9A-F]{64}$/);
});

test("generateSecMsGecV2 is stable within a five-minute window", () => {
  const base = 1760427000;
  assert.equal(generateSecMsGecV2(base), generateSecMsGecV2(base + 299));
  assert.notEqual(generateSecMsGecV2(base), generateSecMsGecV2(base + 300));
});
