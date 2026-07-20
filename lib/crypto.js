// AES-GCM + PBKDF2 helpers for optional master-password encryption.
const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERS = 250_000;

function bufToB64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function deriveKey(password, saltB64, iterations = PBKDF2_ITERS) {
  const salt = b64ToBuf(saltB64);
  const material = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function createSalt() {
  const s = crypto.getRandomValues(new Uint8Array(16));
  return bufToB64(s);
}

export async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: bufToB64(iv), ct: bufToB64(ct) };
}

export async function decryptJson(key, ivB64, ctB64) {
  const iv = b64ToBuf(ivB64);
  const ct = b64ToBuf(ctB64);
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(dec.decode(buf));
}

export { PBKDF2_ITERS };
