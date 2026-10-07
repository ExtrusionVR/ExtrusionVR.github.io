// Device detection + control help for the Lab page and the viewer.
// Shows only the controls for the device in use (headset, mouse + keyboard, touch); the rest sit under
// "Controls for other devices" so you can still read up before putting a headset on.

export const CONTROLS = {
  headset: {
    title: 'VR headset (e.g. Meta Quest)',
    rows: [
      ['Right trigger', 'Play / pause'],
      ['Left trigger', 'Full view &harr; cut view (a slice through the powder; the wrist panel says where)'],
      ['One grip', 'Grab and move the model'],
      ['Both grips', 'Scale: pull hands apart to enlarge, together to shrink'],
      ['Right stick', 'Scrub backwards / forwards'],
      ['A', 'Reset position and size'],
      ['B', 'Speed 0.25x / 0.5x / 1x / 2x'],
      ['X', 'Particle detail low / medium / high (use low if motion stutters)'],
      ['Y', 'Exit VR (back to the page). The headset\'s Meta button also works.'],
    ],
    note: 'Open a model, then press <b>Enter VR</b>. Your left wrist shows the time, view, speed and colour scale.',
  },
  mouse: {
    title: 'Laptop / desktop (mouse, touchpad, keyboard)',
    rows: [
      ['Left-drag', 'Rotate the view'],
      ['Right-drag or Shift + drag', 'Move (pan) the view'],
      ['Scroll wheel / two-finger swipe', 'Zoom in / out'],
      ['Space', 'Play / pause'],
      ['C', 'Full view &harr; cut view'],
      ['R', 'Reset the view (also the <b>Reset view</b> button)'],
      ['&larr; / &rarr;', 'Step one frame back / forward (pauses)'],
      ['Colour bar handles', 'Drag to pick the range of speeds you see (others are hidden unless you untick <b>Hide outside range</b>)'],
      ['Top bar', 'Play, view, speed, particle detail and the time slider'],
    ],
  },
  touch: {
    title: 'Touch screen (tablet, phone)',
    rows: [
      ['One-finger drag', 'Rotate the view'],
      ['Pinch', 'Zoom in / out'],
      ['Two-finger drag', 'Move (pan) the view'],
      ['Colour bar handles', 'Drag to pick the range of speeds you see'],
      ['Top bar', 'Play, view, speed, detail, time slider and <b>Reset view</b>'],
    ],
  },
};

export async function detectDevice() {
  const ua = navigator.userAgent;
  const headsetBrowser = /OculusBrowser|Quest|PicoBrowser|Pico Neo|Wolvic/i.test(ua);
  let vr = false;
  try {                                          // some browsers never answer: give up after 2 s
    vr = !!(navigator.xr && await Promise.race([navigator.xr.isSessionSupported('immersive-vr'),
      new Promise((ok) => setTimeout(() => ok(false), 2000))]));
  } catch { vr = false; }
  const mq = (q) => { try { return matchMedia(q).matches; } catch { return false; } };
  const fine = mq('(any-pointer: fine)');
  const coarse = mq('(any-pointer: coarse)') || navigator.maxTouchPoints > 0;
  return {
    vr: vr || headsetBrowser,
    headsetBrowser,
    mouse: !headsetBrowser && (fine || !coarse),
    touch: !headsetBrowser && coarse,
  };
}

function table(kind) {
  const c = CONTROLS[kind];
  const rows = c.rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  return `<h3>${c.title}</h3><table>${rows}</table>${c.note ? `<p class="muted">${c.note}</p>` : ''}`;
}

// Fills host with the controls for this device, and the others folded away.
export function renderControls(host, dev) {
  const kinds = Object.keys(CONTROLS);
  let mine = kinds.filter((k) => (k === 'headset' ? dev.vr : dev[k]));
  if (!mine.length) mine = ['mouse'];
  const others = kinds.filter((k) => !mine.includes(k));
  host.innerHTML = mine.map(table).join('') + (others.length
    ? `<details class="other-devices"><summary>Controls for other devices</summary>${others.map(table).join('')}</details>`
    : '');
}

// "BN_PP = 100 · BN_PW = 100" as HTML (subscripts), or '' when the model has no Bond numbers.
export function bnHTML(m) {
  if (m?.bn_pp == null && m?.bn_pw == null) return '';
  const f = (x) => (x == null ? '&ndash;' : Number(x).toLocaleString('en'));
  return `BN<sub>PP</sub> = ${f(m.bn_pp)} &middot; BN<sub>PW</sub> = ${f(m.bn_pw)}`;
}

export const BN_GLOSSARY = 'BN = Bond number: how strongly particles stick (cohesive force) compared with their own '
  + 'weight. BN<sub>PP</sub> is between particles, BN<sub>PW</sub> between particles and walls. Higher = stickier.';
