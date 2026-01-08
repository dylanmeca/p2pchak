/* chat.js — p2pchat completo
   - PeerJS P2P
   - ID propio de 5 caracteres (alfanumérico mayúsculas+digitos)
   - reintentos si el ID está en uso
   - mensajes: ack, read, sync
   - historial localStorage por par
   - archivos (dataURL y chunks)
   - animaciones: typing wave y streaming/typewriter para mensajes
   - al desconectar: envio de comando reload y recarga local/remota
*/

/* ---------------------------- selectors ---------------------------- */
const myIdEl = document.getElementById('myId');
const peerIdInput = document.getElementById('peerIdInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusText = document.getElementById('statusText');
const messagesEl = document.getElementById('messages');
const messagesArea = document.getElementById('messagesArea');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const typingIndicator = document.getElementById('typingIndicator');

let peer = null;
let conn = null;
let currentPeerId = null;
let typingSendDebounce = null;
let messageHistory = []; // {id, text, ts, me, status, meta}

const HISTORY_PREFIX = 'p2pchat_history_';
const CHUNK_SIZE = 512 * 1024; // 512KB

/* ---------------------------- util IDs ---------------------------- */
/* genera ID para Peer (5 chars, alfanum, MAYÚSCULAS y dígitos) */
function generatePeerId() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}
/* id para mensajes (único, más largo) */
function genMessageId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/* ---------------------------- storage ---------------------------- */
function loadHistory(peerId) {
  const key = HISTORY_PREFIX + (peerId || 'local');
  try {
    const raw = localStorage.getItem(key);
    messageHistory = raw ? JSON.parse(raw) : [];
  } catch (e) {
    messageHistory = [];
  }
}
function saveHistory(peerId) {
  const key = HISTORY_PREFIX + (peerId || 'local');
  try { localStorage.setItem(key, JSON.stringify(messageHistory)); } catch (e) { /* ignore */ }
}

