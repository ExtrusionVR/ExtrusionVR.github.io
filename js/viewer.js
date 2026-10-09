// Biopolymer Extrusion VR Lab - WebXR viewer for granular-flow simulations exported by the tools/export_*_web.py converters.
// Desktop: orbit with the mouse, buttons in the top bar, keys Space play, C cut view, R reset view, arrows step,
//   [ / ] move the cut plane (cut view only, or drag the Cut position slider).
// Touch: one finger rotate, pinch zoom, two fingers pan. Headset (Quest browser): Enter VR, then
//   right trigger  play / pause            left trigger   top view <-> cross-section (slice through the powder)
//   one grip       grab and move model     both grips     scale (pull apart / together) and move
//   right stick    scrub (left / right)    left stick     move the cut plane (cut view only)
//   A              reset model position and size           B    speed 0.25x/0.5x/1x/2x
//   X              particle detail low / medium / high (use low if motion stutters)
//   Y              exit VR (back to the page)
import * as THREE from 'three';
import { OrbitControls } from '../vendor/addons/OrbitControls.js';
import { VRButton } from '../vendor/addons/VRButton.js';
import { getFile, getJSON } from './vault.js';
import { detectDevice, renderControls, bnHTML, BN_GLOSSARY } from './controls.js';

const params = new URLSearchParams(location.search);
const MODEL = params.get('m');
const BASE = `models/${MODEL}/`;
const VR_SIZE = 1.0;                      // largest model dimension in the headset at start [m]
const SPEEDS = [0.25, 0.5, 1, 2];
const DETAIL = { low: [8, 4], medium: [12, 6], high: [16, 8] };   // superquadric segments (around, pole to pole)

const ui = {
  title: document.getElementById('title'), status: document.getElementById('status'),
  play: document.getElementById('play'), view: document.getElementById('view'),
  speed: document.getElementById('speed'), detail: document.getElementById('detail'),
  slider: document.getElementById('slider'), time: document.getElementById('time'),
  legend: document.getElementById('legend'), rlo: document.getElementById('rlo'), rhi: document.getElementById('rhi'),
  rhide: document.getElementById('rhide'), rfull: document.getElementById('rfull'), reset: document.getElementById('reset'),
  info: document.getElementById('info'), infoBtn: document.getElementById('info-btn'),
  cutbox: document.getElementById('cutbox'), cutpos: document.getElementById('cutpos'), cutval: document.getElementById('cutval'),
};

// ---------------------------------------------------------------- state
const state = {
  meta: null, entry: {}, frames: [], loadedFrames: 0, frame: 0, framePos: 0, playing: true,
  speedIdx: 2, section: false, detail: 'medium', dirty: true, cutPos: 0,   // cut-plane z, user-movable in cut view
  rng: { full: [0, 255], cut: [0, 255] },   // particle-speed colour range in stored units (0..255), per view
  hideOutside: true,                        // hide particles outside the colour range (else clamp their colour)
};
const curRange = () => (state.section ? state.rng.cut : state.rng.full);

// ---------------------------------------------------------------- three.js scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(0);              // sharp everywhere (fine particles)
renderer.localClippingEnabled = true;
document.getElementById('canvas-host').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d1f24);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(1, 3, 2);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.8);
fill.position.set(-2, 1, -1);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.002, 100);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const model = new THREE.Group();          // everything in GF coordinates (metres, y up)
scene.add(model);

const clipLocal = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);   // keeps z <= cutPos (constant kept in sync with it)
const clipWorld = new THREE.Plane();

// ---------------------------------------------------------------- helpers
function jet(t) {
  const c = (x) => Math.min(1, Math.max(0, x));
  return [c(1.5 - Math.abs(4 * t - 3)), c(1.5 - Math.abs(4 * t - 2)), c(1.5 - Math.abs(4 * t - 1))];
}
function lut(n) {                          // linear-space RGB of the jet map (instance colours are linear)
  const out = new Float32Array(3 * n), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const [r, g, b] = jet(i / (n - 1));
    col.setRGB(r, g, b, THREE.SRGBColorSpace);
    out.set([col.r, col.g, col.b], 3 * i);
  }
  return out;
}
const LUT = lut(256);

