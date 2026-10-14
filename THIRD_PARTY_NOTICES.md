# Third-party notices

pi-web is licensed MIT (see `LICENSE`), except the file listed below, which is
included under its own license and remains independently replaceable.

## lib/edge-tts-token.ts

- **Source:** port of `edge_tts/drm.py` from
  [rany2/edge-tts](https://github.com/rany2/edge-tts)
- **License:** LGPL-3.0-or-later (`SPDX-License-Identifier: LGPL-3.0-or-later`)
- **Upstream copyright:** Copyright (C) rany and edge-tts contributors
- **What it does:** generates the v2 `Sec-MS-GEC` token
  (`"<cs64>-<sha256>"` format) required by Microsoft's Edge "Read Aloud"
  speech endpoint. The `msedge-tts` package this project depends on still
  emits the legacy v1 single-hash token, which the service rejects with
  HTTP 403; without this module every synthesis fails and the UI silently
  falls back to the browser's built-in voices.
- **Why it is not MIT like the rest of pi-web:** it is a port of LGPL-3.0
  code, so it keeps that license. LGPL-3.0 permits this kind of use in an
  otherwise MIT-licensed work as long as the file's license and origin are
  identified (done here and in the file header) and the source remains
  available (satisfied by this public repository).
- **How to replace it:** the token generator is only reached through
  `installEdgeTtsSynthUrl()` in `lib/edge-tts-endpoint.ts`, which overrides
  `MsEdgeTTS.getSynthUrl()`. Swapping in an upstream implementation of the v2
  token (or pointing `EDGE_TTS_SYNTH_BASE` at an endpoint that accepts the
  legacy v1 token) requires deleting this file and that one override — no
  other code depends on it. Tests pinning the behaviour live in
  `lib/edge-tts-token.test.mjs`.
