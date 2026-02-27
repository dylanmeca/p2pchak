/* chat.js — p2pchat completo (versión final integrada)
   Incluye TODOS los cambios solicitados:
   - ID propio: 5 caracteres (MAYÚSCULAS y dígitos) con reintentos si está en uso
   - PeerJS P2P (connect, accept, close, error)
   - ack / read / sync (receipts)
   - historial por par en sessionStorage
   - archivos: dataURL y transferencia por chunks
   - file-card: archivos como tarjetas (no burbujas) con nombre como link descargable/viewable
   - animaciones: typing wave; incoming typewriter; outgoing streaming
   - desconectar: envía comando reload al par y recarga local
   - textarea autosize, Enter = newline, Ctrl/Cmd+Enter => enviar
   - typing debounced por input
   - revocación segura de objectURLs tras uso
*/

/* ---------------------------- Selectores ---------------------------- */
const myIdEl = document.getElementById('myId');
const peerIdInput = document.getElementById('peerIdInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusText = document.getElementById('statusText');
const messagesEl = document.getElementById('messages');
const messagesArea = document.getElementById('messagesArea');
const messageInput = document.getElementById('messageInput'); // textarea
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const typingIndicator = document.getElementById('typingIndicator');

/* ---------------------------- Estado ---------------------------- */
let peer = null;
let conn = null;
let currentPeerId = null;
let messageHistory = []; // {id, text, ts, me, status, meta}
const HISTORY_PREFIX = 'p2pchat_history_';
const CHUNK_SIZE = 512 * 1024; // 512KB

/* ---------------------------- E2EE: AES-GCM 256 (end-to-end) ---------------------------- */
/* Nota:
   - El intercambio de clave usa ECDH (P-256) + HKDF(SHA-256) -> AES-GCM 256.
   - Requiere HTTPS (window.isSecureContext) para WebCrypto.
   - Sin verificación de identidad, un atacante activo podría hacer MITM; si quieres mitigar, compara un "código" (SAS) mostrado a ambos.
*/
const E2EE = {
  enabled: true,        // activar/desactivar E2EE
  require: true,        // FAIL‑CLOSED: si true, NO se permite tráfico en claro
  auth: true,           // firma del handshake + TOFU (mitiga MITM/downgrade)
  started: false,
  ready: false,
  localKeyPair: null,
  localNonce: null,     // Uint8Array(32)
  remotePubJwk: null,   // JWK (ECDH)
  remoteNonce: null,    // Uint8Array(32)
  aesKey: null,         // CryptoKey (AES-GCM 256)
  sendQueue: [],        // objetos sin cifrar esperando llave
  recvQueue: [],        // sobres E2EE esperando llave
  sendChain: Promise.resolve(), // para mantener el orden al enviar cifrado
  identity: {           // identidad persistente (ECDSA) para autenticar el handshake
    keyPair: null,
    pubJwk: null,
    fingerprint: null
  },
  handshakeTimeoutMs: 12000,
  handshakeTimer: null
};


const _te = new TextEncoder();
const _td = new TextDecoder();
/* --- E2EE hardening: identidad (TOFU) + firmas + anti‑downgrade --- */
function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
function u8ToHex(u8) {
  return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function e2eeFingerprintJwk(jwk) {
  const s = stableStringify(jwk);
  const digest = await crypto.subtle.digest('SHA-256', _te.encode(s));
  return u8ToHex(new Uint8Array(digest)); // hex completo (64 chars)
}
async function e2eeLoadOrCreateIdentity() {
  if (!E2EE.auth) return;
  if (E2EE.identity && E2EE.identity.keyPair) return;

  const PUB_K = 'p2pchat_id_pub_v1';
  const PRIV_K = 'p2pchat_id_priv_v1';

  try {
    const pubRaw = sessionStorage.getItem(PUB_K);
    const privRaw = sessionStorage.getItem(PRIV_K);

    if (pubRaw && privRaw) {
      const pubJwk = JSON.parse(pubRaw);
      const privJwk = JSON.parse(privRaw);
      const pubKey = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      const privKey = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      E2EE.identity.keyPair = { publicKey: pubKey, privateKey: privKey };
      E2EE.identity.pubJwk = pubJwk;
      E2EE.identity.fingerprint = await e2eeFingerprintJwk(pubJwk);
      return;
    }

    // No existe: generamos identidad persistente
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
    const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    sessionStorage.setItem(PUB_K, JSON.stringify(pubJwk));
    sessionStorage.setItem(PRIV_K, JSON.stringify(privJwk));
    E2EE.identity.keyPair = kp;
    E2EE.identity.pubJwk = pubJwk;
    E2EE.identity.fingerprint = await e2eeFingerprintJwk(pubJwk);
  } catch (e) {
    console.error('Identity key setup failed', e);
    // Si E2EE es requerida, cerramos (fail-closed)
    if (E2EE.require) {
      addSystem('⛔ No se pudo preparar la identidad E2EE (almacenamiento o WebCrypto). Cerrando conexión.');
      try { if (conn) conn.close(); } catch (_) {}
      resetConnection();
    } else {
      addSystem('⚠️ No se pudo preparar identidad E2EE; se desactiva autenticación.');
      E2EE.auth = false;
    }
  }
}

async function e2eeSignHandshake({ ecdhPubJwk, nonceB64, fromId, toId }) {
  await e2eeLoadOrCreateIdentity();
  const payload = _te.encode(stableStringify({ ecdhPubJwk, nonceB64, fromId: String(fromId || ''), toId: String(toId || '') }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, E2EE.identity.keyPair.privateKey, payload);
  return abToB64(sig);
}

async function e2eeVerifyHandshake({ idPubJwk, sigB64, ecdhPubJwk, nonceB64, fromId, toId }) {
  const pubKey = await crypto.subtle.importKey('jwk', idPubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const payload = _te.encode(stableStringify({ ecdhPubJwk, nonceB64, fromId: String(fromId || ''), toId: String(toId || '') }));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, b64ToAb(sigB64), payload);
}

async function e2eeTOFUCheck(peerId, idPubJwk) {
  const key = 'p2pchat_tofu_' + String(peerId || 'unknown');
  const fp = await e2eeFingerprintJwk(idPubJwk);
  const stored = sessionStorage.getItem(key);
  if (!stored) {
    sessionStorage.setItem(key, fp);
    addSystem('🔑 Identidad del par guardada: ' + fp.slice(0, 12) + '…');
    return true;
  }
  if (stored !== fp) {
    addSystem('⛔ La identidad del par CAMBIÓ (posible MITM o reinstalación). Rechazando conexión.');
    return false;
  }
  return true;
}

function e2eeAvailable() {
  return !!(window.crypto && crypto.subtle && window.isSecureContext);
}

function u8Concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function abToB64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b64ToAb(b64) {
  const binary = atob(String(b64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function e2eeReset() {
  E2EE.started = false;
  E2EE.ready = false;
  E2EE.localKeyPair = null;
  E2EE.localNonce = null;
  E2EE.remotePubJwk = null;
  E2EE.remoteNonce = null;
  E2EE.aesKey = null;
  E2EE.sendQueue = [];
  E2EE.recvQueue = [];
}

async function e2eeStartHandshake() {
  if (!E2EE.enabled) return;

  if (!e2eeAvailable()) {
    addSystem('⛔ E2EE requiere HTTPS (contexto seguro).');
    if (E2EE.require) {
      try { if (conn) conn.close(); } catch (_) {}
      resetConnection();
    } else {
      E2EE.enabled = false;
    }
    return;
  }
  if (!conn || conn.open === false) return;
  if (E2EE.started) return;

  E2EE.started = true;
  E2EE.ready = false;

  // Anti‑downgrade: si no se completa el handshake, cerramos (fail‑closed).
  if (E2EE.handshakeTimer) { try { clearTimeout(E2EE.handshakeTimer); } catch (_) {} }
  E2EE.handshakeTimer = setTimeout(() => {
    if (!E2EE.ready) {
      addSystem('⛔ No se pudo establecer E2EE (timeout). Cerrando conexión.');
      try { if (conn) conn.close(); } catch (_) {}
      resetConnection();
    }
  }, E2EE.handshakeTimeoutMs);

  try {
    // Identidad persistente para autenticar el handshake (mitiga MITM/downgrade).
    if (E2EE.auth) await e2eeLoadOrCreateIdentity();

    E2EE.localNonce = crypto.getRandomValues(new Uint8Array(32));
    E2EE.localKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const pub = await crypto.subtle.exportKey('jwk', E2EE.localKeyPair.publicKey);
    const nonceB64 = abToB64(E2EE.localNonce);

    let idPub = null;
    let sig = null;
    if (E2EE.auth) {
      idPub = E2EE.identity.pubJwk;
      sig = await e2eeSignHandshake({
        ecdhPubJwk: pub,
        nonceB64,
        fromId: peer && peer.id,
        toId: conn && conn.peer
      });
    }

    // Enviamos el material público (sin cifrar) para poder derivar la clave simétrica.
    conn.send({ type: 'kex1', pub, nonce: nonceB64, idPub, sig });
  } catch (e) {
    console.error('E2EE handshake start failed', e);
    addSystem('⛔ No se pudo iniciar E2EE. Cerrando conexión.');
    try { if (conn) conn.close(); } catch (_) {}
    resetConnection();
  }
}

async function e2eeHandleKex1(msg) {
  if (!E2EE.enabled) return;

  if (!e2eeAvailable()) {
    addSystem('⛔ E2EE requiere HTTPS (contexto seguro).');
    if (E2EE.require) {
      try { if (conn) conn.close(); } catch (_) {}
      resetConnection();
    } else {
      E2EE.enabled = false;
    }
    return;
  }

  // Si el otro lado inicia primero, nos aseguramos de tener nuestras llaves/nonce y responder.
  if (!E2EE.started) await e2eeStartHandshake();

  try {
    // Autenticación del handshake (firma) + TOFU (trust-on-first-use)
    if (E2EE.auth) {
      if (!msg || !msg.idPub || !msg.sig || !msg.pub || !msg.nonce) {
        addSystem('⛔ El par no soporta autenticación E2EE requerida. Rechazando.');
        try { if (conn) conn.close(); } catch (_) {}
        resetConnection();
        return;
      }
      const okSig = await e2eeVerifyHandshake({
        idPubJwk: msg.idPub,
        sigB64: msg.sig,
        ecdhPubJwk: msg.pub,
        nonceB64: msg.nonce,
        fromId: conn && conn.peer,
        toId: peer && peer.id
      });
      if (!okSig) {
        addSystem('⛔ Firma de handshake inválida (posible MITM/downgrade). Rechazando.');
        try { if (conn) conn.close(); } catch (_) {}
        resetConnection();
        return;
      }
      const okTofu = await e2eeTOFUCheck(conn && conn.peer, msg.idPub);
      if (!okTofu) {
        try { if (conn) conn.close(); } catch (_) {}
        resetConnection();
        return;
      }
    } else if (E2EE.require && (!msg || !msg.pub || !msg.nonce)) {
      addSystem('⛔ Handshake E2EE incompleto. Rechazando.');
      try { if (conn) conn.close(); } catch (_) {}
      resetConnection();
      return;
    }

    if (msg && msg.pub) E2EE.remotePubJwk = msg.pub;
    if (msg && msg.nonce) E2EE.remoteNonce = new Uint8Array(b64ToAb(msg.nonce));
    await e2eeMaybeFinalize();
  } catch (e) {
    console.error('E2EE handle kex1 failed', e);
    addSystem('⛔ Error en intercambio de claves E2EE. Cerrando conexión.');
    try { if (conn) conn.close(); } catch (_) {}
    resetConnection();
  }
}

async function e2eeMaybeFinalize() {
  if (!E2EE.enabled) return;
  if (E2EE.ready) return;
  if (!E2EE.localKeyPair || !E2EE.remotePubJwk || !E2EE.localNonce || !E2EE.remoteNonce) return;

  const remotePub = await crypto.subtle.importKey(
    'jwk',
    E2EE.remotePubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 1) ECDH -> secreto compartido
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePub },
    E2EE.localKeyPair.privateKey,
    256
  );

  // 2) HKDF(SHA-256) -> AES-GCM 256
  const baseKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  // Salt determinístico basado en ambos nonces (ordenado para que ambos lados obtengan lo mismo)
  const n1 = abToB64(E2EE.localNonce);
  const n2 = abToB64(E2EE.remoteNonce);
  const salt = (n1 < n2) ? u8Concat(E2EE.localNonce, E2EE.remoteNonce) : u8Concat(E2EE.remoteNonce, E2EE.localNonce);

  const info = _te.encode('p2pchat-e2ee-aesgcm-256-v1');
  E2EE.aesKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  E2EE.ready = true;
  if (E2EE.handshakeTimer) { try { clearTimeout(E2EE.handshakeTimer); } catch (_) {} }
  E2EE.handshakeTimer = null;

  // (Opcional) SAS de verificación manual contra MITM: 6 dígitos.
  try {
    const digest = await crypto.subtle.digest('SHA-256', sharedBits);
    const d = new Uint8Array(digest);
    const code = String(((d[0] << 16) | (d[1] << 8) | d[2]) % 1000000).padStart(6, '0');
    addSystem('🔒 Cifrado activo. Código de verificación: ' + code);
  } catch (_) {
    addSystem('🔒 Cifrado activo.');
  }

  // Enviar lo que estaba en cola
  const toSend = E2EE.sendQueue.splice(0, E2EE.sendQueue.length);
  toSend.forEach(obj => e2eeSendEncryptedNow(obj));

  // Procesar lo recibido en cola (si llegó antes de terminar la derivación)
  const toRecv = E2EE.recvQueue.splice(0, E2EE.recvQueue.length);
  toRecv.forEach(env => e2eeHandleEnvelope(env));
}

async function e2eeEncryptObject(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV recomendado para GCM
  const plaintext = _te.encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, E2EE.aesKey, plaintext);
  return { type: 'e2ee', v: 1, iv: abToB64(iv), data: abToB64(ciphertext) };
}

async function e2eeDecryptEnvelope(env) {
  const iv = new Uint8Array(b64ToAb(env.iv));
  const ciphertext = b64ToAb(env.data);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, E2EE.aesKey, ciphertext);
  const text = _td.decode(plaintext);
  return JSON.parse(text);
}

function e2eeSendEncryptedNow(obj) {
  if (!conn || conn.open === false) return;
  e2eeEncryptObject(obj).then(env => {
    try { conn.send(env); } catch (e) { console.error(e); addSystem('Fallo al enviar'); }
  }).catch(err => {
    console.error('E2EE encrypt failed', err);
    addSystem('⛔ Error cifrando (fail‑closed). Cerrando conexión.');
    try { if (conn) conn.close(); } catch (_) {}
    resetConnection();
  });
}

function e2eeHandleEnvelope(env) {
  if (!E2EE.enabled) {
    addSystem('⚠️ Mensaje cifrado recibido pero E2EE está desactivado.');
    return;
  }
  if (!E2EE.ready) { E2EE.recvQueue.push(env); return; }

  e2eeDecryptEnvelope(env).then(inner => {
    // despachamos el mensaje real
    inner.__e2ee = true;
    handleIncoming(inner);
  }).catch(err => {
    console.error('E2EE decrypt failed', err);
    addSystem('⛔ No se pudo descifrar (llave distinta o manipulación). Cerrando conexión.');
    try { if (conn) conn.close(); } catch (_) {}
    resetConnection();
  });
}

function e2eeShouldBypass(obj) {
  // Mensajes necesarios para bootstrap no deben ir cifrados.
  return !!(obj && (obj.type === 'kex1'));
}


/* ---------------------------- Util: IDs ---------------------------- */
function generatePeerId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}
function genMessageId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/* ---------------------------- Storage ---------------------------- */
function loadHistory(peerId) {
  const key = HISTORY_PREFIX + (peerId || 'local');
  try {
    const raw = sessionStorage.getItem(key);
    messageHistory = raw ? JSON.parse(raw) : [];
  } catch (e) {
    messageHistory = [];
  }
}
function saveHistory(peerId) {
  const key = HISTORY_PREFIX + (peerId || 'local');
  try { sessionStorage.setItem(key, JSON.stringify(messageHistory)); } catch (e) { /* ignore */ }
}

/* ---------------------------- UI helpers ---------------------------- */
function setStatus(text) { if (statusText) statusText.textContent = text; }
function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'message in';
  el.style.opacity = 0.8;
  el.style.fontSize = '13px';
  el.style.background = 'transparent';
  el.style.border = '0';
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* ---------------------------- Peer creation + retry ---------------------------- */
function createPeerWithRandomId(maxRetries = 3) {
  const desiredId = generatePeerId();
  try { if (peer && typeof peer.destroy === 'function') peer.destroy(); } catch (e) { /* ignore */ }
  peer = new Peer(desiredId);

  peer.on('open', id => {
    if (myIdEl) myIdEl.textContent = id;
    setStatus('Listo — Esperando conexión');
    loadHistory(null);
    renderMessages();
  });

  peer.on('connection', c => {
    if (conn) {
      c.on('open', () => c.send({ type: 'system', text: 'already_connected' }));
      return;
    }
    bindConnection(c);
  });

  peer.on('disconnected', () => setStatus('Desconectado del servicio Peer'));
  peer.on('error', err => {
    console.error('Peer error', err);
    const msg = (err && (err.type || err.message)) ? (err.type || err.message) : String(err);
    const conflict = String(msg).toLowerCase().includes('unavailable-id') ||
      String(msg).toLowerCase().includes('taken') ||
      String(msg).toLowerCase().includes('in use') ||
      String(msg).toLowerCase().includes('already connected');

    if (conflict && maxRetries > 0) {
      addSystem('ID en uso, generando otro ID...');
      setTimeout(() => createPeerWithRandomId(maxRetries - 1), 260);
      return;
    }
    addSystem('Peer error: ' + (err && err.message ? err.message : String(err)));
  });
}
function initPeer() {
  try { if (peer && !peer.destroyed) peer.destroy(); } catch (e) { /* ignore */ }
  createPeerWithRandomId(3);
}

/* ---------------------------- Connection binding ---------------------------- */
function bindConnection(c) {
  conn = c;
  currentPeerId = c.peer;
  if (peerIdInput) peerIdInput.value = currentPeerId;
  if (connectBtn) connectBtn.hidden = true;
  if (disconnectBtn) disconnectBtn.hidden = false;
  setStatus('Conectado con ' + currentPeerId);

  loadHistory(currentPeerId);
  renderMessages();

  c.on('data', handleIncoming);
  c.on('open', () => {
    e2eeReset();
    e2eeStartHandshake().catch(() => { /* ignore */ });
    safeSend({ type: 'init', id: peer.id });
    safeSend({ type: 'sync_request' });
  });
  c.on('close', () => {
    addSystem('La conexión se cerró');
    resetConnection();
  });
  c.on('error', err => { console.error('conn err', err); addSystem('Error en la conexión'); });
}

/* ---------------------------- Connect / reset ---------------------------- */
function connectToPeer(id) {
  if (!peer || peer.disconnected) initPeer();
  if (!id) return;
  const c = peer.connect(id, { reliable: true });
  c.on('open', () => bindConnection(c));
  c.on('error', err => { console.error(err); addSystem('Error de conexión'); });
}
function resetConnection() {
  if (conn) {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
  e2eeReset();
  conn = null; currentPeerId = null;
  if (connectBtn) connectBtn.hidden = false;
  if (disconnectBtn) disconnectBtn.hidden = true;
  if (peerIdInput) peerIdInput.value = '';
  setStatus('Desconectado');
}

/* ---------------------------- Messaging core ---------------------------- */
function handleIncoming(msg) {
  if (!msg) return;
  // Anti‑downgrade: si E2EE es requerida, no aceptamos tráfico en claro.
  if (E2EE.enabled && E2EE.require && !msg.__e2ee && msg.type !== 'kex1' && msg.type !== 'e2ee') {
    addSystem('⛔ Se recibió un mensaje SIN cifrar mientras E2EE es requerida. Rechazando conexión.');
    try { if (conn) conn.close(); } catch (_) {}
    resetConnection();
    return;
  }
  // --- E2EE envelope / handshake ---
  if (msg.type === 'kex1') { e2eeHandleKex1(msg); return; }
  if (msg.type === 'e2ee') { e2eeHandleEnvelope(msg); return; }
  switch (msg.type) {
    case 'init':
      if (peerIdInput) peerIdInput.value = msg.id;
      addSystem('Conectado con ' + msg.id);
      break;
    case 'typing':
      if (msg.state === 'start') showTyping(true);
      else showTyping(false);
      break;
    case 'message':
      safeSend({ type: 'ack', id: msg.id });
      addRemoteMessage(msg);
      break;
    case 'ack':
      markMessageStatus(msg.id, 'delivered');
      break;
    case 'read':
      markMessageStatus(msg.id, 'read');
      break;
    case 'file':
      addFileMessage(msg, false);
      safeSend({ type: 'ack', id: msg.id });
      break;
    case 'file-chunk':
      handleIncomingChunk(msg);
      break;
    case 'sync_request': {
      const ids = messageHistory.filter(m => m.me && (m.status === 'sending' || m.status === 'sent')).map(m => m.id);
      safeSend({ type: 'sync_response', ids });
      break;
    }
    case 'sync_response':
      if (Array.isArray(msg.ids)) msg.ids.forEach(id => markMessageStatus(id, 'delivered'));
      break;
    case 'system':
      if (msg.cmd === 'reload') {
        addSystem('El par ha solicitado recargar la página. Recargando...');
        setTimeout(() => {
          try { if (peer) peer.destroy(); } catch (e) { }
          location.reload();
        }, 140);
      } else {
        addSystem(msg.text || JSON.stringify(msg));
      }
      break;
    default:
      console.log('unknown', msg);
  }
}
function safeSend(obj) {
  if (!conn || conn.open === false) { addSystem('No hay conexión abierta'); return false; }

  // E2EE: ciframos TODO lo que no sea handshake.
  if (E2EE.enabled) {
    if (!e2eeAvailable()) {
      addSystem('⛔ E2EE requiere HTTPS (contexto seguro).');
      if (E2EE.require) {
        try { if (conn) conn.close(); } catch (_) {}
        resetConnection();
        return false;
      }
      E2EE.enabled = false;
      try { conn.send(obj); return true; } catch (e) { console.error(e); addSystem('Fallo al enviar'); return false; }
    }

    // bootstrap si aún no arrancó
    if (!E2EE.started) { e2eeStartHandshake().catch(() => { /* ignore */ }); }

    // handshake explícito sin cifrar
    if (e2eeShouldBypass(obj)) {
      try { conn.send(obj); return true; } catch (e) { console.error(e); addSystem('Fallo al enviar'); return false; }
    }

    // si la llave aún no está lista, ponemos en cola; el timeout del handshake corta si falla
    if (!E2EE.ready) {
      E2EE.sendQueue.push(obj);
      return true;
    }

    // enviar cifrado (async)
    e2eeSendEncryptedNow(obj);
    return true;
  }

  try { conn.send(obj); return true; } catch (e) { console.error(e); addSystem('Fallo al enviar'); return false; }
}

/* ---------------------------- History helpers ---------------------------- */
function pushMessageToHistory(obj) {
  messageHistory.push(obj);
  saveHistory(currentPeerId || null);
}
function markMessageStatus(id, status) {
  const m = messageHistory.find(x => x.id === id);
  if (!m) return;
  m.status = status;
  saveHistory(currentPeerId || null);
  const dom = messagesEl.querySelector(`[data-msgid="${id}"]`);
  if (dom) {
    const small = dom.querySelector('small');
    if (small && m.me) small.textContent = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + (m.status || '');
  }
}

/* ---------------------------- Render (history fallback) ---------------------------- */
function renderMessages() {
  messagesEl.innerHTML = '';
  for (const m of messageHistory) {
    if (m.meta && m.meta.fileTransfer) {
      renderFileProgressCardFromEntry(m);
      continue;
    }
    if (m.meta && m.meta.file) {
      renderFileCardFromEntry(m);
      continue;
    }
    const wrap = document.createElement('div');
    wrap.className = 'message ' + (m.me ? 'out' : 'in');
    wrap.setAttribute('data-msgid', m.id);

    const body = document.createElement('div');
    body.className = 'message-body';
    const span = document.createElement('span');
    span.className = 'stream-text';
    span.textContent = m.text || '';
    body.appendChild(span);
    wrap.appendChild(body);

    const meta = document.createElement('small');
    meta.style.display = 'block';
    meta.style.marginTop = '8px';
    meta.style.color = 'var(--meta-color)';
    meta.textContent = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (m.me) meta.textContent += ' · ' + (m.status || '');
    wrap.appendChild(meta);

    messagesEl.appendChild(wrap);
  }
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* ---------------------------- Animations: typewriter / streaming ---------------------------- */
function typeText(spanEl, text, speed = 18) {
  return new Promise((resolve) => {
    spanEl.textContent = '';
    let i = 0;
    const total = text.length;
    const adaptive = Math.max(6, speed - Math.floor(total / 150));
    const iv = setInterval(() => {
      spanEl.textContent += text.charAt(i);
      i++;
      messagesArea.scrollTop = messagesArea.scrollHeight;
      if (i >= total) {
        clearInterval(iv);
        resolve();
      }
    }, adaptive);
  });
}
function createBubbleDOM({ text = '', me = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'message ' + (me ? 'out' : 'in');
  wrap.style.opacity = '0.995';

  const body = document.createElement('div');
  body.className = 'message-body';
  const textSpan = document.createElement('span');
  textSpan.className = 'stream-text';
  body.appendChild(textSpan);
  wrap.appendChild(body);

  const meta = document.createElement('small');
  meta.style.display = 'block';
  meta.style.marginTop = '8px';
  meta.style.color = 'var(--meta-color)';
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.appendChild(meta);

  messagesEl.appendChild(wrap);
  messagesArea.scrollTop = messagesArea.scrollHeight;
  return { wrap, textSpan, meta };
}
async function animateIncomingMessage(msg) {
  showTyping(false);
  const { wrap, textSpan, meta } = createBubbleDOM({ me: false });
  await new Promise(r => setTimeout(r, 220));
  await typeText(textSpan, msg.text || '', 16);

  const id = msg.id || genMessageId();
  wrap.setAttribute('data-msgid', id);
  meta.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (!messageHistory.some(m => m.id === id && !m.me)) {
    pushMessageToHistory({ id, text: msg.text, ts: msg.ts || Date.now(), me: false, status: 'received' });
  } else {
    saveHistory(currentPeerId || null);
  }
  try {
    wrap.animate([{ transform: 'translateY(6px)', opacity: 0.92 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.9,.2,1)' });
  } catch (e) { /* ignore */ }

  messagesArea.scrollTop = messagesArea.scrollHeight;
}
async function animateLocalMessage(text, id) {
  const { wrap, textSpan, meta } = createBubbleDOM({ me: true });
  wrap.style.color = '#02221a';
  await typeText(textSpan, text, 12);

  const msgId = id || genMessageId();
  wrap.setAttribute('data-msgid', msgId);
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (!messageHistory.some(m => m.id === msgId)) {
    pushMessageToHistory({ id: msgId, text, ts: Date.now(), me: true, status: 'sending' });
  } else {
    saveHistory(currentPeerId || null);
  }

  try {
    wrap.animate([{ transform: 'scale(.98)', opacity: 0.96 }, { transform: 'scale(1)', opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.2,.9,.2,1)' });
  } catch (e) { /* ignore */ }

  messagesArea.scrollTop = messagesArea.scrollHeight;
  return msgId;
}

/* ---------------------------- Send / Receive flows ---------------------------- */
function sendMessage() {
  const text = (messageInput && messageInput.value) ? messageInput.value.trim() : '';
  if (!text) return;
  const id = genMessageId();

  animateLocalMessage(text, id).catch(() => { /* ignore */ });

  const msg = { id, type: 'message', text, ts: Date.now() };
  const ok = safeSend(msg);
  if (ok) {
    const existing = messageHistory.find(m => m.id === id);
    if (existing) existing.status = 'sent';
    saveHistory(currentPeerId || null);
  } else {
    const existing = messageHistory.find(m => m.id === id);
    if (existing) existing.status = 'failed';
    saveHistory(currentPeerId || null);
  }

  if (messageInput) {
    messageInput.value = '';
    autosizeTextarea(messageInput);
  }
  sendTypingState('stop');
}
function addRemoteMessage(msg) {
  if (messageHistory.some(m => m.id === msg.id && !m.me)) {
    renderMessages();
    return;
  }
  animateIncomingMessage(msg).catch(e => {
    pushMessageToHistory({ id: msg.id || genMessageId(), text: msg.text, ts: msg.ts || Date.now(), me: false, status: 'received' });
    renderMessages();
  });
}

/* ---------------------------- File helpers & rendering (with downloadable links) ---------------------------- */

/* Convert dataURL to objectURL via fetch -> Blob; returns Promise<string> */
async function createBlobUrlFromDataUrl(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    return url;
  } catch (err) {
    console.warn('createBlobUrlFromDataUrl failed, returning dataUrl fallback', err);
    return dataUrl;
  }
}

/* human-readable size */
function formatSize(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let val = n;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return (val < 10 && i > 0 ? val.toFixed(1) : Math.round(val)) + ' ' + units[i];
}

/* Render a file-card entry and make the name a downloadable/viewable link */
async function renderFileCardFromEntry(entry) {
  const obj = entry.meta && entry.meta.file ? entry.meta.file : null;
  if (!obj) return;
  const id = entry.id || genMessageId();

  const card = document.createElement('div');
  card.className = 'file-card ' + (entry.me ? 'out' : 'in');
  card.setAttribute('data-msgid', id);
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `Archivo: ${obj.name || 'archivo'} (${formatSize(obj.size || 0)})`);

  // prepare objectURL if possible
  let objectUrlPromise = null;
  if (obj.dataUrl) objectUrlPromise = createBlobUrlFromDataUrl(obj.dataUrl);

  if (obj.mime && obj.mime.startsWith('image/') && obj.dataUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'file-thumb';
    thumb.alt = obj.name || 'Imagen';
    thumb.src = obj.dataUrl; // immediate preview

    if (objectUrlPromise) {
      objectUrlPromise.then(url => {
        thumb.addEventListener('click', () => {
          const w = window.open('');
          w.document.write(`<body style="background:#001224;margin:0;display:flex;align-items:center;justify-content:center;height:100vh;"><img src="${url}" style="max-width:100%;height:auto;box-shadow:0 12px 40px rgba(0,0,0,0.6)"/></body>`);
        });
        // revoke after some time
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { } }, 60000);
      }).catch(() => {
        thumb.addEventListener('click', () => window.open(obj.dataUrl, '_blank'));
      });
    } else {
      thumb.addEventListener('click', () => window.open(obj.dataUrl, '_blank'));
    }
    card.appendChild(thumb);
  } else {
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = obj.name ? obj.name.slice(0, 2).toUpperCase() : 'F';
    card.appendChild(icon);
  }

  const metaCol = document.createElement('div');
  metaCol.className = 'file-meta';

  const nameEl = document.createElement('a');
  nameEl.className = 'file-name';
  nameEl.textContent = obj.name || 'Archivo';
  nameEl.href = '#';
  nameEl.target = '_blank';
  nameEl.rel = 'noopener noreferrer';
  nameEl.style.textDecoration = 'none';
  nameEl.style.color = 'inherit';
  nameEl.setAttribute('role', 'link');

  if (obj.dataUrl) {
    if (objectUrlPromise) {
      objectUrlPromise.then(url => {
        try {
          nameEl.href = url;
          nameEl.download = obj.name || '';
          nameEl.addEventListener('click', () => {
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { } }, 30000);
          }, { once: true });
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { } }, 60000);
        } catch (e) {
          nameEl.href = obj.dataUrl;
        }
      }).catch(() => {
        nameEl.href = obj.dataUrl;
      });
    } else {
      nameEl.href = obj.dataUrl;
    }
  } else {
    nameEl.href = '#';
    nameEl.addEventListener('click', (ev) => {
      ev.preventDefault();
      addSystem('Contenido no disponible para descarga en este archivo.');
    });
  }

  const sizeEl = document.createElement('div');
  sizeEl.className = 'file-size';
  sizeEl.textContent = formatSize(obj.size || 0);

  metaCol.appendChild(nameEl);
  metaCol.appendChild(sizeEl);
  card.appendChild(metaCol);

  messagesEl.appendChild(card);
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* addFileMessage pushes to history and renders via renderFileCardFromEntry */
function addFileMessage(obj, me) {
  const id = obj.id || genMessageId();
  if (messageHistory.some(m => m.id === id && m.meta && m.meta.file)) return;

  const entry = {
    id,
    text: obj.name || 'Archivo',
    ts: Date.now(),
    me: !!me,
    status: me ? 'sent' : 'received',
    meta: { file: obj }
  };
  pushMessageToHistory(entry);
  renderFileCardFromEntry(entry);
}


/* Render a receiving file progress card (chunked incoming files) */
function renderFileProgressCardFromEntry(entry) {
  const ft = entry.meta && entry.meta.fileTransfer ? entry.meta.fileTransfer : null;
  if (!ft) return;

  const card = document.createElement('div');
  card.className = 'file-card in';
  card.setAttribute('data-msgid', entry.id);
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', `Recibiendo archivo: ${ft.name || 'archivo'}`);

  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.textContent = ft.name ? ft.name.slice(0, 2).toUpperCase() : 'F';
  card.appendChild(icon);

  const metaCol = document.createElement('div');
  metaCol.className = 'file-meta';

  const nameEl = document.createElement('div');
  nameEl.className = 'file-name';
  nameEl.textContent = ft.name || 'Archivo';
  nameEl.style.fontWeight = '600';
  metaCol.appendChild(nameEl);

  const pct = ft.total ? Math.min(100, Math.floor((ft.received || 0) * 100 / ft.total)) : 0;
  const approxBytes = (ft.size && ft.total) ? Math.min(ft.size, Math.round(ft.size * ((ft.received || 0) / ft.total))) : 0;

  const textEl = document.createElement('div');
  textEl.className = 'file-size file-progress-text';
  textEl.textContent = ft.size ? `${pct}% · ${formatSize(approxBytes)} / ${formatSize(ft.size)}` : `${pct}%`;
  metaCol.appendChild(textEl);

  const bar = document.createElement('div');
  bar.className = 'file-progress';
  bar.style.height = '8px';
  bar.style.borderRadius = '999px';
  bar.style.overflow = 'hidden';
  bar.style.marginTop = '8px';
  bar.style.background = 'rgba(255,255,255,0.25)';

  const fill = document.createElement('div');
  fill.className = 'file-progress-fill';
  fill.style.height = '100%';
  fill.style.width = pct + '%';
  fill.style.background = 'rgba(0,0,0,0.28)';
  fill.style.transition = 'width 120ms linear';

  bar.appendChild(fill);
  metaCol.appendChild(bar);

  card.appendChild(metaCol);
  messagesEl.appendChild(card);
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

function updateFileProgressDOM(fileId, received, total, size) {
  const card = messagesEl.querySelector(`[data-msgid="${fileId}"]`);
  if (!card) return false;
  const fill = card.querySelector('.file-progress-fill');
  const textEl = card.querySelector('.file-progress-text');
  const pct = total ? Math.min(100, Math.floor(received * 100 / total)) : 0;
  const approxBytes = (size && total) ? Math.min(size, Math.round(size * (received / total))) : 0;
  if (fill) fill.style.width = pct + '%';
  if (textEl) textEl.textContent = size ? `${pct}% · ${formatSize(approxBytes)} / ${formatSize(size)}` : `${pct}%`;
  return true;
}

function ensureIncomingFileProgressEntry(fileId, meta, total) {
  if (messageHistory.some(m => m.id === fileId && m.meta && m.meta.fileTransfer)) return;
  const entry = {
    id: fileId,
    text: meta.name || 'Archivo',
    ts: Date.now(),
    me: false,
    status: 'receiving',
    meta: { fileTransfer: { name: meta.name, mime: meta.mime, size: meta.size, received: 0, total: total || 0 } }
  };
  messageHistory.push(entry);
  saveHistory(currentPeerId || null);
  renderMessages();
}

/* ---------------------------- Chunked transfer (receiver) ---------------------------- */
const incomingChunks = {}; // fileId -> {meta, parts: []}
function handleIncomingChunk(msg) {
  const fileId = msg.fileId;
  if (!fileId) return;

  // init state + UI placeholder (once)
  if (!incomingChunks[fileId]) {
    incomingChunks[fileId] = {
      meta: { name: msg.name, mime: msg.mime, size: msg.size, total: msg.total },
      parts: new Array(msg.total),
      received: 0
    };
    ensureIncomingFileProgressEntry(fileId, incomingChunks[fileId].meta, msg.total);
  }

  const st = incomingChunks[fileId];

  // store part (avoid double counting)
  if (st.parts[msg.index] == null) {
    st.parts[msg.index] = msg.data;
    st.received++;
  }

  // update progress UI (fast path: DOM update only)
  updateFileProgressDOM(fileId, st.received, msg.total, st.meta.size);

  // completion
  if (st.received === msg.total) {
    const full = st.parts.join('');
    const dataUrl = full.startsWith('data:') ? full : ('data:' + (msg.mime || 'application/octet-stream') + ';base64,' + full);

    // replace placeholder entry in history with the real file entry (keeps same id = fileId)
    const fileObj = { type: 'file', id: fileId, name: msg.name, mime: msg.mime, size: msg.size, dataUrl };
    const idx = messageHistory.findIndex(m => m.id === fileId && m.meta && m.meta.fileTransfer);
    if (idx >= 0) {
      messageHistory[idx] = {
        id: fileId,
        text: msg.name || 'Archivo',
        ts: Date.now(),
        me: false,
        status: 'received',
        meta: { file: fileObj }
      };
      saveHistory(currentPeerId || null);
      renderMessages();
    } else {
      addFileMessage(fileObj, false);
    }

    delete incomingChunks[fileId];
    safeSend({ type: 'ack', id: fileId });
  }
}


/* ---------------------------- Read receipts ---------------------------- */
function requestReadReceipt(messageId) {
  if (!conn || !conn.open) return;
  safeSend({ type: 'read', id: messageId });
}

/* ---------------------------- Typing indicator ---------------------------- */
function showTyping(show) {
  if (!typingIndicator) return;
  typingIndicator.hidden = !show;
}
function sendTypingState(state) {
  if (!conn || conn.open === false) return;
  safeSend({ type: 'typing', state });
}

/* ---------------------------- Autosize textarea & input handling ---------------------------- */
function autosizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  const max = Math.round(window.innerHeight * 0.4);
  el.style.height = Math.min(el.scrollHeight, max) + 'px';
}
if (messageInput) autosizeTextarea(messageInput);

if (messageInput) {
  messageInput.addEventListener('input', (e) => {
    autosizeTextarea(e.target);
    if (conn && conn.open) safeSend({ type: 'typing', state: 'start' });
    if (messageInput._typingTimeout) clearTimeout(messageInput._typingTimeout);
    messageInput._typingTimeout = setTimeout(() => {
      if (conn && conn.open) safeSend({ type: 'typing', state: 'stop' });
    }, 900);
  });

  messageInput.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
      setTimeout(() => { messageInput.focus(); autosizeTextarea(messageInput); }, 20);
    }
  });
}