function superquadric(n, segU, segV) {     // |x|^n + |y|^n + |z|^n = 1, unit semi-axes
  const e = 2 / n, sp = (v, p) => Math.sign(v) * Math.pow(Math.abs(v), p);
  const pos = [], idx = [];
  for (let j = 0; j <= segV; j++) {
    const phi = -Math.PI / 2 + Math.PI * j / segV;
    for (let i = 0; i <= segU; i++) {
      const th = -Math.PI + 2 * Math.PI * i / segU;
      const cp = sp(Math.cos(phi), e);
      pos.push(cp * sp(Math.cos(th), e), cp * sp(Math.sin(th), e), sp(Math.sin(phi), e));
    }
  }
  for (let j = 0; j < segV; j++) for (let i = 0; i < segU; i++) {
    const a = j * (segU + 1) + i, b = a + segU + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function meshFromBin(buf) {
  const dv = new DataView(buf), nv = dv.getUint32(0, true), nt = dv.getUint32(4, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, 8, 3 * nv), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, 8 + 12 * nv, 3 * nt), 1));
  g.computeVertexNormals();
  return g;
}

const pad4 = (n) => (n + 3) & ~3;
function parseChunk(buf) {                  // -> [{n, pos:Uint16Array, quat:Int8Array, semi, speed, vy}]
  const dv = new DataView(buf), nf = dv.getUint32(0, true), out = [];
  let o = 4;
  for (let f = 0; f < nf; f++) {
    const n = dv.getUint32(o, true); o += 4;
    const pos = new Uint16Array(buf, o, 3 * n); o += pad4(6 * n);
    const quat = new Int8Array(buf, o, 4 * n); o += pad4(4 * n);
    const semi = new Uint8Array(buf, o, 3 * n); o += pad4(3 * n);
    const speed = new Uint8Array(buf, o, n); o += pad4(n);
    const vy = new Int8Array(buf, o, n); o += pad4(n);
    out.push({ n, pos, quat, semi, speed, vy });
  }
  return out;
}

// ---------------------------------------------------------------- model parts
let particles = null, barrel = null;
const screws = [];
const barrelMat = new THREE.MeshStandardMaterial({ color: 0xcfd0d6, roughness: 0.5, metalness: 0.05,
  transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide });
const screwMat = new THREE.MeshStandardMaterial({ color: 0xdedfe4, roughness: 0.35, metalness: 0.15,
  side: THREE.DoubleSide });
const partMat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05 });

function buildParticles() {
  if (particles) { model.remove(particles); particles.geometry.dispose(); particles.dispose(); }
  const [u, v] = DETAIL[state.detail];
  const maxN = Math.max(...state.meta.counts, 1);
  particles = new THREE.InstancedMesh(superquadric(state.meta.blockiness, u, v), partMat, maxN);
  particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particles.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3 * maxN), 3);
  particles.instanceColor.setUsage(THREE.DynamicDrawUsage);
  particles.frustumCulled = false;
  particles.count = 0;
  model.add(particles);
  state.dirty = true;
}

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
function showFrame(k) {
  const M = state.meta, F = state.frames[k];
  if (!F || !particles) return;
  const lo = M.box_lo, sp = [0, 1, 2].map((a) => (M.box_hi[a] - lo[a]) / 65535), sm = M.semi_max / 255;
  const col = particles.instanceColor.array, zs = state.cutPos, zh = M.zhalf;
  const half = M.section_mode === 'half';    // 'half': keep z <= cutPos (open the bed); default: thin slab centred on cutPos
  const [rlo, rhi] = curRange(), span = Math.max(1, rhi - rlo), hide = state.hideOutside;
  let j = 0;
  for (let i = 0; i < F.n; i++) {
    const z = lo[2] + F.pos[3 * i + 2] * sp[2];
    if (state.section && (half ? z > zs : Math.abs(z - zs) > zh)) continue;
    const raw = F.speed[i];                     // both views: colour = particle speed |v|
    if (hide && (raw < rlo || raw > rhi)) continue;
    _p.set(lo[0] + F.pos[3 * i] * sp[0], lo[1] + F.pos[3 * i + 1] * sp[1], z);
    _q.set(F.quat[4 * i + 1], F.quat[4 * i + 2], F.quat[4 * i + 3], F.quat[4 * i]).normalize();
    _s.set(F.semi[3 * i] * sm, F.semi[3 * i + 1] * sm, F.semi[3 * i + 2] * sm);
    particles.setMatrixAt(j, _m.compose(_p, _q, _s));
    const c = Math.min(255, Math.max(0, Math.round((raw - rlo) * 255 / span)));   // colours stretched over the range
    col[3 * j] = LUT[3 * c]; col[3 * j + 1] = LUT[3 * c + 1]; col[3 * j + 2] = LUT[3 * c + 2];
    j++;
  }
  particles.count = j;
  particles.instanceMatrix.needsUpdate = true;
  particles.instanceColor.needsUpdate = true;
  M.objects.forEach((o, s) => {
    const p = o.poses[k];
    screws[s].position.set(p[0], p[1], p[2]);
    screws[s].rotation.set(p[3], p[4], p[5], 'XYZ');   // GF: R = Rx Ry Rz
  });
  state.frame = k;
}

