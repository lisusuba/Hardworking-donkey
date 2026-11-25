// dsh-donkey-mill — web client half.
//
// Full-viewport background watermark on the `shell.overlay` slot (the app
// columns are opaque, so a true z-order background would be invisible).
//
// Two forms, switchable LIVE from the plugin's own on-screen control panel:
//   text     — Chinese characters 磨 (mill center) + 驴 (orbit).
//   animated — top-down cartoon donkey drawing walking the same circle.
//
// BOTH forms are animated by the SAME motion clock (useMillClock): one eased
// tok/s rate, an idle plod floor, and one orbital angle theta. 驴 / the donkey
// orbit at theta, 磨 / the millstone rotate 1:1 with theta, and the pole
// follows. Live tok/s only accelerates the plod; it never freezes it.
//
// The panel also has an opacity slider. All settings persist in localStorage
// and live in client state, so they survive reloads, need no host Config (the
// client fiber is created WITHOUT config — `loader.create({name})`), and need
// no host restart or patch edit. Switching only re-renders DonkeyRoot itself.

window.__ModuleLoader__.load({
  id: 'dsh-donkey-mill',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const STORE_KEY = 'donkey-mill-settings-v1';
    const DEFAULTS = { mode: 'text', opacity: 0.55, enabled: true };

    const RATE_URL = '/api/donkey-mill/rate';
    const POLL_MS = 300;
    const FULL_SPEED_TPS = 120; // tok/s at which the donkey gallops flat out
    const ORBIT_RAD_S = 1.5; // extra angular speed at full tok/s
    const IDLE_ORBIT_RAD_S = 0.35; // slow plod while the model has recently streamed
    const GAIT_FACTOR = 2.4;
    const EASE_TAU = 0.35;
    // Short bridge so the donkey keeps a slow plod across the quiet gaps that
    // are part of ONE turn (tool execution, reasoning/thinking, inter-attempt
    // lulls) but DOES stop once no tokens have arrived for this whole window —
    // i.e. every session has truly finished.
    const PLOD_BRIDGE_MS = 4000;

    const CX = 500;
    const CY = 500;
    const R = 380;
    const MILL_R = 180;
    const SCENE_SCALE = 0.7; // orbit spans ~53% of the viewport's short side

    const TRACK_COLOR = 'var(--dsw-alias-border-l2, #5a554c)';
    const INK_COLOR = 'var(--dsw-alias-label-secondary, #8a8171)';
    const CJK_FONT = "'Kaiti SC', 'STKaiti', 'KaiTi', 'DFKai-SB', 'Noto Serif SC', serif";
    const UI_FONT = 'ui-sans-serif, system-ui, "Microsoft YaHei", sans-serif';

    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (!raw) return { ...DEFAULTS };
        const saved = JSON.parse(raw);
        return {
          mode: saved && saved.mode === 'animated' ? 'animated' : 'text',
          opacity: Math.min(Math.max(Number(saved && saved.opacity) || DEFAULTS.opacity, 0.05), 1),
          enabled: saved && saved.enabled === false ? false : true
        };
      } catch {
        return { ...DEFAULTS };
      }
    }

    function saveSettings(s) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(s));
      } catch {
        /* private mode / storage disabled — settings simply don't persist */
      }
    }

    // Watermark alpha: the whole scene is faint, so map 0.05..1 -> 0.02..0.50.
    function alphaOf(opacity) {
      return 0.02 + 0.48 * Math.min(Math.max(Number(opacity) || 0, 0.05), 1);
    }

    // --------------------------------------------------------------- motion

    // Shared animation clock. Polls the host tok/s route, eases the rate, and
    // advances ONE orbital angle theta every frame. While tokens are flowing the
    // donkey speeds up; between chunks (and across tool-call / reasoning lulls
    // within the same turn) it keeps a slow idle plod for up to PLOD_BRIDGE_MS.
    // The idle plod is gated on the host `active` flag (= an attempt is in flight
    // with recent chunk activity), which is the honest "is generation happening"
    // signal; the host `rate` can still bleed out as a decaying memory of the
    // previous turn, so we do NOT drive motion off it. Once `active` has stayed
    // false for that whole window (every session stopped) the floor is dropped
    // and the donkey eases to a full stop.
    // onFrame(st, now) is called once on mount (initial pose) and every frame;
    // it writes SVG attributes directly, so React never re-renders per frame.
    function useMillClock(onFrame) {
      const stRef = React.useRef({
        target: 0, rate: 0, speed: 0, angle: Math.PI, gait: 0, lastT: 0, lastTps: -1,
        lastActiveAt: 0, moving: 0
      });
      const frameRef = React.useRef(onFrame);
      frameRef.current = onFrame;

      React.useEffect(() => {
        let timer = 0;
        let stopped = false;
        const poll = async () => {
          if (stopped) return;
          try {
            const res = await fetch(RATE_URL, { cache: 'no-store' });
            if (res.ok) {
              const data = await res.json();
              const activeNow = !!(data && data.active);
              // The host `active` flag (= an attempt is in flight with recent
              // token activity) is the honest "is anything generating" signal.
              // The host `rate` ALSO bleeds out as a decaying memory of the
              // previous turn (readRate's endedRate tail), so we must NOT feed
              // the tok/s speed from `rate` unless `active` is true — otherwise
              // the donkey keeps spinning for seconds after every turn ends.
              const r = Number(data && data.rate);
              stRef.current.target = activeNow && Number.isFinite(r) && r > 0 ? r : 0;
              stRef.current.active = activeNow;
              // CRITICAL: lastActiveAt is compared against the rAF callback's
              // `now` (a DOMHighResTimeStamp, i.e. ms since the time origin) in
              // tick(). It MUST be stamped on that same clock. Using Date.now()
              // (ms since the Unix epoch) makes `now - lastActiveAt` a huge
              // negative number, so `plodding` stays true forever and the
              // donkey never stops. performance.now() shares rAF's time origin.
              if (activeNow) stRef.current.lastActiveAt = performance.now();
            } else {
              stRef.current.target = 0;
              stRef.current.active = false;
            }
          } catch {
            stRef.current.target = 0;
            stRef.current.active = false;
          }
        };
        poll();
        timer = window.setInterval(poll, POLL_MS);
        return () => {
          stopped = true;
          window.clearInterval(timer);
        };
      }, []);

      React.useEffect(() => {
        const st = stRef.current;
        frameRef.current(st, 0); // no flash at the SVG origin before frame 1
        let raf = 0;
        const tick = (now) => {
          raf = window.requestAnimationFrame(tick);
          if (st.lastT === 0) { st.lastT = now; return; }
          const dt = Math.min(Math.max((now - st.lastT) / 1000, 0.001), 0.1);
          st.lastT = now;
          const k = 1 - Math.exp(-dt / EASE_TAU);
          st.rate += k * (st.target - st.rate);
          if (st.rate < 0.01) st.rate = 0;
          st.speed = st.rate > 0 ? Math.sqrt(Math.min(st.rate / FULL_SPEED_TPS, 1)) : 0;
          // `plodding` is true only while generation was active within the linger
          // window — i.e. a turn is still alive across its quiet gaps (tool call,
          // reasoning, sub-second lull). Measured from the LAST active poll, so a
          // brief gap doesn't reset the grace. Once `active` has stayed false for
          // PLOD_BRIDGE_MS (every session stopped) the floor is dropped and the
          // donkey eases to a full stop instead of plodding forever.
          // Guard the lower bound too: a timestamp from a different clock (or a
          // future value) yields a negative idle, which must NOT count as
          // "recently active". Only a positive elapsed within the bridge window
          // keeps the idle plod alive.
          const idleSinceActive = now - st.lastActiveAt;
          const plodding = st.lastActiveAt > 0 && idleSinceActive >= 0 && idleSinceActive <= PLOD_BRIDGE_MS;
          const base = plodding ? IDLE_ORBIT_RAD_S : 0;
          const orbit = base + st.speed * ORBIT_RAD_S;
          st.angle = (st.angle + orbit * dt) % (Math.PI * 2);
          st.gait += orbit * dt * GAIT_FACTOR;
          // Smooth motion level: 1 while moving, 0 once stopped. Gates the tiny
          // idle breathing / tail-sway so the donkey is truly still when every
          // session has stopped.
          st.moving = Math.min(1, orbit / IDLE_ORBIT_RAD_S);
          frameRef.current(st, now);
        };
        raf = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(raf);
      }, []);

      return stRef;
    }

    // Shared tok/s pill, rendered inside the watermark (inherits its alpha).
    function Readout({ tps }) {
      return h('foreignObject', { x: 430, y: 960, width: 140, height: 30 },
        h('div', {
          style: {
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontSize: 12,
            textAlign: 'center',
            color: INK_COLOR,
            opacity: tps >= 1 ? 1 : 0
          }
        }, tps + ' tok/s')
      );
    }

    // ---------------------------------------------------------------- artwork

    function DonkeyBody() {
      return h(
        React.Fragment,
        null,
        h('rect', { 'data-leg': 'FL', x: -32, y: -31, width: 10, height: 14, rx: 5, fill: '#837c6e' }),
        h('rect', { 'data-leg': 'FR', x: 22, y: -31, width: 10, height: 14, rx: 5, fill: '#837c6e' }),
        h('rect', { 'data-leg': 'BL', x: -32, y: 17, width: 10, height: 14, rx: 5, fill: '#7a7365' }),
        h('rect', { 'data-leg': 'BR', x: 22, y: 17, width: 10, height: 14, rx: 5, fill: '#7a7365' }),
        h(
          'g',
          { 'data-tail': '1' },
          h('line', { x1: 0, y1: 52, x2: 0, y2: 74, stroke: '#6f6759', strokeWidth: 2.5, strokeLinecap: 'round' }),
          h('ellipse', { cx: 0, cy: 78, rx: 4, ry: 7, fill: '#5d564b' })
        ),
        h(
          'g',
          { 'data-body': '1' },
          h('ellipse', { cx: 0, cy: 0, rx: 21, ry: 52, fill: '#9a9384' }),
          h('ellipse', { cx: 0, cy: 6, rx: 14, ry: 36, fill: '#a49d8d', opacity: 0.55 }),
          h('line', { x1: 0, y1: -46, x2: 0, y2: -24, stroke: '#6f6759', strokeWidth: 4, strokeLinecap: 'round' })
        ),
        h('rect', { x: -15, y: -58, width: 30, height: 9, rx: 4, fill: '#7a5c3e' }),
        h('ellipse', { cx: 0, cy: -66, rx: 13, ry: 17, fill: '#9a9384' }),
        h('ellipse', { cx: 0, cy: -80, rx: 8.5, ry: 10, fill: '#8b8474' }),
        h('path', { d: 'M -10 -74 L -17 -93 L -4 -81 Z', fill: '#8b8474' }),
        h('path', { d: 'M 10 -74 L 17 -93 L 4 -81 Z', fill: '#8b8474' }),
        h(
          'g',
          { 'data-dust': '1' },
          h('circle', { cx: -30, cy: 36, r: 5, fill: '#cfc5b4' }),
          h('circle', { cx: 30, cy: 32, r: 4, fill: '#cfc5b4' }),
          h('circle', { cx: -27, cy: 52, r: 6, fill: '#cfc5b4' }),
          h('circle', { cx: 27, cy: 56, r: 4.5, fill: '#cfc5b4' })
        )
      );
    }

    function Watermark({ alpha, children }) {
      return h(
        'div',
        {
          'aria-hidden': true,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 0,
            pointerEvents: 'none',
            opacity: alpha
          }
        },
        h(
          'svg',
          {
            viewBox: '0 0 1000 1000',
            width: '100%',
            height: '100%',
            preserveAspectRatio: 'xMidYMid meet',
            style: { display: 'block' }
          },
          h(
            'g',
            { transform: 'translate(500 500) scale(' + SCENE_SCALE + ') translate(-500 -500)' },
            children
          )
        )
      );
    }

    // ------------------------------------------------------------- text scene

    // Same motion as the cartoon form: 驴 orbits the circle at theta (kept
    // upright so the glyph stays readable), 磨 rotates 1:1 with theta, the
    // pole follows the 驴.
    function TextScene({ alpha }) {
      const [tps, setTps] = React.useState(0);
      const donkeyRef = React.useRef(null);
      const millRef = React.useRef(null);
      const poleRef = React.useRef(null);

      const onFrame = (st) => {
        const donkey = donkeyRef.current;
        const mill = millRef.current;
        const pole = poleRef.current;
        if (!donkey || !mill || !pole) return;
        const theta = st.angle;
        const x = CX + R * Math.cos(theta);
        const y = CY + R * Math.sin(theta);
        donkey.setAttribute('transform', 'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ')');
        mill.setAttribute('transform', 'rotate(' + ((theta * 180) / Math.PI).toFixed(2) + ' ' + CX + ' ' + CY + ')');
        pole.setAttribute('x2', x.toFixed(2));
        pole.setAttribute('y2', y.toFixed(2));
        const tpsNow = Math.round(st.rate);
        if (tpsNow !== st.lastTps) { st.lastTps = tpsNow; setTps(tpsNow); }
      };
      useMillClock(onFrame);

      return h(
        Watermark,
        { alpha },
        h('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: TRACK_COLOR, strokeWidth: 2, strokeDasharray: '4 10', opacity: 0.5 }),
        h('line', { ref: poleRef, x1: CX, y1: CY, x2: CX - R, y2: CY, stroke: '#8b6b47', strokeWidth: 7, strokeLinecap: 'round', opacity: 0.8 }),
        h('g', { ref: millRef },
          h('text', { x: CX, y: CY, textAnchor: 'middle', dominantBaseline: 'central', fontSize: 300, fontFamily: CJK_FONT, fill: INK_COLOR }, '磨')
        ),
        h('g', { ref: donkeyRef },
          h('text', { x: 0, y: 0, textAnchor: 'middle', dominantBaseline: 'central', fontSize: 170, fontFamily: CJK_FONT, fill: INK_COLOR }, '驴')
        ),
        h(Readout, { tps })
      );
    }

    // --------------------------------------------------------- cartoon scene

    function AnimatedScene({ alpha }) {
      const [tps, setTps] = React.useState(0);
      const donkeyRef = React.useRef(null);
      const millRef = React.useRef(null);
      const poleRef = React.useRef(null);
      const partsRef = React.useRef(null);

      const onFrame = (st, now) => {
        const donkey = donkeyRef.current;
        const mill = millRef.current;
        const pole = poleRef.current;
        if (!donkey || !mill || !pole) return;
        if (!partsRef.current) {
          const parts = { leg: [], tail: [], body: [], dust: [] };
          for (const el of donkey.querySelectorAll('[data-leg],[data-tail],[data-body],[data-dust]')) {
            const kind = el.hasAttribute('data-leg') ? 'leg' : el.hasAttribute('data-tail') ? 'tail' : el.hasAttribute('data-body') ? 'body' : 'dust';
            parts[kind].push(el);
          }
          partsRef.current = parts;
        }
        const parts = partsRef.current;
        const theta = st.angle;
        const x = CX + R * Math.cos(theta);
        const y = CY + R * Math.sin(theta);
        const faceDeg = (Math.atan2(Math.cos(theta), -Math.sin(theta)) * 180) / Math.PI;
        donkey.setAttribute('transform', 'translate(' + x.toFixed(2) + ' ' + y.toFixed(2) + ') rotate(' + (faceDeg + 90).toFixed(2) + ')');
        pole.setAttribute('x2', x.toFixed(2));
        pole.setAttribute('y2', y.toFixed(2));
        mill.setAttribute('transform', 'rotate(' + ((theta * 180) / Math.PI).toFixed(2) + ')');

        const speed = st.speed;
        const amp = 1.5 + 7 * Math.min(speed * 1.3, 1);
        for (const el of parts.leg) {
          const name = el.getAttribute('data-leg');
          const phase = name === 'FL' || name === 'BR' ? 0 : Math.PI;
          const s = Math.sin(st.gait + phase) * amp;
          el.setAttribute('transform', 'translate(0 ' + s.toFixed(2) + ')');
        }
        const sway = Math.sin(st.gait * 0.7 + now / 900) * (5 + 11 * speed) * st.moving;
        for (const el of parts.tail) el.setAttribute('transform', 'rotate(' + sway.toFixed(2) + ' 0 52)');
        const breathe = 1 + 0.02 * Math.sin(now / 850) * st.moving;
        for (const el of parts.body) el.setAttribute('transform', 'scale(' + breathe.toFixed(4) + ')');
        const dustOpacity = (speed * 0.4).toFixed(3);
        for (const el of parts.dust) el.setAttribute('opacity', dustOpacity);

        const tpsNow = Math.round(st.rate);
        if (tpsNow !== st.lastTps) { st.lastTps = tpsNow; setTps(tpsNow); }
      };
      useMillClock(onFrame);

      return h(
        Watermark,
        { alpha },
        h('circle', { cx: CX, cy: CY + 8, r: MILL_R + 8, fill: '#000000', opacity: 0.05 }),
        h('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: TRACK_COLOR, strokeWidth: 2, strokeDasharray: '4 10', opacity: 0.5 }),
        h('line', { ref: poleRef, x1: CX, y1: CY, x2: CX - R, y2: CY, stroke: '#8b6b47', strokeWidth: 7, strokeLinecap: 'round' }),
        h('g', { ref: donkeyRef }, h(DonkeyBody, null)),
        h('circle', { cx: CX, cy: CY, r: MILL_R, fill: '#b5ab99' }),
        h('circle', { cx: CX, cy: CY, r: MILL_R, fill: 'none', stroke: '#8a8171', strokeWidth: 6 }),
        h('circle', { cx: CX, cy: CY, r: MILL_R - 30, fill: 'none', stroke: '#9d9384', strokeWidth: 2 }),
        h(
          'g',
          { transform: 'translate(' + CX + ' ' + CY + ')' },
          h(
            'g',
            { ref: millRef },
            ...Array.from({ length: 8 }, (_, i) => {
              const a = (i * Math.PI) / 4;
              return h('line', {
                key: i,
                x1: Math.cos(a) * 46,
                y1: Math.sin(a) * 46,
                x2: Math.cos(a) * (MILL_R - 34),
                y2: Math.sin(a) * (MILL_R - 34),
                stroke: '#9d9384',
                strokeWidth: 3
              });
            }),
            h('circle', { cx: 0, cy: 0, r: 40, fill: '#a89f8e' }),
            h('circle', { cx: 0, cy: 0, r: 40, fill: 'none', stroke: '#8a8171', strokeWidth: 3 }),
            h('circle', { cx: 0, cy: 0, r: 16, fill: '#6f6759' })
          )
        ),
        h(Readout, { tps })
      );
    }

    // ------------------------------------------------------------ control UI

    function ControlPanel({ settings, onChange }) {
      const [open, setOpen] = React.useState(true);
      const panel = {
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 40,
        pointerEvents: 'auto',
        fontFamily: UI_FONT,
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary, #222)',
        background: 'var(--dsw-alias-bg-base, #fff)',
        border: '1px solid var(--dsw-alias-border-l2, #ccc)',
        borderRadius: 10,
        boxShadow: '0 4px 18px rgba(0,0,0,0.18)',
        padding: '10px 12px',
        opacity: 0.94,
        userSelect: 'none'
      };
      const row = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 };
      const btn = (active) => ({
        fontFamily: UI_FONT,
        fontSize: 12,
        padding: '4px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: '1px solid ' + (active ? 'var(--dsw-alias-brand-primary, #3b6ef5)' : 'var(--dsw-alias-border-l2, #ccc)'),
        background: active ? 'var(--dsw-alias-brand-primary, #3b6ef5)' : 'transparent',
        color: active ? '#fff' : 'var(--dsw-alias-label-primary, #222)'
      });

      return h(
        'div',
        { style: panel, 'data-donkey-panel': '1' },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontWeight: 600 }, onClick: () => setOpen(!open) },
          h('span', null, '驴拉磨'),
          h('span', { style: { fontSize: 11, opacity: 0.6 } }, open ? '▾' : '▸')
        ),
        open
          ? h(
              React.Fragment,
              null,
              h('div', { style: { ...row, marginTop: 10 } },
                h('span', { style: { opacity: 0.7 } }, '形态'),
                h('button', { type: 'button', style: btn(settings.mode === 'text'), onClick: () => onChange({ ...settings, mode: 'text' }) }, '文字'),
                h('button', { type: 'button', style: btn(settings.mode === 'animated'), onClick: () => onChange({ ...settings, mode: 'animated' }) }, '动画')
              ),
              h('div', { ...row },
                h('span', { style: { opacity: 0.7 } }, '透明度'),
                h('input', {
                  type: 'range',
                  min: 0.05,
                  max: 1,
                  step: 0.01,
                  value: settings.opacity,
                  style: { flex: 1, cursor: 'pointer' },
                  onChange: (e) => onChange({ ...settings, opacity: Number(e.target.value) })
                }),
                h('span', { style: { width: 32, textAlign: 'right', fontFamily: 'ui-monospace, Consolas, monospace' } }, Math.round(settings.opacity * 100) + '%')
              ),
              h('div', { ...row },
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', opacity: 0.8 } },
                  h('input', {
                    type: 'checkbox',
                    checked: settings.enabled,
                    onChange: (e) => onChange({ ...settings, enabled: e.target.checked })
                  }),
                  '显示背景'
                )
              )
            )
          : null
      );
    }

    // ------------------------------------------------------------------ root

    function DonkeyRoot() {
      const [settings, setSettings] = React.useState(loadSettings);
      const onChange = (next) => {
        setSettings(next);
        saveSettings(next);
      };
      const alpha = alphaOf(settings.opacity);
      return h(
        React.Fragment,
        null,
        settings.enabled
          ? settings.mode === 'text'
            ? h(TextScene, { alpha })
            : h(AnimatedScene, { alpha })
          : null,
        h(ControlPanel, { settings, onChange })
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'donkey-mill', order: -100 },
            () => h(DonkeyRoot, null)
          )
        );
      }
    };
  }
});
