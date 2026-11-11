// dsh-donkey-mill — host half.
//
// Listens to the live `agent/assistant-stream` frames, keeps an
// EMA-smoothed token throughput per in-flight attempt, and serves the
// result to the Web UI over a small exact route the client plugin polls.
// The client never sees the stream itself — only the smoothed rate.

// Row config is validated by the Cordis Loader through the native Schemastery
// graph protocol (Config["~standard"].validate at activation, and the inspect
// projector walks the same graph). This module ships a small hand-built native
// schema for the six row fields so the bundle needs no runtime dependencies.

const kSchema = Symbol.for('schemastery');

const POSITIONS = ['bottom-left', 'bottom-right', 'bottom-center', 'center'];
const MODES = ['animated', 'text'];

function field(type, meta, extra) {
  const node = { [kSchema]: true, type, meta };
  if (extra) Object.assign(node, extra);
  return node;
}

function configError(path, message) {
  const error = new TypeError(message);
  error.path = path;
  return error;
}

function validateField(value, field, path) {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') throw configError(path, `expected boolean but got ${JSON.stringify(value)}`);
    return value;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw configError(path, `expected number but got ${JSON.stringify(value)}`);
    }
    if (field.meta.min != null && value < field.meta.min) {
      throw configError(path, `expected number >= ${field.meta.min} but got ${value}`);
    }
    if (field.meta.max != null && value > field.meta.max) {
      throw configError(path, `expected number <= ${field.meta.max} but got ${value}`);
    }
    return value;
  }
  if (field.type === 'union') {
    for (const inner of field.list) {
      if (inner.type === 'const' && Object.is(value, inner.value)) return inner.value;
    }
    const allowed = field.list.map((inner) => JSON.stringify(inner.value)).join(', ');
    throw configError(path, `expected one of ${allowed} but got ${JSON.stringify(value)}`);
  }
  throw configError(path, `unsupported field type ${field.type}`);
}

function validateConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw configError([], 'config must be a plain object');
  }
  const value = {};
  for (const [key, field] of Object.entries(Config.dict)) {
    value[key] = input[key] === undefined ? field.meta.default : validateField(input[key], field, [key]);
  }
  // Extra keys pass through, matching native object resolver semantics.
  for (const key of Object.keys(input)) {
    if (!(key in Config.dict)) value[key] = input[key];
  }
  return value;
}

export const Config = {
  [kSchema]: true,
  type: 'object',
  meta: { default: {} },
  dict: {
    enabled: field('boolean', { default: true, description: 'Turn the donkey mill background on or off.' }),
    mode: field('union', {
      default: 'animated',
      description: 'Rendering form: "animated" top-down donkey scene, or static "text" Chinese-character scene (no animation).'
    }, {
      list: MODES.map((value) => field('const', {}, { value }))
    }),
    position: field('union', { default: 'bottom-right', description: 'Legacy screen corner; accepted but ignored (scene is viewport-centered).' }, {
      list: POSITIONS.map((value) => field('const', {}, { value }))
    }),
    size: field('number', { default: 380, min: 160, max: 720, description: 'Scene width in pixels.' }),
    opacity: field('number', { default: 0.55, min: 0.05, max: 1, description: 'Overall scene opacity.' }),
    showReadout: field('boolean', { default: true, description: 'Show the tok/s readout under the scene.' })
  },
  '~standard': {
    version: 1,
    vendor: 'donkey-mill',
    validate: (raw) => {
      try {
        return { value: validateConfig(raw) };
      } catch (error) {
        return { issues: [{ message: error.message, path: error.path || [] }] };
      }
    }
  }
};

export const inject = ['webServer'];

const EMA_TAU = 0.45; // seconds — smoothing for per-chunk instantaneous rates
const IDLE_TAU = 1.1; // seconds — decay after the last stream has ended
const PAUSE_TAU = 3.0; // seconds — decay during mid-stream stalls
const PAUSE_GRACE = 0.4; // seconds of silence that still count as live
const MIN_DT = 0.25; // ignore inter-chunk gaps shorter than this
const MAX_DT = 2.0; // ignore inter-chunk gaps longer than this (stalls)
const RATE_CAP = 2000; // tok/s sanity cap
const STALE_MS = 60000; // prune attempts idle for a full minute