function setSection(on) {
  state.section = on;
  barrelMat.opacity = on ? 1 : 0.25;
  barrelMat.transparent = !on;
  barrelMat.depthWrite = on;
  barrelMat.clippingPlanes = on ? [clipWorld] : [];
  // moving parts (screws, blade) are cut too unless the model keeps them whole (e.g. a blade left visible in the cut)
  screwMat.clippingPlanes = on && state.meta?.section_clip_objects !== false ? [clipWorld] : [];
  barrelMat.needsUpdate = screwMat.needsUpdate = true;
  ui.view.textContent = on ? `View: ${sectionLabel()}` : 'View: full';
  ui.cutbox.hidden = !on;
  if (!renderer.xr.isPresenting && state.meta) resetView();   // desktop: look straight at the cut / back to the overview
  syncRange();
  showColours();
  state.dirty = true;
}

function cutBounds() {                        // [lo, hi] the cut plane can move within, in GF metres (z)
  const M = state.meta;
  return [M.box_lo[2], M.box_hi[2]];
}
function setCutPos(z) {                        // move the cut plane (slab centre / half-cut threshold)
  const [lo, hi] = cutBounds();
  state.cutPos = Math.min(hi, Math.max(lo, z));
  clipLocal.constant = state.cutPos;
  ui.cutpos.value = state.cutPos;
  ui.cutval.textContent = `${Math.round(state.cutPos * 1000)} mm`;
  if (state.section) { ui.view.textContent = `View: ${sectionLabel()}`; showColours(); }
  state.dirty = true;
}

function stopGlide() {                         // drop the mouse controls' leftover easing motion, or it carries on after a reset
  orbit._sphericalDelta?.set(0, 0, 0);
  orbit._panOffset?.set(0, 0, 0);
  orbit._scale = 1;
}
function resetView() {                         // desktop: overview, or straight at the cut in cut view
  if (!state.meta) return;
  stopGlide();
  if (!state.section) { placeDesktop(); return; }
  const c = modelCentre(), M = state.meta;
  const h = Math.max(M.box_hi[0] - M.box_lo[0], M.box_hi[1] - M.box_lo[1]);
  orbit.target.set(c.x, c.y, state.cutPos);
  camera.position.set(c.x, c.y, state.cutPos + 1.4 * h);
  orbit.update();
}

function sectionLabel() {
  const base = state.meta?.section_label || 'cross-section';
  return `${base} (z = ${Math.round(state.cutPos * 1000)} mm)`;
}

