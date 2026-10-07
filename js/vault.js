// Passphrase-encrypted model files for the online Lab (tools/encrypt_site.py).
// If models/crypto.json exists, every file under models/ is stored as <name>.enc = 12-byte IV + AES-256-GCM
// ciphertext, with the key derived from the passphrase by Argon2id (memory-hard, so offline guessing is slow).
// Without crypto.json (local laptop
// server) files are fetched as they are. The derived key can be remembered on the device (localStorage).

let mode = null;          // 'plain' | 'encrypted'
let keyPromise = null;

async function init() {
  if (mode) return;
  const r = await fetch('models/crypto.json', { cache: 'no-cache' });
  mode = r.ok ? 'encrypted' : 'plain';
  if (mode === 'encrypted') keyPromise = obtainKey(await r.json());
}

const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
};

// Argon2id from hash-wasm (pinned version, checked by its SRI hash). Same algorithm as tools/encrypt_site.py.
const KDF_SRC = 'https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/argon2.umd.min.js';
const KDF_SRI = 'sha384-tP0Wy54CKmng7i9EoTlPySD0hBx6Octj0VS6MfwlnUu111MPa+JLm0CCbep6XJ1W';
let kdfLib = null;
function loadKdf() {
  if (!kdfLib) {
    kdfLib = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = KDF_SRC; s.integrity = KDF_SRI; s.crossOrigin = 'anonymous';
      s.onload = () => ok(window.hashwasm);
      s.onerror = () => { kdfLib = null; fail(new Error('could not load the key-derivation library')); };
      document.head.appendChild(s);
    });
  }
  return kdfLib;
}

async function deriveKey(pass, info) {
  if (info.kdf !== 'argon2id') throw new Error('unknown key derivation in models/crypto.json');
  const hw = await loadKdf();
  const raw = await hw.argon2id({ password: pass, salt: b64.dec(info.salt), iterations: info.t, parallelism: info.p,
    memorySize: info.m, hashLength: 32, outputType: 'binary' });
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['decrypt']);
}

async function check(key, info) {
  try {
    const c = b64.dec(info.check);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, key, c.slice(12));
    return new TextDecoder().decode(plain) === 'swannies-vr-lab';
  } catch { return false; }
}

function storeKeyName(info) { return `vrlab-key-${info.salt}`; }

async function obtainKey(info) {
  for (const store of [sessionStorage, localStorage]) {          // remembered from earlier?
    try {
      const raw = store.getItem(storeKeyName(info));
      if (raw) {
        const key = await crypto.subtle.importKey('raw', b64.dec(raw), 'AES-GCM', true, ['decrypt']);
        if (await check(key, info)) return key;
      }
    } catch { /* storage unavailable */ }
  }
  return askPassphrase(info);
}

function askPassphrase(info) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'vault';
    box.innerHTML = `<form class="vault-card">
      <h2>Biopolymer Extrusion VR Lab</h2><p>Enter the passphrase to open the models.</p>
      <input type="password" autocomplete="current-password" placeholder="Passphrase" required>
      <label class="vault-remember"><input type="checkbox" checked> Remember on this device</label>
      <button type="submit">Open</button><p class="vault-msg" role="alert"></p></form>`;
    document.body.appendChild(box);
    const form = box.querySelector('form'), input = form.querySelector('input[type=password]');
    const remember = form.querySelector('input[type=checkbox]'), msg = form.querySelector('.vault-msg');
    input.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      msg.textContent = 'Checking... (this takes a few seconds)';
      let key;
      try { key = await deriveKey(input.value, info); } catch (err) { msg.textContent = err.message; return; }
      if (!(await check(key, info))) { msg.textContent = 'Wrong passphrase.'; input.select(); return; }
      const raw = b64.enc(await crypto.subtle.exportKey('raw', key));
      try { (remember.checked ? localStorage : sessionStorage).setItem(storeKeyName(info), raw); } catch { /* ignore */ }
      box.remove();
      resolve(key);
    };
  });
}

async function download(url, onProgress) {
  // small list/info files are revalidated every time, so a new upload shows at once (GitHub caches 10 min)
  const r = await fetch(url, /\.json(\.enc)?$/.test(url) ? { cache: 'no-cache' } : {});
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!onProgress || !r.body) return r.arrayBuffer();
  const total = +r.headers.get('Content-Length') || 0, reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

// ArrayBuffer of a file under models/ (decrypted when the site is encrypted)
export async function getFile(path, onProgress) {
  await init();
  if (mode === 'plain') return download(path, onProgress);
  const key = await keyPromise;
  const buf = new Uint8Array(await download(path + '.enc', onProgress));
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.subarray(12));
}

export async function getJSON(path) {
  return JSON.parse(new TextDecoder().decode(await getFile(path)));
}

export async function getImageURL(path) {
  return URL.createObjectURL(new Blob([await getFile(path)], { type: 'image/jpeg' }));
}

export function forget() {
  for (const store of [sessionStorage, localStorage]) {
    try { Object.keys(store).filter((k) => k.startsWith('vrlab-key-')).forEach((k) => store.removeItem(k)); } catch { /* */ }
  }
}