/* ---------------------------- File attach handling (sender) ---------------------------- */
if (attachBtn) attachBtn.addEventListener('click', () => fileInput.click());
if (fileInput) fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = function (ev) {
    const dataUrl = ev.target.result;
    if (f.size <= CHUNK_SIZE) {
      const obj = { type: 'file', id: genMessageId(), name: f.name, mime: f.type, size: f.size, dataUrl };
      addFileMessage(obj, true);
      safeSend(obj);
    } else {
      const b64 = dataUrl.split(',')[1];
      const approxChunkSize = Math.floor(CHUNK_SIZE * 1.33);
      const total = Math.ceil(b64.length / approxChunkSize);
      const fileId = genMessageId();
      for (let i = 0; i < total; i++) {
        const start = i * approxChunkSize;
        const part = b64.slice(start, start + approxChunkSize);
        safeSend({ type: 'file-chunk', fileId, index: i, total, name: f.name, mime: f.type, size: f.size, data: part });
      }
      const obj = { id: fileId, text: f.name, ts: Date.now(), me: true, status: 'sending', meta: { file: { name: f.name, size: f.size, mime: f.type } } };
      pushMessageToHistory(obj);
      renderMessages();
    }
  };
  reader.readAsDataURL(f);
  fileInput.value = '';
});

/* ---------------------------- UI events: connect/disconnect/send ---------------------------- */
if (connectBtn) connectBtn.addEventListener('click', () => {
  const id = peerIdInput.value.trim();
  if (!id) return;
  connectToPeer(id);
});

if (disconnectBtn) disconnectBtn.addEventListener('click', () => {
  if (conn && conn.open) {
    try { safeSend({ type: 'system', cmd: 'reload' }); } catch (e) { console.warn('no se pudo enviar reload', e); }
  }
  setTimeout(() => {
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
    location.reload();
  }, 150);
});

if (sendBtn) sendBtn.addEventListener('click', () => {
  sendMessage();
  setTimeout(() => { if (messageInput) { messageInput.focus(); autosizeTextarea(messageInput); } }, 20);
});

if (messagesArea) messagesArea.addEventListener('click', () => { if (messageInput) messageInput.focus(); });

window.addEventListener('beforeunload', () => { try { if (peer) peer.destroy(); } catch (e) { } });

/* ---------------------------- Initialize ---------------------------- */
initPeer();

/* ---------------------------- End of chat.js ---------------------------- */