// ---------------------------------------------------------------- legend + headset wrist panel
function codeValue(code) {                    // stored 0..255 -> particle speed [m/s]
  return code / 255 * state.meta.vmax;
}
const fmt = (v) => String(+v.toFixed(2));
function drawBar(ctx, x, y, w, h) {            // full scale; inside the range = colour map, outside = grey or end colour
  const [lo, hi] = curRange(), span = Math.max(1, hi - lo);
  for (let i = 0; i < w; i++) {
    const code = 255 * i / (w - 1);
    let rgb;
    if ((code < lo || code > hi) && state.hideOutside) rgb = [0.27, 0.28, 0.31];
    else rgb = jet(Math.min(1, Math.max(0, (code - lo) / span)));
    ctx.fillStyle = `rgb(${255 * rgb[0]},${255 * rgb[1]},${255 * rgb[2]})`;
    ctx.fillRect(x + i, y, 1, h);
  }
}
function legendText() {
  const M = state.meta, [lo, hi] = curRange();
  const top = hi === 255 ? '+' : '';          // speeds above vmax are stored as vmax
  return {
    label: 'Particle speed (m/s)',
    lo: fmt(codeValue(lo)), hi: fmt(codeValue(hi)) + top, full: lo === 0 && hi === 255,
    loFrac: lo / 255, hiFrac: hi / 255, M,
  };
}
function drawTicks(ctx, x, w, y, L) {          // range ends under the handles, kept apart and inside the bar
  const a = ctx.measureText(L.lo).width, b = ctx.measureText(L.hi).width;
  let xa = x + L.loFrac * w - a / 2, xb = x + L.hiFrac * w - b / 2;
  xa = Math.max(x, Math.min(xa, x + w - a - b - 8)); xb = Math.min(x + w - b, Math.max(xb, xa + a + 8));
  ctx.fillText(L.lo, xa, y); ctx.fillText(L.hi, xb, y);
}
function showColours() {                       // the info panel's plain-language colour key
  const M = state.meta, el = document.getElementById('info-colours');
  if (!M || !el) return;
  const L = legendText();
  const range = L.full ? '' : ` Only ${state.hideOutside ? 'particles' : 'colours'} between ${L.lo} and ${L.hi} m/s `
    + `are ${state.hideOutside ? 'shown' : 'spread over the colour bar'}.`;
  el.textContent = (state.section
    ? `Cut view (${sectionLabel()}): each particle is coloured by its speed - blue = slow, red = fast (full scale: `
      + `0 to ${M.vmax} m/s or faster). Only particles in the cut are shown. Drag the Cut position slider `
      + '(or the left stick in VR) to move the cut through the model.'
    : `Each small shape is one simulated powder particle, coloured by its speed: blue = slow, red = fast (full scale: `
      + `0 to ${M.vmax} m/s or faster). The grey parts are the moving equipment (screws or blade); `
      + 'the see-through shell is the housing. Press the view button for a cut through the powder.') + range
    + ' Drag the two handles on the colour bar to pick a speed range.';
}
const BAR_X = 5;                               // bar inset = half the slider handle width, so handles sit on the ends
function drawLegend() {
  const c = ui.legend, ctx = c.getContext('2d'), L = legendText(), w = c.width - 2 * BAR_X;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#e8e9ee'; ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(L.label, 0, 13);
  drawBar(ctx, BAR_X, 20, w, 12);
  ctx.fillStyle = '#e8e9ee';
  drawTicks(ctx, BAR_X, w, 48, L);
}
function syncRange() {                         // sliders + legend + panel follow the current view's range
  const [lo, hi] = curRange();
  ui.rlo.value = lo; ui.rhi.value = hi;
  drawLegend(); showColours();
}
function onRange(which) {
  let lo = +ui.rlo.value, hi = +ui.rhi.value;
  if (lo > hi - 3) { if (which === 'lo') lo = hi - 3; else hi = lo + 3; }
  const r = curRange(); r[0] = Math.max(0, lo); r[1] = Math.min(255, hi);
  syncRange(); state.dirty = true;
}

const wristCanvas = document.createElement('canvas');
wristCanvas.width = 512; wristCanvas.height = 300;
const wristTex = new THREE.CanvasTexture(wristCanvas);
wristTex.colorSpace = THREE.SRGBColorSpace;
const wrist = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16 * 300 / 512),
  new THREE.MeshBasicMaterial({ map: wristTex, transparent: true }));
