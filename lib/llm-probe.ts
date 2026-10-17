// @ts-nocheck
// Recovered from Next dev build cache on 2026-10-17.

import * as compat from "@earendil-works/pi-ai/compat";
import * as pi_coding_agent from "@earendil-works/pi-coding-agent";
import * as model_scope from "@/lib/model-scope";
import * as project_trust from "@/lib/project-trust";
const DEFAULT_PROBE_TIMEOUT_MS = 45_000;
const DEFAULT_PROBE_RETRIES = 2;
const DEFAULT_PROBE_CONCURRENCY = 4;
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function extractStatusFromMessage(message) {
  const patterns = [/^\s*(\d{3})\b/, /HTTP\s+(\d{3})/i, /"code"\s*:\s*(\d{3})\b/];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const code = Number(match[1]);
      if (code >= 100 && code <= 599) return code;
    }
  }
  return undefined;
}
function classifyProbeError(status, message) {
  const code = status ?? extractStatusFromMessage(message);
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "quota";
  if (code !== undefined && code >= 500) return "server";
  if (code !== undefined) return "unknown";
  const text = message.toLowerCase();
  if (text.includes("connection error") || text.includes("fetch failed") || text.includes("econnreset") || text.includes("econnrefused") || text.includes("etimedout") || text.includes("enotfound") || text.includes("socket") || text.includes("network")) {
    return "network";
  }
  if (text.includes("abort") || text.includes("timed out") || text.includes("timeout")) {
    return "network";
  }
  return "unknown";
}
function isRetryable(kind) {
  // Network blips and provider hiccups are worth retrying; bad keys and quota
  // limits are not — retrying only makes the user wait.
  return kind === "network" || kind === "server";
}
async function listProbeTargets(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = (0, pi_coding_agent["getAgentDir"])();
  const trustReloadOptions = (0, project_trust["projectTrustReloadOptions"])(cwd, agentDir);
  const services = await (0, pi_coding_agent["createAgentSessionServices"])({
    cwd,
    agentDir,
    ...(trustReloadOptions ? {
      resourceLoaderReloadOptions: trustReloadOptions
    } : {})
  });
  const modelRuntime = services.modelRuntime;
  let models;
  if (options.scope === "all") {
    models = await modelRuntime.getAvailable();
  } else {
    const scope = await (0, model_scope["resolveVisibleModels"])(modelRuntime, services.settingsManager.getEnabledModels());
    models = scope.visible;
  }
  const filtered = options.provider ? models.filter(model => model.provider === options.provider) : models;
  const targets = filtered.map(model => ({
    model,
    target: {
      provider: model.provider,
      model: model.id,
      name: model.name || model.id
    }
  }));
  return {
    modelRuntime,
    targets
  };
}
async function probeModel(modelRuntime, model, options = {}) {
  const {
    provider,
    id
  } = model;
  const target = {
    provider,
    model: id,
    name: model.name || id
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_PROBE_RETRIES;
  let resolved;
  try {
    resolved = await modelRuntime.getAuth(model);
  } catch (error) {
    return {
      ...target,
      ok: false,
      latencyMs: 0,
      attempts: 1,
      errorKind: "auth",
      error: error instanceof Error ? error.message : String(error)
    };
  }
  if (!resolved?.auth?.apiKey) {
    return {
      ...target,
      ok: false,
      latencyMs: 0,
      attempts: 1,
      errorKind: "auth",
      error: `No API key configured for "${provider}"`
    };
  }
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let status;
    try {
      const message = await (0, compat["completeSimple"])(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now()
        }]
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: 16,
        timeoutMs,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
        onResponse: response => {
          status = response.status;
        }
      });
      const latencyMs = Date.now() - startedAt;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        const error = message.errorMessage ?? (controller.signal.aborted ? "Probe timed out" : "Model returned an error");
        const code = status ?? extractStatusFromMessage(error);
        const errorKind = classifyProbeError(code, error);
        last = {
          ...target,
          ok: false,
          ...(code !== undefined ? {
            status: code
          } : {}),
          latencyMs,
          attempts: attempt + 1,
          errorKind,
          error
        };
        if (!isRetryable(errorKind)) break;
      } else {
        last = {
          ...target,
          ok: true,
          ...(status !== undefined ? {
            status
          } : {}),
          latencyMs,
          attempts: attempt + 1,
          errorKind: "ok"
        };
        break;
      }
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const text = error instanceof Error ? error.message : String(error);
      const errorKind = classifyProbeError(status, text);
      last = {
        ...target,
        ok: false,
        ...(status !== undefined ? {
          status
        } : {}),
        latencyMs,
        attempts: attempt + 1,
        errorKind,
        error: text
      };
      if (!isRetryable(errorKind)) break;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(400 * (attempt + 1));
  }
  return last;
}
async function streamProbe(options, handlers = {}) {
  const {
    modelRuntime,
    targets
  } = await listProbeTargets(options);
  handlers.onStart?.(targets.map(entry => entry.target));
  const results = new Array(targets.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(options.concurrency ?? DEFAULT_PROBE_CONCURRENCY, targets.length || 1));
  async function worker() {
    while (cursor < targets.length) {
      const index = cursor++;
      const result = await probeModel(modelRuntime, targets[index].model, options);
      results[index] = result;
      handlers.onResult?.(result);
    }
  }
  await Promise.all(Array.from({
    length: Math.min(limit, targets.length)
  }, worker));
  return results;
}
export { DEFAULT_PROBE_CONCURRENCY, DEFAULT_PROBE_RETRIES, DEFAULT_PROBE_TIMEOUT_MS, classifyProbeError, extractStatusFromMessage, listProbeTargets, probeModel, streamProbe };