function freshAttempt() {
  return {
    startedAt: 0,
    lastAt: 0,
    lastTokens: 0,
    cjk: 0,
    other: 0,
    toolChars: 0,
    usageTokens: 0,
    ema: 0
  };
}

export function apply(ctx, _config) {
  const attempts = new Map();
  let endedRate = 0;
  let lastActivityAt = 0;

  const isCJK = (code) =>
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff);

  const countText = (text) => {
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      if (isCJK(ch.codePointAt(0))) cjk += 1;
      else other += 1;
    }
    return { cjk, other };
  };

  // Cheap estimate until the authoritative usage frame arrives.
  const estimateTokens = (a) => a.cjk * 0.7 + a.other / 3.5 + a.toolChars / 3.5;

  const onFrame = (payload) => {
    if (!payload || !payload.frame || !payload.agent) return;
    const frame = payload.frame;
    if (typeof frame !== 'object' || typeof frame.attemptId !== 'string') return;
    const agentId = payload.agent && payload.agent.id != null ? payload.agent.id : payload.agent;
    const key = String(agentId) + ':' + frame.attemptId;

    if (frame.type === 'start') {
      if (!attempts.has(key)) attempts.set(key, freshAttempt());
      return;
    }

    if (frame.type === 'end') {
      const a = attempts.get(key);
      if (a) {
        if (a.ema > endedRate) endedRate = a.ema;
        attempts.delete(key);
      }
      return;
    }

    if (frame.type !== 'chunk' || !frame.chunk) return;

    const now = Date.now();
    let a = attempts.get(key);
    if (!a) {
      a = freshAttempt();
      attempts.set(key, a);
    }

    const chunk = frame.chunk;
    if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage.outputTokens === 'number') {
      a.usageTokens = chunk.usage.outputTokens;
    } else if (
      (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') &&
      typeof chunk.text === 'string'
    ) {
      const t = countText(chunk.text);
      a.cjk += t.cjk;
      a.other += t.other;
    } else if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
      a.toolChars += chunk.argumentsDelta.length;
    } else {
      return; // unknown chunk type — leave timing untouched
    }

    const cumulative = a.usageTokens > 0 ? a.usageTokens : estimateTokens(a);
    if (a.startedAt === 0) a.startedAt = now; // TTFT excluded
    lastActivityAt = now;

    if (a.lastAt > 0) {
      const dt = (now - a.lastAt) / 1000;
      if (dt >= MIN_DT && dt <= MAX_DT) {
        const delta = cumulative - a.lastTokens;
        if (delta > 0) {
          const rate = delta / dt;
          if (rate <= RATE_CAP) {
            const alpha = 1 - Math.exp(-dt / EMA_TAU);
            a.ema += alpha * (rate - a.ema);
          }
        }
      }
    }
    a.lastAt = now;
    a.lastTokens = cumulative;
  };

  const readRate = () => {
    const now = Date.now();
    for (const [key, a] of attempts) {
      if (now - a.lastAt > STALE_MS) {
        if (a.ema > endedRate) endedRate = a.ema;
        attempts.delete(key);
      }
    }

    let rate;
    if (attempts.size > 0) {
      let best = 0;
      for (const a of attempts.values()) if (a.ema > best) best = a.ema;
      rate = best;
      if (lastActivityAt > 0) {
        const idle = (now - lastActivityAt) / 1000;
        if (idle > PAUSE_GRACE) rate = best * Math.exp(-(idle - PAUSE_GRACE) / 1000 / PAUSE_TAU);
      }
    } else if (lastActivityAt > 0) {
      rate = endedRate * Math.exp(-(now - lastActivityAt) / 1000 / IDLE_TAU);
    } else {
      rate = 0;
    }

    if (rate < 0.05) return 0;
    return Math.round(rate * 10) / 10;
  };

  const offFrame = ctx.on('agent/assistant-stream', onFrame) || (() => {});
  const disposeRoute =
    ctx.webServer.register({
      kind: 'exact',
      path: '/api/donkey-mill/rate',
      handler: (_req, res) => {
        const body = JSON.stringify({ rate: readRate(), active: attempts.size > 0 });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      }
    }) || (() => {});

  return () => {
    offFrame();
    disposeRoute();
    attempts.clear();
  };
}