wrist.position.set(0, 0.06, 0.02);
wrist.rotation.x = -Math.PI / 3;
let wristKey = '';
function drawWrist() {
  const M = state.meta;
  if (!M) return;
  const t = M.times[state.frame] ?? 0, L = legendText();
  const key = `${state.frame}|${state.playing}|${state.section}|${state.speedIdx}|${state.detail}|${state.loadedFrames}|${curRange()}|${state.hideOutside}|${state.cutPos}`;
  if (key === wristKey) return;
  wristKey = key;
  const ctx = wristCanvas.getContext('2d');
  ctx.clearRect(0, 0, 512, 300);
  ctx.fillStyle = 'rgba(20,22,28,0.88)'; ctx.fillRect(0, 0, 512, 300);
  ctx.fillStyle = '#fff';
  const title = state.entry.title || M.title;
  let fs = 34;                                   // shrink the title until it fits
  do { ctx.font = `bold ${fs}px system-ui, sans-serif`; fs -= 2; } while (ctx.measureText(title).width > 476 && fs > 18);
  ctx.fillText(title, 18, 42);
  if (state.entry.bn_pp != null || state.entry.bn_pw != null) {
    ctx.fillStyle = '#9ad0ff';
    drawBN(ctx, 18, 78, state.entry);
  }
  ctx.fillStyle = '#fff'; ctx.font = '30px system-ui, sans-serif';
  ctx.fillText(`${state.playing ? '▶' : '❚❚'}  t = ${t.toFixed(3)} s   ${SPEEDS[state.speedIdx]}x`, 18, 122);
  if (state.loadedFrames < M.nframes) {
    ctx.textAlign = 'right'; ctx.fillText(`loading ${Math.round(100 * state.loadedFrames / M.nframes)} %`, 494, 122);
    ctx.textAlign = 'left';
  }
  ctx.font = state.section && sectionLabel().length > 26 ? '22px system-ui, sans-serif' : '28px system-ui, sans-serif';
  ctx.fillText(state.section ? sectionLabel() : 'full view', 18, 160);
  ctx.font = '24px system-ui, sans-serif';
  ctx.fillText(L.label, 18, 198);
  drawBar(ctx, 18, 208, 476, 22);
  ctx.fillStyle = '#fff';
  drawTicks(ctx, 18, 476, 256, L);
  ctx.fillStyle = '#9aa0ad'; ctx.font = '20px system-ui, sans-serif';
  ctx.fillText(`detail ${state.detail}      Y = exit VR`, 18, 288);
  wristTex.needsUpdate = true;
}

function drawBN(ctx, x, y, m) {                 // "BN_PP = 100 · BN_PW = 100" with real subscripts
  const f = (v) => (v == null ? '-' : Number(v).toLocaleString('en'));
  for (const [a, sub, b] of [['BN', 'PP', ` = ${f(m.bn_pp)}  \u00b7  `], ['BN', 'PW', ` = ${f(m.bn_pw)}`]]) {
    ctx.font = '26px system-ui, sans-serif'; ctx.fillText(a, x, y); x += ctx.measureText(a).width;
    ctx.font = '17px system-ui, sans-serif'; ctx.fillText(sub, x, y + 6); x += ctx.measureText(sub).width;
    ctx.font = '26px system-ui, sans-serif'; ctx.fillText(b, x, y); x += ctx.measureText(b).width;
  }
}

// ---------------------------------------------------------------- placement
function modelCentre() {
  const M = state.meta;
  return new THREE.Vector3((M.box_lo[0] + M.box_hi[0]) / 2, (M.box_lo[1] + M.box_hi[1]) / 2, (M.box_lo[2] + M.box_hi[2]) / 2);
}
function placeDesktop() {
  model.position.set(0, 0, 0); model.quaternion.identity(); model.scale.setScalar(1);
  const c = modelCentre(), M = state.meta;
  const d = Math.max(...[0, 1, 2].map((a) => M.box_hi[a] - M.box_lo[a]));
  orbit.target.copy(c);
  camera.position.set(c.x + 0.9 * d, c.y + 0.6 * d, c.z + 1.2 * d);
  camera.near = 0.002; camera.far = 10; camera.updateProjectionMatrix();
  orbit.update();
}
function placeVR() {                          // in front of the user, centre at chest height
  model.quaternion.identity();
  const M = state.meta;
  const scale = VR_SIZE / Math.max(...[0, 1, 2].map((a) => M.box_hi[a] - M.box_lo[a]));
  model.scale.setScalar(scale);
  const c = modelCentre().multiplyScalar(scale);
  model.position.set(-c.x, 1.15 - c.y, -0.7 - c.z);
}