/* ---------------------------- UI helpers ---------------------------- */
function setStatus(text) { statusText.textContent = text; }
function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'message in';
  el.style.opacity = 0.75;
  el.style.fontSize = '13px';
  el.style.background = 'transparent';
  el.style.border = '0';
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* ---------------------------- Peer creation with retry ---------------------------- */
function createPeerWithRandomId(maxRetries = 3) {
  const desiredId = generatePeerId();
  try { if (peer && typeof peer.destroy === 'function') peer.destroy(); } catch (e) { }
  peer = new Peer(desiredId);

  peer.on('open', id => {
    myIdEl.textContent = id;
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
  peerIdInput.value = currentPeerId;
  connectBtn.hidden = true;
  disconnectBtn.hidden = false;
  setStatus('Conectado con ' + currentPeerId);

  // cargar historial y mostrar
  loadHistory(currentPeerId);
  renderMessages();

  c.on('data', handleIncoming);
  c.on('open', () => {
    // sincronizar: enviar init y pedir sync
    safeSend({ type: 'init', id: peer.id });
    safeSend({ type: 'sync_request' });
  });
  c.on('close', () => {
    addSystem('La conexión se cerró');
    resetConnection();
  });
  c.on('error', err => { console.error('conn err', err); addSystem('Error en la conexión'); });
}

/* ---------------------------- Connection helpers ---------------------------- */
function connectToPeer(id) {
  if (!peer || peer.disconnected) initPeer();
  if (!id) return;
  const c = peer.connect(id, { reliable: true });
  c.on('open', () => bindConnection(c));
  c.on('error', err => { console.error(err); addSystem('Error de conexión') });
}

function resetConnection() {
  if (conn) {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
  conn = null; currentPeerId = null;
  connectBtn.hidden = false; disconnectBtn.hidden = true;
  peerIdInput.value = '';
  setStatus('Desconectado');
}

/* ---------------------------- Message handling ---------------------------- */
function handleIncoming(msg) {
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      peerIdInput.value = msg.id; addSystem('Conectado con ' + msg.id);
      break;
    case 'typing':
      if (msg.state === 'start') showTyping(true);
      else showTyping(false);
      break;
    case 'message':
      // enviar ack inmediato para confirmar recepción
      safeSend({ type: 'ack', id: msg.id });
      // animar y guardar
      addRemoteMessage(msg);
      break;
    case 'ack':
      markMessageStatus(msg.id, 'delivered');
      break;
    case 'read':
      markMessageStatus(msg.id, 'read');
      break;
    case 'file':
      // archivo pequeño
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
      // comandos remotos
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

/* safe send por datachannel */
function safeSend(obj) {
  if (!conn || conn.open === false) { addSystem('No hay conexión abierta'); return false; }
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
  // actualizar vista si el mensaje ya está presente
  const dom = messagesEl.querySelector(`[data-msgid="${id}"]`);
  if (dom) {
    const small = dom.querySelector('small');
    if (small && m.me) small.textContent = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + (m.status || '');
  }
}

/* ---------------------------- Render full history (fallback / load) ---------------------------- */
function renderMessages() {
  messagesEl.innerHTML = '';
  for (const m of messageHistory) {
    const wrap = document.createElement('div');
    wrap.className = 'message ' + (m.me ? 'out' : 'in');
    wrap.setAttribute('data-msgid', m.id);

    if (m.meta && m.meta.file && m.meta.file.dataUrl && m.meta.file.mime && m.meta.file.mime.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = m.meta.file.dataUrl;
      img.style.maxWidth = '420px';
      wrap.appendChild(img);
    } else {
      const p = document.createElement('div');
      p.className = 'message-body';
      p.innerText = m.text || '';
      wrap.appendChild(p);
    }

    const meta = document.createElement('small');
    meta.style.display = 'block';
    meta.style.marginTop = '8px';
    meta.style.color = 'var(--text-muted)';
    meta.textContent = new Date(m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (m.me) meta.textContent += ' · ' + (m.status || '');
    wrap.appendChild(meta);

    messagesEl.appendChild(wrap);
  }
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* ---------------------------- Animations: typewriter / streaming ---------------------------- */
/* escribe texto carácter a carácter dentro de un span */
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

/* crea DOM de burbuja animada y la retorna */
function createBubbleDOM({ text = '', me = false }) {
  const wrap = document.createElement('div');
  wrap.className = 'message ' + (me ? 'out' : 'in');
  wrap.style.opacity = '0.995';
  // body con span para streaming
  const body = document.createElement('div');
  body.className = 'message-body';
  const textSpan = document.createElement('span');
  textSpan.className = 'stream-text';
  body.appendChild(textSpan);
  wrap.appendChild(body);

  const meta = document.createElement('small');
  meta.style.display = 'block';
  meta.style.marginTop = '8px';
  meta.style.color = 'var(--text-muted)';
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  wrap.appendChild(meta);

  messagesEl.appendChild(wrap);
  messagesArea.scrollTop = messagesArea.scrollHeight;
  return { wrap, textSpan, meta };
}

/* animar entrada entrante (typewriter) */
async function animateIncomingMessage(msg) {
  // ocultar typing global
  showTyping(false);

  const { wrap, textSpan, meta } = createBubbleDOM({ me: false });
  // pequeña pausa natural
  await new Promise(r => setTimeout(r, 220));
  // typewriter
  await typeText(textSpan, msg.text || '', 16);

  // después de escribir, asignar id y actualizar estado visual
  const id = msg.id || genMessageId();
  wrap.setAttribute('data-msgid', id);
  meta.textContent = new Date(msg.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // añadir al historial si no existe
  if (!messageHistory.some(m => m.id === id && !m.me)) {
    pushMessageToHistory({ id, text: msg.text, ts: msg.ts || Date.now(), me: false, status: 'received' });
  } else {
    // si existe en history, actualizar posibles cambios
    saveHistory(currentPeerId || null);
  }

  // ligera animación de aparición
  try {
    wrap.animate([{ transform: 'translateY(6px)', opacity: 0.92 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,.9,.2,1)' });
  } catch (e) { /* ignore animation errors */ }

  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* animar mensaje local (streaming) */
async function animateLocalMessage(text, id) {
  const { wrap, textSpan, meta } = createBubbleDOM({ me: true });
  // cambiar color del texto para burbuja clara
  wrap.style.color = '#02221a';
  await typeText(textSpan, text, 12);

  // asignar id y meta
  const msgId = id || genMessageId();
  wrap.setAttribute('data-msgid', msgId);
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // añadir al historial si no existe
  if (!messageHistory.some(m => m.id === msgId)) {
    pushMessageToHistory({ id: msgId, text, ts: Date.now(), me: true, status: 'sending' });
  } else {
    saveHistory(currentPeerId || null);
  }

  // pop animation
  try {
    wrap.animate([{ transform: 'scale(.98)', opacity: 0.96 }, { transform: 'scale(1)', opacity: 1 }], { duration: 200, easing: 'cubic-bezier(.2,.9,.2,1)' });
  } catch (e) { /* ignore */ }

  messagesArea.scrollTop = messagesArea.scrollHeight;
  return msgId;
}

/* ---------------------------- Message send / receive flows ---------------------------- */
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  const id = genMessageId();

  // animación local (no bloqueante)
  animateLocalMessage(text, id).catch(() => { /* ignore */ });

  const msg = { id, type: 'message', text, ts: Date.now() };
  const ok = safeSend(msg);
  if (ok) {
    // marcar status en history (si fue añadida por animation)
    const existing = messageHistory.find(m => m.id === id);
    if (existing) existing.status = 'sent';
    saveHistory(currentPeerId || null);
  } else {
    // marcar fallo (opcional)
    const existing = messageHistory.find(m => m.id === id);
    if (existing) existing.status = 'failed';
    saveHistory(currentPeerId || null);
  }

  messageInput.value = '';
  sendTypingState('stop');
}

function addRemoteMessage(msg) {
  // evitar duplicados
  if (messageHistory.some(m => m.id === msg.id && !m.me)) {
    // si ya está en history, quizás renderizarlo si no visible
    renderMessages();
    return;
  }
  // animar llegada y persistir (animateIncomingMessage hace pushHistory)
  animateIncomingMessage(msg).catch(e => {
    // fallback: persistir sin animación
    pushMessageToHistory({ id: msg.id || genMessageId(), text: msg.text, ts: msg.ts || Date.now(), me: false, status: 'received' });
    renderMessages();
  });
}

/* ---------------------------- File handling ---------------------------- */
/* Reemplaza la función addFileMessage en chat.js por esta */
function addFileMessage(obj, me) {
  // obj: {type:'file', id, name, mime, size, dataUrl}
  const id = obj.id || genMessageId();

  // evitar duplicados en history
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

  // crear file-card
  const card = document.createElement('div');
  card.className = 'file-card ' + (me ? 'out' : 'in');
  card.setAttribute('data-msgid', id);

  // icon / thumb container
  const icon = document.createElement('div');
  icon.className = 'file-icon';
  // si es imagen, mostraremos thumb en vez de icon
  if (obj.mime && obj.mime.startsWith('image/') && obj.dataUrl) {
    const thumb = document.createElement('img');
    thumb.className = 'file-thumb';
    thumb.src = obj.dataUrl;
    thumb.alt = obj.name || 'Imagen';
    card.appendChild(thumb);
  } else {
    icon.textContent = obj.name ? obj.name.slice(0,2).toUpperCase() : 'F';
    card.appendChild(icon);
  }

  // metadata
  const metaCol = document.createElement('div');
  metaCol.className = 'file-meta';
  const nameEl = document.createElement('div');
  nameEl.className = 'file-name';
  nameEl.textContent = obj.name || 'Archivo';
  const sizeEl = document.createElement('div');
  sizeEl.className = 'file-size';
  // convertir bytes a legible
  function hsize(n){
    if(!n && n !== 0) return '';
    const units = ['B','KB','MB','GB'];
    let i=0; let val = n;
    while(val >= 1024 && i < units.length-1){ val/=1024; i++; }
    return val.toFixed(val<10 && i>0 ? 1 : 0) + ' ' + units[i];
  }
  sizeEl.textContent = hsize(obj.size || 0);

  metaCol.appendChild(nameEl);
  metaCol.appendChild(sizeEl);

  card.appendChild(metaCol);
  messagesEl.appendChild(card);
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

/* ---------------------------- Chunked transfer (receptor) ---------------------------- */
const incomingChunks = {}; // fileId -> {meta, parts: []}
function handleIncomingChunk(msg) {
  // msg: {type:'file-chunk', fileId, index, total, name, mime, size, data}
  const fileId = msg.fileId;
  if (!incomingChunks[fileId]) incomingChunks[fileId] = { meta: { name: msg.name, mime: msg.mime, size: msg.size }, parts: [] };
  incomingChunks[fileId].parts[msg.index] = msg.data;
  const parts = incomingChunks[fileId].parts;
  if (parts.filter(Boolean).length === msg.total) {
    const full = parts.join('');
    const dataUrl = full.startsWith('data:') ? full : ('data:' + msg.mime + ';base64,' + full);
    const fileObj = { type: 'file', id: genMessageId(), name: msg.name, mime: msg.mime, size: msg.size, dataUrl };
    addFileMessage(fileObj, false);
    delete incomingChunks[fileId];
    safeSend({ type: 'ack', id: fileObj.id });
  }
}

/* ---------------------------- Read receipts ---------------------------- */
function requestReadReceipt(messageId) {
  if (!conn || !conn.open) return;
  safeSend({ type: 'read', id: messageId });
}

/* ---------------------------- typing state ---------------------------- */
function showTyping(show) {
  if (!typingIndicator) return;
  typingIndicator.hidden = !show;
}
function sendTypingState(state) {
  if (!conn || conn.open === false) return;
  safeSend({ type: 'typing', state });
}

/* ---------------------------- UI events ---------------------------- */
connectBtn.addEventListener('click', () => {
  const id = peerIdInput.value.trim();
  if (!id) return;
  connectToPeer(id);
});

/* Desconectar: envía comando reload al par (si hay) y recarga local */
disconnectBtn.addEventListener('click', () => {
  if (conn && conn.open) {
    try { conn.send({ type: 'system', cmd: 'reload' }); } catch (e) { console.warn('no se pudo enviar reload', e); }
  }
  // esperar un pelín para que el mensaje salga
  setTimeout(() => {
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
    location.reload();
  }, 150);
});

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  // typing debounced
  if (typingSendDebounce) clearTimeout(typingSendDebounce);
  if (conn && conn.open) safeSend({ type: 'typing', state: 'start' });
  typingSendDebounce = setTimeout(() => {
    if (conn && conn.open) safeSend({ type: 'typing', state: 'stop' });
  }, 900);
});

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
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
      // enviar por chunks (base64)
      const b64 = dataUrl.split(',')[1];
      const approxChunkSize = Math.floor(CHUNK_SIZE * 1.33);
      const total = Math.ceil(b64.length / approxChunkSize);
      const fileId = genMessageId();
      for (let i = 0; i < total; i++) {
        const start = i * approxChunkSize;
        const part = b64.slice(start, start + approxChunkSize);
        safeSend({ type: 'file-chunk', fileId, index: i, total, name: f.name, mime: f.type, size: f.size, data: part });
      }
      // entrada local optimista
      const obj = { id: fileId, text: f.name, ts: Date.now(), me: true, status: 'sending', meta: { file: { name: f.name, size: f.size, mime: f.type } } };
      pushMessageToHistory(obj);
      renderMessages();
    }
  };
  reader.readAsDataURL(f);
  fileInput.value = '';
});

attachBtn.addEventListener('keydown', e => { if (e.key === 'Enter') fileInput.click(); });

messagesArea.addEventListener('click', () => messageInput.focus());

window.addEventListener('beforeunload', () => { try { if (peer) peer.destroy(); } catch (e) { } });

/* ---------------------------- Init ---------------------------- */
initPeer();