// ---------------------------------------------------------------- headset input
const hands = { left: null, right: null };
const grab = { active: [], offset: new THREE.Matrix4(), d0: 1, s0: 1, anchor: new THREE.Vector3() };
const prevButtons = { left: [], right: [] };

function setupController(i) {
  const ctl = renderer.xr.getController(i);
  scene.add(ctl);
  const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -0.25)]),
    new THREE.LineBasicMaterial({ color: 0x9ad0ff }));
  ctl.add(ray);
  ctl.addEventListener('connected', (e) => {
    ctl.userData.hand = e.data.handedness;
    ctl.userData.source = e.data;
    hands[e.data.handedness] = ctl;
    if (e.data.handedness === 'left') ctl.add(wrist);
  });
  ctl.addEventListener('disconnected', () => { hands[ctl.userData.hand] = null; });
  ctl.addEventListener('selectstart', () => {
    if (ctl.userData.hand === 'right') togglePlay();
    else if (ctl.userData.hand === 'left') setSection(!state.section);
  });
  ctl.addEventListener('squeezestart', () => { grab.active.push(ctl); startGrab(); });
  ctl.addEventListener('squeezeend', () => { grab.active = grab.active.filter((c) => c !== ctl); startGrab(); });
}
function startGrab() {
  model.updateMatrixWorld();
  if (grab.active.length === 1) {
    grab.offset.copy(grab.active[0].matrixWorld).invert().multiply(model.matrixWorld);
  } else if (grab.active.length >= 2) {
    const [a, b] = grab.active.map((c) => new THREE.Vector3().setFromMatrixPosition(c.matrixWorld));
    grab.d0 = a.distanceTo(b); grab.s0 = model.scale.x;
    grab.anchor.copy(a).add(b).multiplyScalar(0.5);
    model.worldToLocal(grab.anchor);          // model point under the hands' midpoint
  }
}
function updateGrab() {
  if (grab.active.length === 1) {
    const m = new THREE.Matrix4().multiplyMatrices(grab.active[0].matrixWorld, grab.offset);
    const s = model.scale.clone();
    m.decompose(model.position, model.quaternion, new THREE.Vector3());
    model.scale.copy(s);
  } else if (grab.active.length >= 2) {
    const [a, b] = grab.active.slice(0, 2).map((c) => new THREE.Vector3().setFromMatrixPosition(c.matrixWorld));
    const s = Math.min(200, Math.max(0.5, grab.s0 * a.distanceTo(b) / grab.d0));
    model.scale.setScalar(s);
    const mid = a.add(b).multiplyScalar(0.5);
    const off = grab.anchor.clone().multiplyScalar(s).applyQuaternion(model.quaternion);
    model.position.copy(mid).sub(off);
  }
}
function pollButtons(dt) {
  for (const hand of ['left', 'right']) {
    const ctl = hands[hand], gp = ctl?.userData.source?.gamepad;
    if (!gp) continue;
    const pressed = gp.buttons.map((b) => b.pressed), was = prevButtons[hand];
    const edge = (i) => pressed[i] && !was[i];
    if (hand === 'right') {
      if (edge(4)) placeVR();                                                   // A
      if (edge(5)) { state.speedIdx = (state.speedIdx + 1) % SPEEDS.length; syncUI(); }   // B
      const x = gp.axes[2] || 0;                                                // stick: scrub
      if (Math.abs(x) > 0.25) scrub(x * 48 * dt);
    } else {
      if (edge(4)) {                                                            // X: detail
        const keys = Object.keys(DETAIL);
        state.detail = keys[(keys.indexOf(state.detail) + 1) % keys.length];
        buildParticles(); syncUI();
      }
      if (edge(5)) renderer.xr.getSession()?.end();                             // Y: exit VR
      const y = gp.axes[3] || 0;                                                // stick: move the cut plane
      if (state.section && Math.abs(y) > 0.25) {
        const [lo, hi] = cutBounds();
        setCutPos(state.cutPos - y * (hi - lo) * 0.3 * dt);
      }
    }
    prevButtons[hand] = pressed;
  }
}

// ---------------------------------------------------------------- playback
function togglePlay() { state.playing = !state.playing; syncUI(); }
function scrub(df) {
  const n = Math.max(1, state.loadedFrames);
  state.framePos = (((state.framePos + df) % n) + n) % n;
  state.dirty = true;
}
function syncUI() {
  ui.play.textContent = state.playing ? 'Pause' : 'Play';
  ui.speed.value = String(state.speedIdx);
  ui.detail.value = state.detail;
}
ui.play.onclick = togglePlay;
ui.view.onclick = () => setSection(!state.section);
ui.reset.onclick = resetView;
ui.rlo.oninput = () => onRange('lo');
ui.rhi.oninput = () => onRange('hi');
ui.rhide.onchange = () => { state.hideOutside = ui.rhide.checked; syncRange(); state.dirty = true; };
ui.rfull.onclick = () => { const r = curRange(); r[0] = 0; r[1] = 255; syncRange(); state.dirty = true; };
ui.cutpos.oninput = () => setCutPos(+ui.cutpos.value);
for (const b of document.querySelectorAll('.bar button')) b.addEventListener('click', () => b.blur());   // keep Space for play
function setInfo(open) {
  ui.info.hidden = !open;
  ui.infoBtn.setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('lab-info-closed', open ? '0' : '1'); } catch { /* storage blocked: fine */ }
}
ui.infoBtn.onclick = () => setInfo(ui.info.hidden);
document.getElementById('info-close').onclick = () => setInfo(false);
try { if (localStorage.getItem('lab-info-closed') === '1') setInfo(false); } catch { /* storage blocked: keep open */ }
window.addEventListener('keydown', (e) => {   // desktop shortcuts
  if (e.ctrlKey || e.metaKey || e.altKey || renderer.xr.isPresenting) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === ' ') togglePlay();
  else if (k === 'c') setSection(!state.section);
  else if (k === 'r') resetView();
  else if ((k === '[' || k === ']') && state.section) {
    const [lo, hi] = cutBounds();
    setCutPos(state.cutPos + (k === ']' ? 1 : -1) * (hi - lo) / 100);
  } else if (k === 'arrowleft' || k === 'arrowright') {
    state.playing = false; syncUI();
    state.framePos = Math.floor(state.framePos);
    scrub(k === 'arrowright' ? 1 : -1);
  } else if (k === 'escape') setInfo(false);
  else return;
  e.preventDefault();
});
ui.speed.onchange = () => { state.speedIdx = +ui.speed.value; };
ui.detail.onchange = () => { state.detail = ui.detail.value; buildParticles(); };
ui.slider.oninput = () => { state.framePos = +ui.slider.value; state.dirty = true; };

const WRIST_TEST = params.get('wrist') === '1';   // ?wrist=1: show the headset wrist panel on the page (layout check)
if (WRIST_TEST) {
  wristCanvas.style.cssText = 'position:fixed;right:14px;top:120px;z-index:5;width:512px';
  document.body.appendChild(wristCanvas);
}
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const M = state.meta;
  if (M) {
    if (renderer.xr.isPresenting) { pollButtons(dt); updateGrab(); } else orbit.update();
    if (state.playing && state.loadedFrames > 0) {
      state.framePos = (state.framePos + dt * M.fps * SPEEDS[state.speedIdx]) % state.loadedFrames;
    }
    const k = Math.min(Math.floor(state.framePos), state.loadedFrames - 1);
    if (k >= 0 && (k !== state.frame || state.dirty)) {
      showFrame(k);
      state.dirty = false;
      ui.slider.value = k;
      ui.time.textContent = `t = ${M.times[k].toFixed(3)} s  (${k + 1}/${M.nframes})`;
    }
    model.updateMatrixWorld();
    clipWorld.copy(clipLocal).applyMatrix4(model.matrixWorld);
    if (renderer.xr.isPresenting || WRIST_TEST) drawWrist();
  }
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
setupController(0);
setupController(1);
renderer.xr.addEventListener('sessionstart', placeVR);
renderer.xr.addEventListener('sessionend', placeDesktop);

// ---------------------------------------------------------------- load
async function main() {
  if (!MODEL) { ui.status.textContent = 'No model given (?m=...)'; return; }
  const devP = detectDevice();                    // in parallel: never hold up loading
  devP.then((dev) => renderControls(document.getElementById('info-controls'), dev));
  const [M, models] = await Promise.all([getJSON(BASE + 'meta.json'), getJSON('models/index.json').catch(() => [])]);
  state.meta = M;
  const E = state.entry = models.find((m) => m.id === MODEL) || {};   // Lab card text: title, Bond numbers, explanation
  const title = E.title || M.title;
  document.title = `${title} - Biopolymer Extrusion VR Lab`;
  ui.title.textContent = title;
  document.getElementById('info-title').textContent = title;
  const bn = bnHTML(E);
  document.getElementById('info-bn').innerHTML = bn;
  document.getElementById('info-glossary').innerHTML = bn ? BN_GLOSSARY : '';
  const about = document.getElementById('info-about');   // plain text from the model list, BN_PP -> BN with subscript
  about.textContent = E.about || E.description || M.description || '';
  about.innerHTML = about.innerHTML.replace(/BN_(PP|PW)/g, 'BN<sub>$1</sub>');
  ui.slider.max = M.nframes - 1;
  const [zlo, zhi] = cutBounds();
  ui.cutpos.min = zlo; ui.cutpos.max = zhi; ui.cutpos.step = (zhi - zlo) / 400;
  setCutPos(params.has('cut') ? +params.get('cut') / 1000 : M.zslice);   // ?cut=MM: start the cut plane here
  if (params.has('range')) {                   // ?range=LO,HI: start with this particle-speed range [m/s]
    const [a, b] = params.get('range').split(',').map(Number);
    const code = (v) => Math.round(Math.min(255, Math.max(0, v / M.vmax * 255)));
    if (b > a) { state.rng.full = [code(a), code(b)]; state.rng.cut = [code(a), code(b)]; }
  }
  showColours();
  syncRange(); syncUI();

  barrel = new THREE.Mesh(meshFromBin(await getFile(BASE + M.barrel)), barrelMat);
  barrel.renderOrder = 2;
  model.add(barrel);
  for (const o of M.objects) {
    const s = new THREE.Mesh(meshFromBin(await getFile(BASE + o.file)), screwMat);
    screws.push(s); model.add(s);
  }
  M.objects.forEach((o, i) => {                // moving parts at their frame-0 pose until the particle data arrives
    const p = o.poses[0];
    screws[i].position.set(p[0], p[1], p[2]);
    screws[i].rotation.set(p[3], p[4], p[5], 'XYZ');
  });
  buildParticles();
  placeDesktop();
  if (params.get('section') === '1') setSection(true);
  if (params.has('zoom')) {                   // ?zoom=F: start the desktop camera F times closer
    camera.position.sub(orbit.target).multiplyScalar(1 / +params.get('zoom')).add(orbit.target);
  }

  const dev = await devP;
  if (dev.vr) {                                   // headset: Enter VR button; otherwise say which mode this is
    const vrb = VRButton.createButton(renderer, { optionalFeatures: ['local-floor'] });
    document.getElementById('vr-host').appendChild(vrb);
  } else {
    const badge = document.getElementById('mode-badge');
    badge.textContent = `${dev.touch && !dev.mouse ? 'Touch' : 'Desktop'} 3D mode \u00b7 VR available on compatible headsets (e.g. Meta Quest)`;
    badge.hidden = false;
  }

  for (let c = 0; c < M.nchunks; c++) {
    const buf = await getFile(`${BASE}chunk_${String(c).padStart(3, '0')}.bin`, (got, total) => {
      const frac = total ? got / total : 0;
      ui.status.textContent = `Loading ${Math.round(100 * (c + frac) / M.nchunks)} %`;
    });
    state.frames.push(...parseChunk(buf));
    state.loadedFrames = state.frames.length;
    const want = params.has('frame') ? Math.min(+params.get('frame'), M.nframes - 1) : -1;
    if (want >= 0 && want < state.loadedFrames && !state.jumped) {   // ?frame=K: open paused on frame K
      state.jumped = true; state.playing = false; state.framePos = want; state.dirty = true; syncUI();
    }
  }
  ui.status.textContent = `${M.nframes} frames loaded`;
}
main().catch((e) => { ui.status.textContent = 'Error: ' + e.message; console.error(e); });
