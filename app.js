'use strict';

// Strict mode membantu JavaScript mendeteksi kesalahan penggunaan variabel.

// ══════════════════════════════════════════════
// KONEKSI REALTIME — WebSocket ke server PHP
// ══════════════════════════════════════════════
// const dipakai untuk nilai konfigurasi yang tidak perlu diganti.
const configuredWsUrl = window.RAB_WS_URL || new URLSearchParams(location.search).get('ws');
// Template string memilih ws atau wss sesuai protokol halaman yang sedang dibuka.
const WS_URL = configuredWsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`;
const PROJECT_ID = new URLSearchParams(location.search).get('project') || 'default';

// let dipakai untuk nilai yang akan berubah selama aplikasi berjalan.
let ws = null;

// ─────────────────────────────────────────────
// MODUL PRE-DEFINED — 8 modul RAB standar konstruksi
// Dibuat otomatis saat pertama kali project dibuka
// ─────────────────────────────────────────────
// Array [] menyimpan daftar object {} yang mewakili modul bawaan.
const PREDEFINED_MODULES = [
  { name: 'Pekerjaan Persiapan',  paletteIdx: 0 },
  { name: 'Pekerjaan Pondasi',    paletteIdx: 1 },
  { name: 'Pekerjaan Struktur',   paletteIdx: 2 },
  { name: 'Pekerjaan Dinding',    paletteIdx: 3 },
  { name: 'Pekerjaan Atap',       paletteIdx: 4 },
  { name: 'Pekerjaan Lantai',     paletteIdx: 5 },
  { name: 'Pekerjaan Finishing',  paletteIdx: 6 },
  { name: 'Pekerjaan MEP',        paletteIdx: 7 },
];
let wsReconnectDelay = 1000;

const DEBOUNCE = 80;
const LOCK_TTL = 3000;

function getStoredUserName() {
  try {
    const saved = localStorage.getItem('rab_user_name');
    if (saved && saved.trim()) return saved.trim();
  } catch (err) {
    // Browser privacy mode / storage terkunci; lanjut pakai prompt standard.
  }

  const entered = prompt('Masukan nama anda');
  const name = (entered && entered.trim()) || 'User';

  try {
    localStorage.setItem('rab_user_name', name);
  } catch (err) {
    // abaikan jika storage tidak tersedia
  }

  return name;
}

// User ID & Color
const myId    = 'user_' + Math.random().toString(36).slice(2, 7);
const myColor = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
const myName  = getStoredUserName();

// STATE
// State adalah data sementara yang menjadi sumber tampilan aplikasi.
let tableData    = [];  // Semua baris + module headers (_type:'moduleHeader')
let activeLocks  = {};  // Sel yang sedang diedit
let remoteEditors = {};
let debounceMap  = {};
let editDirtyMap = {};
let presenceData = {};
const remoteEditHistory = {};
const undoStack = [];
const changedModuleIds = new Set();
const DISMISSED_COMPLETED_KEY = 'rab_dismissed_completed_modules';

function getDismissedCompletedModules() {
  try {
    const raw = localStorage.getItem(DISMISSED_COMPLETED_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function saveDismissedCompletedModules(ids) {
  try {
    localStorage.setItem(DISMISSED_COMPLETED_KEY, JSON.stringify(ids));
  } catch (err) {
    // ignore if storage unavailable
  }
}

function markModuleCompletedDismissed(moduleId) {
  const ids = new Set(getDismissedCompletedModules());
  ids.add(moduleId);
  saveDismissedCompletedModules([...ids]);
}

function isModuleCompletedDismissed(moduleId) {
  return getDismissedCompletedModules().includes(moduleId);
}

// Module modal state
let openModuleId = null; // moduleId yang sedang terbuka di modal

// Palet warna & ikon untuk kartu modul
const MODULE_PALETTES = [
  { bg: '#06141B', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 11 9-7 9 7M5 10v10h14V10M9 20v-6h6v6"/></svg>', image: 'https://images.unsplash.com/photo-1503387762-592deb58ef4e?auto=format&fit=crop&w=900&q=80' },
  { bg: '#11212D', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M6 20V9h12v11M4 9h16L12 4 4 9Zm6 5h4"/></svg>', image: 'https://images.unsplash.com/photo-1590725121839-892b458a74fe?auto=format&fit=crop&w=900&q=80' },
  { bg: '#253745', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V7l8-4 8 4v13M8 20v-6h8v6M8 9h.01M12 9h.01M16 9h.01"/></svg>', image: 'https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=900&q=80' },
  { bg: '#4A5C6A', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V5h16v15M8 9h8M8 13h8M8 17h5"/></svg>', image: 'https://images.unsplash.com/photo-1531835551805-16d864c8d311?auto=format&fit=crop&w=900&q=80' },
  { bg: '#9BA8AB', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 12 9-7 9 7M5 11v9h14v-9M8 20v-5h8v5"/></svg>', image: 'https://images.unsplash.com/photo-1632759145351-1d592919f522?auto=format&fit=crop&w=900&q=80' },
  { bg: '#CCD0CF', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M6 16h12M8 13h8M10 10h4M12 5v5"/></svg>', image: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=900&q=80' },
  { bg: '#253745', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M6 20V8h12v12M9 8V5h6v3M9 12h6M9 16h6"/></svg>', image: 'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=900&q=80' },
  { bg: '#4A5C6A', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V8h14v12M8 8V5h8v3M8 12h8M8 16h8"/></svg>', image: 'https://images.unsplash.com/photo-1558008258-3256797b43f3?auto=format&fit=crop&w=900&q=80' },
];

// DOM refs
const modulesGrid     = document.getElementById('modulesGrid');
const tableLoading    = document.getElementById('tableLoading');
const totalValueEl    = document.getElementById('totalValue');
const syncDot         = document.getElementById('syncDot');
const syncText        = document.getElementById('syncText');
const toastCont       = document.getElementById('toastContainer');
const userAvatarBadge = document.getElementById('userAvatarBadge');
const moduleModal     = document.getElementById('moduleModal');
const modalTableBody  = document.getElementById('modalTableBody');
const modalModuleName = document.getElementById('modalModuleName');
const modalModuleMeta = document.getElementById('modalModuleMeta');
const modalTotal      = document.getElementById('modalTotal');
const modalIcon       = document.getElementById('modalIcon');
const btnUndo         = document.getElementById('btnUndo');

// ─────────────────────────────────────────────
// INISIALISASI
// ─────────────────────────────────────────────
// IIFE langsung menjalankan inisialisasi tanpa menunggu pemanggilan manual.
(function init() {
  userAvatarBadge.style.background = myColor;
  userAvatarBadge.textContent = myName.charAt(0);
  userAvatarBadge.title = myName;

  // Event listener menghubungkan aksi user dengan function aplikasi.
  document.getElementById('btnExport').addEventListener('click', exportCSV);
  btnUndo.addEventListener('click', undoLastEdit);
  document.getElementById('btnCloseModal').addEventListener('click', closeModuleModal);
  document.getElementById('modalBtnAddRow').addEventListener('click', () => {
    if (openModuleId) addNewRow(openModuleId);
  });

  // Tutup modal saat klik overlay (di luar modal box)
  moduleModal.addEventListener('click', e => {
    if (e.target === moduleModal) closeModuleModal();
  });

  // Escape tutup modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && openModuleId) closeModuleModal();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && openModuleId) {
      e.preventDefault();
      undoLastEdit();
    }
  });

  const titleEl = document.getElementById('projectName');
  let projectNameDebounce;
  if (titleEl) {
    titleEl.addEventListener('input', () => {
      clearTimeout(projectNameDebounce);
      projectNameDebounce = setTimeout(() => {
        wsSend({ type: 'projectName', payload: titleEl.textContent.trim() || 'Proyek Baru' });
      }, 300);
    });
  }

  window.addEventListener('beforeunload', () => {
    if (openModuleId) {
      wsSend({ type: 'saveState' });
      releaseModuleLock(openModuleId);
    }
    clearMyLocks();
  });

  connectWS();
  setSyncState('connecting');
  updateUndoButton();
})();

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
function connectWS() {
  // WebSocket membuka koneksi realtime ke server PHP Ratchet.
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    wsReconnectDelay = 1000;
    setSyncState('ok');
    // JSON.stringify mengubah object JavaScript menjadi teks JSON untuk dikirim.
    ws.send(JSON.stringify({ type: 'join', projectId: PROJECT_ID, userId: myId }));
    sendHeartbeat();
    if (window.__heartbeatInterval) clearInterval(window.__heartbeatInterval);
    window.__heartbeatInterval = setInterval(sendHeartbeat, 3000);
  };

  ws.onmessage = (event) => {
    // JSON.parse mengubah teks JSON dari server menjadi object JavaScript.
    const msg = JSON.parse(event.data);

    if (msg.type === 'state') {
      tableData    = msg.data || [];
      activeLocks  = msg.locks || {};
      remoteEditors = {};
      presenceData = msg.presence || {};

      renderModules();
      updateTotal();
      renderPresence();
      syncAllModuleBrokers(); // tampilkan broker untuk lock yang sudah ada
      syncCompletedModuleBanners(msg.moduleHistory || {});

      const titleEl = document.getElementById('projectName');
      if (titleEl && msg.projectName) titleEl.textContent = msg.projectName;
      return;
    }

    if (msg.type === 'moduleComplete') {
      const payload = msg.payload || {};
      if (!payload.moduleId) return;
      showModuleCompletedBroker(payload.moduleId, payload, payload.editedParts || []);
      const moduleName = getModuleHeaders().find(h => h.moduleId === payload.moduleId)?.name || 'modul';
      showToast(`${payload.name || 'Seseorang'} telah selesai mengedit ${moduleName}`, 'info');
      return;
    }

    if (msg.type === 'clearModuleComplete') {
      const moduleId = msg.moduleId;
      if (!moduleId) return;
      const banner = document.querySelector(`[data-module-card="${moduleId}"] .module-broker-banner`);
      banner?.classList.remove('visible');
      setTimeout(() => banner?.remove(), 350);
      return;
    }

    if (msg.type === 'rowUpdate') {
      // ✅ Edit 1 sel → hanya 1 baris yang dikirim & di-broadcast
      const updatedRow = msg.payload;
      if (updatedRow && updatedRow.id != null) {
        const idx = tableData.findIndex(i => i.id === updatedRow.id);
        if (idx !== -1) {
          tableData[idx] = updatedRow;
          patchRow(updatedRow);        // update sel di modal (jika terbuka)
          updateTotal();
          updateModalTotal();
          updateCardInfo(updatedRow.moduleId);
        }
        if (msg.editor?.key && msg.editor.userId !== myId) {
          activeLocks[msg.editor.key] = msg.editor;
          remoteEditors[msg.editor.key] = msg.editor;
          syncRemoteLocks();
          syncAllModuleBrokers();
        }
      }
      return;
    }

    if (msg.type === 'data') {
      tableData = msg.payload || [];
      if (msg.editor?.key && msg.editor.userId !== myId) {
        activeLocks[msg.editor.key] = msg.editor;
        remoteEditors[msg.editor.key] = msg.editor;
      }
      renderModules();
      updateTotal();
      syncRemoteLocks();
      syncAllModuleBrokers();
      // Refresh modal jika sedang terbuka
      if (openModuleId) refreshModal(openModuleId);
      return;
    }

    if (msg.type === 'locks') {
      activeLocks = msg.payload || {};
      syncRemoteLocks();
      syncAllModuleBrokers();
      return;
    }

    if (msg.type === 'editorStart') {
      if (msg.editor?.key && msg.editor.userId !== myId) {
        if (!msg.editor.key.startsWith('__module_')) rememberModuleEdit(msg.editor);
        activeLocks[msg.editor.key] = msg.editor;
        remoteEditors[msg.editor.key] = msg.editor;
        syncRemoteLocks();
        syncAllModuleBrokers(); // ← broker banner muncul di atas kartu
      }
      return;
    }

    if (msg.type === 'editorStop') {
      if (msg.key) {
        delete activeLocks[msg.key];
        delete remoteEditors[msg.key];
        syncRemoteLocks();
        syncAllModuleBrokers();

        // Hanya tampilkan toast/banner saat modul selesai diedit secara keseluruhan,
        // bukan saat user mengetik di satu cell.
        if (msg.key.startsWith('__module_') && msg.editor && msg.editor.userId !== myId) {
          const moduleId = msg.editor.moduleId || msg.key.replace('__module_', '');
          const historyKey = `${msg.editor.userId}_${moduleId}`;
          const editedParts = remoteEditHistory[historyKey] || [];
          delete remoteEditHistory[historyKey];
          showModuleCompletedBroker(moduleId, msg.editor, editedParts);
          const moduleName = getModuleHeaders().find(h => h.moduleId === moduleId)?.name || 'modul';
          showToast(`${msg.editor.name || 'Seseorang'} telah selesai mengedit ${moduleName}`, 'info');
        }
      }
      return;
    }

    if (msg.type === 'presence') {
      presenceData = msg.payload || {};
      renderPresence();
      return;
    }

    if (msg.type === 'action') {
      showToast(msg.text, 'info');
      return;
    }

    if (msg.type === 'projectName') {
      const titleEl = document.getElementById('projectName');
      if (!titleEl) return;
      if (document.activeElement !== titleEl && msg.payload) {
        titleEl.textContent = msg.payload;
      }
      return;
    }
  };

  ws.onclose = () => {
    setSyncState('offline');
    setTimeout(connectWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
  };

  ws.onerror = () => ws.close();
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function saveToStorage(editor = null) {
  setSyncState('syncing');
  wsSend({ type: 'data', payload: tableData, editor });
  setTimeout(() => setSyncState('ok'), 200);
}

function saveLocksToStorage() {
  wsSend({ type: 'locks', payload: activeLocks });
}

function clearMyLocks() {
  for (const key in activeLocks) {
    if (activeLocks[key].userId === myId) delete activeLocks[key];
  }
  saveLocksToStorage();
}

function sendHeartbeat() {
  wsSend({ type: 'presence', userId: myId, entry: { name: myName, color: myColor, ts: Date.now() } });
}

function renderPresence() {
  const container = document.getElementById('presenceAvatars');
  if (!container) return;
  container.innerHTML = '';
  const now = Date.now();
  for (const pId in presenceData) {
    if (pId === myId) continue;
    const p = presenceData[pId];
    if (now - p.ts <= 10000) {
      const div = document.createElement('div');
      div.className = 'presence-avatar';
      div.style.background = p.color;
      div.textContent = p.name.charAt(0);
      div.dataset.name = p.name;
      container.appendChild(div);
    }
  }
}

/* ════════════════════════════════════════════
   MODULE HELPERS
   ════════════════════════════════════════════ */

function getModuleHeaders() {
  return tableData.filter(r => r._type === 'moduleHeader');
}

function getModuleRows(moduleId) {
  // filter() menghasilkan array baru yang hanya berisi baris modul tertentu.
  return tableData.filter(r => !r._type && r.moduleId === moduleId);
}

// Pastikan semua modul pre-defined ada. Jika belum ada (project baru),
// buat semua 8 modul sekaligus. Row lama tanpa moduleId → masuk modul pertama.
function ensureDefaultModule() {
  let headers = getModuleHeaders();

  if (headers.length === 0) {
    // Project baru — buat semua modul pre-defined
    PREDEFINED_MODULES.forEach((m, idx) => {
      const moduleId = `mod_preset_${idx}`;
      headers.push({
        id:         `__${moduleId}`,
        _type:      'moduleHeader',
        moduleId,
        name:       m.name,
        paletteIdx: m.paletteIdx,
      });
    });
    // Sisipkan semua header di awal tableData
    tableData.unshift(...headers);
  }

  // Assign row lama yang belum punya moduleId ke modul pertama
  const firstId = headers[0].moduleId;
  tableData.forEach(r => { if (!r._type && !r.moduleId) r.moduleId = firstId; });
}

function getModulePalette(header) {
  const predefinedIndex = PREDEFINED_MODULES.findIndex(module => module.name === header.name);
  const idx = predefinedIndex >= 0
    ? PREDEFINED_MODULES[predefinedIndex].paletteIdx
    : (header.paletteIdx ?? 0) % MODULE_PALETTES.length;
  return MODULE_PALETTES[idx];
}

/* ════════════════════════════════════════════
   RENDER MODULES — kartu kompak di grid
   ════════════════════════════════════════════ */

function renderModules() {
  ensureDefaultModule();
  modulesGrid.innerHTML = '';
  tableLoading.style.display = 'none';

  const headers = getModuleHeaders();
  headers.forEach((header, idx) => {
    if (header.paletteIdx === undefined) header.paletteIdx = idx;
    modulesGrid.appendChild(createModuleCard(header));
  });
}

// ─────────────────────────────────────────────
// Buat kartu kompak untuk 1 modul (tampilan grid)
// Tidak ada tabel di dalam — tabel ada di modal
// ─────────────────────────────────────────────
function createModuleCard(header) {
  // Function ini membuat elemen HTML berdasarkan data modul.
  const moduleId = header.moduleId;
  const palette  = getModulePalette(header);
  const rows     = getModuleRows(moduleId);
  const total    = rows.reduce((s, r) => s + (r.jumlah || 0), 0);

  // Wrapper (broker banner disisipkan sebelum .module-card)
  const wrapper = document.createElement('div');
  wrapper.className = 'module-card-wrapper';
  wrapper.dataset.moduleCard = moduleId;

  // Kartu
  const card = document.createElement('div');
  card.className = 'module-card';
  card.addEventListener('click', e => {
    // Klik di mana saja di kartu → buka modal
    if (!e.target.closest('.btn-card-del')) openModuleModal(moduleId);
  });

  // ── Bagian atas: banner warna-warni (seperti foto di gambar) ──
  const thumb = document.createElement('div');
  thumb.className = 'module-card-thumb';
  thumb.style.backgroundColor = palette.bg;
  thumb.style.backgroundImage = `linear-gradient(180deg, rgba(6, 20, 27, .08), rgba(6, 20, 27, .72)), url("${palette.image}")`;

  const thumbIcon = document.createElement('div');
  thumbIcon.className = 'module-thumb-icon';
  thumbIcon.innerHTML = palette.icon;

  thumb.appendChild(thumbIcon);

  // ── Body: nama modul + baris info ──
  const body = document.createElement('div');
  body.className = 'module-card-body';

  const title = document.createElement('h3');
  title.className = 'module-card-title';
  title.textContent = header.name;

  // Info rows (seperti "Jenis — Rumah" di gambar)
  const infoRows = [
    { label: 'Jumlah Bahan yang Dibutuhkan', value: `${rows.length} bahan`, attr: `data-card-rowcount="${moduleId}"` },
    { label: 'Total Biaya',   value: formatCurrency(total),  attr: `data-card-total="${moduleId}"` },
    { label: 'Status',        value: rows.length === 0 ? 'Kosong' : 'Ada Data', attr: '' },
  ];

  body.appendChild(title);
  infoRows.forEach(info => {
    const row = document.createElement('div');
    row.className = 'module-info-row';
    row.innerHTML = `
      <span class="module-info-label">${info.label}</span>
      <span class="module-info-value" ${info.attr}>${info.value}</span>`;
    body.appendChild(row);
  });

  // ── Actions: tombol Edit + Hapus ──
  const actions = document.createElement('div');
  actions.className = 'module-card-actions';

  const btnEdit = document.createElement('button');
  btnEdit.className = 'btn-card-edit';
  btnEdit.dataset.moduleEditBtn = moduleId;
  btnEdit.innerHTML = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none">
    <path d="M9.5 1.5l3 3-8 8H1.5v-3l8-8z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  </svg> Edit`;
  btnEdit.addEventListener('click', e => {
    e.stopPropagation();
    openModuleModal(moduleId);
  });

  actions.appendChild(btnEdit);

  card.appendChild(thumb);
  card.appendChild(body);
  card.appendChild(actions);
  wrapper.appendChild(card);

  return wrapper;
}

// Update info di kartu (rowcount + total) tanpa rebuild
function updateCardInfo(moduleId) {
  const rows  = getModuleRows(moduleId);
  const total = rows.reduce((s, r) => s + (r.jumlah || 0), 0);

  const countEl = document.querySelector(`[data-card-rowcount="${moduleId}"]`);
  const totalEl = document.querySelector(`[data-card-total="${moduleId}"]`);
  if (countEl) countEl.textContent = `${rows.length} bahan`;
  if (totalEl) totalEl.textContent = formatCurrency(total);
}

/* ════════════════════════════════════════════
   MODULE MODAL — tabel editing muncul di overlay
   ════════════════════════════════════════════ */

// ─────────────────────────────────────────────
// Buka modal untuk modul tertentu
// Langsung broadcast editorStart dengan key __module_<moduleId>
// agar user lain langsung tahu modul ini sedang dibuka
// ─────────────────────────────────────────────
function openModuleModal(moduleId) {
  // Jika sudah ada modal terbuka, tutup dulu
  if (openModuleId && openModuleId !== moduleId) closeModuleModal();

  openModuleId = moduleId;
  refreshModal(moduleId);
  moduleModal.classList.add('open');
  document.body.style.overflow = 'hidden';

  // ── Broadcast module-level lock via editorStart ──
  // Pakai key khusus: '__module_mod_xxx' agar tidak bentrok dengan key sel biasa
  wsSend({
    type: 'editorStart',
    editor: {
      key: `__module_${moduleId}`,
      userId: myId,
      name: myName,
      color: myColor,
      ts: Date.now(),
    },
  });
  // Simpan di lokal DAN kirim ke server via locks message
  // → server menyimpan lock ini, sehingga User B yang join belakangan juga dapat info ini
  activeLocks[`__module_${moduleId}`] = { userId: myId, name: myName, color: myColor, ts: Date.now() };
  saveLocksToStorage(); // ← kunci ini sekarang disimpan di server!
}

// ─────────────────────────────────────────────
// Tutup modal & lepas module-level lock
// ─────────────────────────────────────────────
function closeModuleModal() {
  if (!openModuleId) return;
  const moduleId = openModuleId;
  wsSend({ type: 'saveState' }); // ✅ Simpan seluruh perubahan ke DB SQLite saat modal ditutup
  const editedParts = remoteEditHistory[`${myId}_${moduleId}`] || [];
  const module = getModuleHeaders().find(header => header.moduleId === moduleId);

  if (changedModuleIds.delete(moduleId)) {
    wsSend({ type: 'action', text: `${myName} mengedit modul ${module?.name || 'ini'}` });
  }

  wsSend({
    type: 'moduleComplete',
    moduleId: moduleId,
    editor: {
      key: `__module_${moduleId}`,
      moduleId: moduleId,
      userId: myId,
      name: myName,
      color: myColor,
    },
    editedParts,
  });

  releaseModuleLock(moduleId);
  openModuleId = null;
  moduleModal.classList.remove('open');
  document.body.style.overflow = '';
}

function releaseModuleLock(moduleId) {
  wsSend({
    type: 'editorStop',
    key: `__module_${moduleId}`,
    userId: myId,
    editor: {
      key: `__module_${moduleId}`,
      moduleId: moduleId,
      userId: myId,
      name: myName,
      color: myColor,
    },
  });
  delete activeLocks[`__module_${moduleId}`];
  saveLocksToStorage(); // ← beritahu server bahwa lock sudah dilepas
  syncAllModuleBrokers();
}

// ─────────────────────────────────────────────
// Render isi modal (header info + tbody)
// ─────────────────────────────────────────────
function refreshModal(moduleId) {
  const header  = getModuleHeaders().find(h => h.moduleId === moduleId);
  const rows    = getModuleRows(moduleId);
  const palette = getModulePalette(header || { paletteIdx: 0 });
  const total   = rows.reduce((s, r) => s + (r.jumlah || 0), 0);

  // Header modal
  modalModuleName.textContent = header?.name || 'Modul';
  modalModuleMeta.textContent = `${rows.length} bahan yang dibutuhkan`;
  modalTotal.textContent = formatCurrency(total);
  modalIcon.innerHTML = palette.icon;
  modalIcon.style.background = palette.bg;

  // Tbody: beri data-module-tbody agar addNewRow / patchRow bisa menemukan elemen
  modalTableBody.dataset.moduleTbody = moduleId;
  modalTableBody.innerHTML = '';

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'modal-empty-row';
    tr.dataset.emptyFor = moduleId;
    tr.innerHTML = `<td colspan="8">Belum ada bahan. Klik "+ Tambah Bahan" untuk memulai.</td>`;
    modalTableBody.appendChild(tr);
  } else {
    rows.forEach(row => modalTableBody.appendChild(createRow(row)));
  }
}

function updateModalTotal() {
  if (!openModuleId) return;
  const rows  = getModuleRows(openModuleId);
  const total = rows.reduce((s, r) => s + (r.jumlah || 0), 0);
  modalTotal.textContent = formatCurrency(total);
  modalModuleMeta.textContent = `${rows.length} bahan yang dibutuhkan`;
}

/* ════════════════════════════════════════════
   RENDER ROW — baris tabel (dipakai di modal)
   ════════════════════════════════════════════ */

function createRow(item) {
  const tr = document.createElement('tr');
  tr.dataset.id = item.id;
  tr.classList.add('row-new');

  const columns = [
    { key: 'no',           editable: false, type: 'number',   align: 'center', cssClass: 'td-no' },
    { key: 'uraian',       editable: true,  type: 'text',     align: 'left'   },
    { key: 'volume',       editable: true,  type: 'number',   align: 'right'  },
    { key: 'satuan',       editable: true,  type: 'text',     align: 'center' },
    { key: 'harga_satuan', editable: true,  type: 'currency', align: 'right'  },
    { key: 'jumlah',       editable: false, type: 'currency', align: 'right',  computed: true },
    { key: 'keterangan',   editable: true,  type: 'text',     align: 'left'   },
  ];

  for (const col of columns) {
    const td = document.createElement('td');
    td.dataset.field = col.key;
    if (col.cssClass) td.className = col.cssClass;

    if (col.computed) {
      td.innerHTML = `<span class="cell-editable cell-numeric cell-formatted positive" style="pointer-events:none;user-select:none;">${formatCurrency(item.jumlah)}</span>`;
    } else if (col.editable) {
      const div = document.createElement('div');
      div.className = 'cell-editable';
      div.contentEditable = 'true';
      div.spellcheck = false;
      div.dataset.field    = col.key;
      div.dataset.itemId   = item.id;
      div.dataset.type     = col.type;
      div.dataset.moduleId = item.moduleId;

      if (col.type === 'currency' || col.type === 'number') div.classList.add('cell-numeric');
      if (col.align === 'center') div.classList.add('cell-center');

      div.textContent = displayValue(item[col.key], col.type);
      div.addEventListener('focus',   onCellFocus);
      div.addEventListener('blur',    onCellBlur);
      div.addEventListener('input',   onCellInput);
      div.addEventListener('keydown', onCellKeydown);

      // Tampilkan lock jika sudah ada
      const lockKey = `${item.id}_${col.key}`;
      const remoteLock = remoteEditors[lockKey] || activeLocks[lockKey];
      if (remoteLock && remoteLock.userId !== myId) {
        div.classList.add('editing-other');
        addTypingLabel(div, remoteLock);
      }

      td.appendChild(div);
    } else {
      const span = document.createElement('span');
      span.style.cssText = 'display:block; padding:10px 14px; color:var(--text-muted);';
      if (col.type === 'number') {
        span.style.fontFamily = "'JetBrains Mono', monospace";
        span.style.fontSize = '.75rem';
        span.style.textAlign = 'center';
      }
      span.textContent = item[col.key];
      td.appendChild(span);
    }
    tr.appendChild(td);
  }

  const tdAct = document.createElement('td');
  tdAct.className = 'td-action col-act';
  tdAct.innerHTML = `
    <button class="btn-del-row" data-id="${item.id}" title="Hapus bahan">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <path d="M2 2l9 9M11 2l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    </button>`;
  tdAct.querySelector('.btn-del-row').addEventListener('click', () => deleteRow(item.id));
  tr.appendChild(tdAct);

  return tr;
}

function patchRow(item) {
  const tr = document.querySelector(`tr[data-id="${item.id}"]`);
  if (!tr) return;

  tr.querySelectorAll('[data-field]').forEach(cell => {
    const field = cell.dataset.field;
    const lockKey = `${item.id}_${field}`;
    const activeLock = remoteEditors[lockKey] || activeLocks[lockKey];
    const isOtherLocked = activeLock && activeLock.userId !== myId;

    if (document.activeElement === cell) return;

    if (field === 'jumlah') {
      const span = cell.querySelector('span');
      if (span) span.textContent = formatCurrency(item.jumlah);
    } else if (cell.contentEditable === 'true') {
      const newVal = displayValue(item[field], cell.dataset.type);
      if (cell.textContent !== newVal) cell.textContent = newVal;

      if (isOtherLocked) {
        if (!cell.classList.contains('editing-other') || !cell.parentElement.querySelector('.typing-label')) {
          cell.classList.add('editing-other');
          addTypingLabel(cell, activeLock);
        }
      } else {
        cell.classList.remove('editing-other');
        cell.parentElement.querySelector('.typing-label')?.remove();
        cell.style.borderColor = '';
        cell.style.boxShadow = '';
      }
    }
  });
}

/* ════════════════════════════════════════════
   CELL EVENTS
   ════════════════════════════════════════════ */

function onCellFocus(e) {
  const cell = e.currentTarget;
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  editDirtyMap[key] = false;
  cell.classList.add('editing-you');
  sendLock(cell.dataset.itemId, cell.dataset.field, true);
  sendEditorPresence(cell, true);
  selectAllContent(cell);
}

function onCellBlur(e) {
  const cell = e.currentTarget;
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  const wasDirty = editDirtyMap[key];
  cell.classList.remove('editing-you');
  removeTypingLabel(cell);
  sendLock(cell.dataset.itemId, cell.dataset.field, false);
  sendEditorPresence(cell, false);

  clearTimeout(debounceMap[key]);
  saveCell(cell);
  delete editDirtyMap[key];

  if (wasDirty) {
    const item = tableData.find(i => i.id === parseInt(cell.dataset.itemId));
    if (item?.moduleId) changedModuleIds.add(item.moduleId);
  }
}

function onCellInput(e) {
  const cell = e.currentTarget;
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  editDirtyMap[key] = true;
  if (cell.dataset.field === 'volume' || cell.dataset.field === 'harga_satuan') {
    updateComputedJumlah(cell);
  }
  sendLock(cell.dataset.itemId, cell.dataset.field, true);
  clearTimeout(debounceMap[key]);
  debounceMap[key] = setTimeout(() => saveCell(cell), DEBOUNCE);
}

function onCellKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const nextTr = e.currentTarget.closest('tr')?.nextElementSibling;
    if (nextTr) nextTr.querySelector(`[data-field="${e.currentTarget.dataset.field}"]`)?.focus();
  }
  if (e.key === 'Escape') e.currentTarget.blur();
}

/* ════════════════════════════════════════════
   CRUD & LOCK
   ════════════════════════════════════════════ */

function saveCell(cell) {
  // Membaca nilai dari DOM, memperbarui state, lalu mengirim perubahan ke server.
  const itemId = parseInt(cell.dataset.itemId);
  const field  = cell.dataset.field;
  let rawValue = cell.textContent.trim();

  if (cell.dataset.type === 'number' || cell.dataset.type === 'currency') {
    rawValue = parseFloat(rawValue.replace(/[^0-9.-]/g, '')) || 0;
  }

  const itemIndex = tableData.findIndex(i => i.id === itemId);
  if (itemIndex === -1) return;
  const item = tableData[itemIndex];
  if (item[field] === rawValue) return;
  const beforeValue = item[field];
  const beforeJumlah = item.jumlah;

  const patch = { [field]: rawValue };
  if (field === 'volume' || field === 'harga_satuan') {
    const vol  = field === 'volume' ? rawValue : item.volume;
    const hsat = field === 'harga_satuan' ? rawValue : item.harga_satuan;
    patch.jumlah = vol * hsat;
  }

  // Object.assign menggabungkan property patch ke object item.
  Object.assign(item, patch);
  undoStack.push({
    itemId,
    moduleId: item.moduleId,
    field,
    before: beforeValue,
    after: rawValue,
    beforeJumlah: field === 'volume' || field === 'harga_satuan' ? beforeJumlah : undefined,
    afterJumlah: patch.jumlah,
  });
  updateUndoButton();
  updateTotal();
  updateModalTotal();
  updateCardInfo(item.moduleId);

  // ✅ Kirim 1 baris yang berubah (persist: false agar TIDAK tulis DB per sel)
  wsSend({
    type: 'rowUpdate',
    payload: item,
    persist: false,
    editor: { key: `${itemId}_${field}`, userId: myId, name: myName, color: myColor, ts: Date.now() },
  });
  setSyncState('syncing');
  setTimeout(() => setSyncState('ok'), 200);
}

function updateUndoButton() {
  if (btnUndo) btnUndo.disabled = undoStack.length === 0;
}

function undoLastEdit() {
  const lastEdit = undoStack.pop();
  updateUndoButton();
  if (!lastEdit) return;

  const item = tableData.find(row => row.id === lastEdit.itemId);
  if (!item || item.moduleId !== openModuleId || item[lastEdit.field] !== lastEdit.after) {
    showToast('Undo dibatalkan karena bahan sudah berubah', 'warn');
    return;
  }

  item[lastEdit.field] = lastEdit.before;
  if (lastEdit.afterJumlah !== undefined) item.jumlah = lastEdit.beforeJumlah;
  patchRow(item);
  updateTotal();
  updateModalTotal();
  updateCardInfo(item.moduleId);
  wsSend({
    type: 'rowUpdate',
    payload: item,
    persist: false,
    editor: { key: `${item.id}_${lastEdit.field}`, userId: myId, name: myName, color: myColor, ts: Date.now() },
  });
  showToast('Perubahan terakhir dibatalkan', 'info');
}

function sendLock(itemId, field, isLocking) {
  const key = `${itemId}_${field}`;
  if (isLocking) {
    activeLocks[key] = { userId: myId, name: myName, color: myColor, ts: Date.now() };
  } else {
    delete activeLocks[key];
  }
  saveLocksToStorage();
}

function sendEditorPresence(cell, isEditing) {
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  const item = tableData.find(row => row.id === parseInt(cell.dataset.itemId));
  const fieldLabels = {
    uraian: 'Nama Bahan', volume: 'Volume', satuan: 'Satuan',
    harga_satuan: 'Harga Satuan', keterangan: 'Keterangan',
  };
  const editor = {
    key, userId: myId, name: myName, color: myColor, ts: Date.now(),
    moduleId: cell.dataset.moduleId,
    itemNo: item?.no || '?',
    field: cell.dataset.field,
    fieldLabel: fieldLabels[cell.dataset.field] || cell.dataset.field,
  };

  if (isEditing) {
    rememberModuleEdit(editor);
    wsSend({ type: 'editorStart', editor });
  } else {
    wsSend({ type: 'editorStop', key, userId: myId });
  }
}

function rememberModuleEdit(editor) {
  if (!editor?.moduleId || !editor.field) return;
  const historyKey = `${editor.userId}_${editor.moduleId}`;
  const editedParts = remoteEditHistory[historyKey] || [];
  const partKey = `${editor.itemNo ?? '?'}_${editor.field}`;
  if (!editedParts.some(part => part.key === partKey)) {
    editedParts.push({
      key: partKey,
      itemNo: editor.itemNo ?? '?',
      fieldLabel: editor.fieldLabel || editor.field,
    });
  }
  remoteEditHistory[historyKey] = editedParts;
}

// ─────────────────────────────────────────────
// Tambah baris baru ke modul (lewat modal)
// ─────────────────────────────────────────────
function addNewRow(moduleId) {
  const moduleRows = getModuleRows(moduleId);
  const maxNo = moduleRows.reduce((m, i) => Math.max(m, i.no || 0), 0);
  const newItem = {
    id: Date.now(), moduleId,
    no: maxNo + 1, uraian: '', volume: 0,
    satuan: 'unit', harga_satuan: 0, jumlah: 0, keterangan: ''
  };

  tableData.push(newItem);

  // Hapus empty row placeholder
  const emptyRow = document.querySelector(`tr[data-empty-for="${moduleId}"]`);
  if (emptyRow) emptyRow.remove();

  // Tambah ke tbody modal
  const tbody = document.querySelector(`[data-module-tbody="${moduleId}"]`);
  if (tbody) tbody.appendChild(createRow(newItem));

  updateTotal();
  updateModalTotal();
  updateCardInfo(moduleId);
  changedModuleIds.add(moduleId);
  saveToStorage();

  setTimeout(() => {
    const lastTr = tbody?.querySelector('tr:last-child');
    lastTr?.querySelector('.cell-editable[data-field="uraian"]')?.focus();
  }, 50);
}

// addNewModule() dihapus — modul sudah pre-defined otomatis

// deleteModule() dihapus — modul pre-defined tidak bisa dihapus

// ─────────────────────────────────────────────
// Hapus satu baris
// ─────────────────────────────────────────────
function deleteRow(itemId) {
  const item = tableData.find(i => i.id === itemId);
  const moduleId = item?.moduleId;
  if (!confirm('Hapus bahan ini?')) return;

  tableData = tableData.filter(i => i.id !== itemId);
  // Renumber dalam modul saja
  getModuleRows(moduleId).forEach((r, idx) => { r.no = idx + 1; });

  const tr = document.querySelector(`tr[data-id="${itemId}"]`);
  if (tr) {
    tr.style.transition = 'opacity .2s, transform .2s';
    tr.style.opacity = '0';
    tr.style.transform = 'translateX(20px)';
    setTimeout(() => {
      tr.remove();
      // Tampilkan empty state jika modul kosong
      if (getModuleRows(moduleId).length === 0) {
        const tbody = document.querySelector(`[data-module-tbody="${moduleId}"]`);
        if (tbody) {
          const tr2 = document.createElement('tr');
          tr2.className = 'modal-empty-row';
          tr2.dataset.emptyFor = moduleId;
          tr2.innerHTML = `<td colspan="8">Belum ada bahan. Klik "+ Tambah Bahan" untuk memulai.</td>`;
          tbody.appendChild(tr2);
        }
      }
    }, 200);
  }

  updateTotal();
  updateModalTotal();
  updateCardInfo(moduleId);
  saveToStorage();
  showToast('Bahan dihapus', 'info');
  if (moduleId) changedModuleIds.add(moduleId);
}

/* ════════════════════════════════════════════
   COMPUTED & UTILS
   ════════════════════════════════════════════ */

function updateComputedJumlah(editedCell) {
  const itemId = parseInt(editedCell.dataset.itemId);
  const item   = tableData.find(i => i.id === itemId);
  if (!item) return;

  const tr = document.querySelector(`tr[data-id="${itemId}"]`);
  if (!tr) return;

  const vol  = parseFloat(tr.querySelector('[data-field="volume"]')?.textContent) || 0;
  const hsat = parseFloat(tr.querySelector('[data-field="harga_satuan"]')?.textContent.replace(/[^0-9.-]/g, '')) || 0;
  const jml  = vol * hsat;

  const jmlCell = tr.querySelector('[data-field="jumlah"] span');
  if (jmlCell) jmlCell.textContent = formatCurrency(jml);
  item.jumlah = jml;
  updateTotal();
  updateModalTotal();
  updateCardInfo(item.moduleId);
}

function updateTotal() {
  // reduce() menjumlahkan seluruh nilai jumlah dari baris bahan.
  const total = tableData.filter(r => !r._type).reduce((s, i) => s + (i.jumlah || 0), 0);
  if (totalValueEl) totalValueEl.textContent = formatCurrency(total);
}

function addTypingLabel(cell, lockInfo) {
  const parentTd = cell.parentElement;
  parentTd.querySelector('.typing-label')?.remove();
  const label = document.createElement('span');
  label.className = 'typing-label';
  const dot = document.createElement('span');
  dot.className = 'typing-label-dot';
  dot.textContent = (lockInfo.name || '?').charAt(0).toUpperCase();
  label.appendChild(dot);
  const nameText = document.createElement('span');
  nameText.textContent = lockInfo.name;
  label.appendChild(nameText);
  parentTd.style.setProperty('--lock-color', lockInfo.color);
  cell.style.borderColor = lockInfo.color;
  parentTd.style.position = 'relative';
  parentTd.appendChild(label);
}

function removeTypingLabel(cell) {
  const parentTd = cell.parentElement;
  parentTd.querySelector('.typing-label')?.remove();
  parentTd.style.removeProperty('--lock-color');
  cell.style.borderColor = '';
  cell.style.boxShadow = '';
}

// patchRow wrapper: reset border sel tak terkunci
const _origPatchRow = patchRow;
patchRow = function (item) {
  _origPatchRow(item);
  const tr = document.querySelector(`tr[data-id="${item.id}"]`);
  if (!tr) return;
  tr.querySelectorAll('.cell-editable').forEach(cell => {
    if (!cell.classList.contains('editing-other') && !cell.classList.contains('editing-you')) {
      cell.style.borderColor = '';
      cell.style.boxShadow = '';
    }
  });
};

function setSyncState(state) {
  syncDot.className = 'sync-dot';
  if (state === 'ok')         { syncText.textContent = 'Terhubung'; }
  else if (state === 'syncing')  { syncDot.classList.add('syncing'); syncText.textContent = 'Menyimpan...'; }
  else if (state === 'connecting') { syncText.textContent = 'Menghubungkan...'; }
  else if (state === 'offline')  { syncText.textContent = 'Terputus, menyambung ulang...'; }
}

function formatCurrency(val) {
  if (val == null || isNaN(val)) return 'Rp 0';
  return 'Rp ' + Math.round(val).toLocaleString('id-ID');
}

function displayValue(val, type) {
  if (val == null) return '';
  if (type === 'currency') return Math.round(val).toLocaleString('id-ID');
  return String(val);
}

function selectAllContent(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type === 'error' ? 'err' : type}`;
  toast.innerHTML = `<span>${msg}</span>`;
  toastCont.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

function exportCSV() {
  // Blob membuat file sementara di browser tanpa upload ke server.
  const modMap = {};
  getModuleHeaders().forEach(h => { modMap[h.moduleId] = h.name; });

  const dataRows = tableData.filter(r => !r._type);
  const headers  = ['No', 'Modul', 'Uraian Pekerjaan', 'Volume', 'Satuan', 'Harga Satuan', 'Jumlah', 'Keterangan'];
  const rows = dataRows.map(item => [
    item.no,
    `"${modMap[item.moduleId] || item.moduleId}"`,
    `"${item.uraian}"`,
    item.volume, item.satuan, item.harga_satuan, item.jumlah,
    `"${item.keterangan}"`
  ].join(','));
  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'RAB_Estimasi.csv';
  a.click();
}

// ─────────────────────────────────────────────
// Sync lock indicator di sel (warna border + label nama user)
// ─────────────────────────────────────────────
function syncRemoteLocks() {
  document.querySelectorAll('.cell-editable').forEach(cell => {
    const lockKey = `${cell.dataset.itemId}_${cell.dataset.field}`;
    const lockInfo = remoteEditors[lockKey] || activeLocks[lockKey];
    const isOtherLocked = lockInfo && lockInfo.userId !== myId;
    const hasLabel = cell.parentElement.querySelector('.typing-label');

    if (isOtherLocked) {
      cell.classList.add('editing-other');
      if (!hasLabel) addTypingLabel(cell, lockInfo);
    } else if (!cell.classList.contains('editing-you')) {
      cell.classList.remove('editing-other');
      cell.parentElement.querySelector('.typing-label')?.remove();
      cell.style.borderColor = '';
      cell.style.boxShadow = '';
    }
  });
}

/* ════════════════════════════════════════════
   MODULE BROKER BANNER
   Muncul DI ATAS / DI LUAR kartu — realtime tanpa reload
   ════════════════════════════════════════════ */

// ─────────────────────────────────────────────
// Cek apakah modul ini sedang dibuka/diedit oleh user lain.
// Cek key '__module_<moduleId>' yang dikirim saat openModuleModal()
// ─────────────────────────────────────────────
function isModuleLocked(moduleId) {
  // Cek module-level lock (user lain punya modal terbuka)
  const moduleKey = `__module_${moduleId}`;
  const modLock = remoteEditors[moduleKey] || activeLocks[moduleKey];
  if (modLock && modLock.userId !== myId) return modLock;

  // Cek cell-level lock (user lain sedang aktif di sel dalam modul ini)
  const rows   = getModuleRows(moduleId);
  const fields = ['uraian', 'volume', 'satuan', 'harga_satuan', 'keterangan'];
  for (const row of rows) {
    for (const field of fields) {
      const key  = `${row.id}_${field}`;
      const lock = remoteEditors[key] || activeLocks[key];
      if (lock && lock.userId !== myId) return lock;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// Re-sync semua broker banner di semua kartu
// Dipanggil setiap kali editorStart / editorStop / locks diterima
// ─────────────────────────────────────────────
function syncAllModuleBrokers() {
  for (const header of getModuleHeaders()) {
    const lockInfo = isModuleLocked(header.moduleId);
    if (lockInfo) showModuleBroker(header.moduleId, lockInfo);
    else          hideModuleBroker(header.moduleId);
  }

  // Update tombol Edit: jika modul dikunci orang lain, tambah class 'locked'
  document.querySelectorAll('[data-module-edit-btn]').forEach(btn => {
    const moduleId = btn.dataset.moduleEditBtn;
    const locked   = isModuleLocked(moduleId);
    if (locked) {
      btn.classList.add('locked');
      btn.title = `Dikunci oleh ${locked.name}`;
    } else {
      btn.classList.remove('locked');
      btn.title = '';
    }
  });
}

// ─────────────────────────────────────────────
// Tampilkan broker banner DI ATAS kartu (di luar .module-card)
// ─────────────────────────────────────────────
function buildModuleEditContextText(userInfo) {
  if (!userInfo) return 'modul ini';

  const itemNo = userInfo.itemNo ? `Bahan ${userInfo.itemNo}` : 'modul ini';
  const fieldLabel = userInfo.fieldLabel || userInfo.field || 'bagian';
  return `${itemNo} (${fieldLabel})`;
}

function syncCompletedModuleBanners(moduleHistory) {
  if (!moduleHistory) return;

  Object.entries(moduleHistory).forEach(([moduleId, item]) => {
    if (!item || !moduleId) return;
    if (isModuleCompletedDismissed(moduleId)) return;
    showModuleCompletedBroker(moduleId, item, item.editedParts || []);
  });
}

function showModuleBroker(moduleId, userInfo) {
  const wrapper = document.querySelector(`[data-module-card="${moduleId}"]`);
  if (!wrapper) return;

  let banner = wrapper.querySelector('.module-broker-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'module-broker-banner';
    // Sisipkan SEBELUM .module-card → tampil di atas kartu, di luar
    wrapper.insertBefore(banner, wrapper.firstChild);
  } else {
    // Reset kelas jika sebelumnya banner completed
    banner.className = 'module-broker-banner';
  }

  const contextText = buildModuleEditContextText(userInfo);

  banner.innerHTML = `
    <span class="broker-avatar" style="background:${userInfo.color || '#f59e0b'}">
      ${(userInfo.name || '?').charAt(0).toUpperCase()}
    </span>
    <div class="broker-text">
      <strong>${userInfo.name || 'Seseorang'}</strong> sedang mengedit ${contextText}
    </div>
    <span class="broker-pulse"></span>
  `;

  // Force reflow agar animasi re-trigger
  banner.classList.remove('visible');
  void banner.offsetWidth;
  banner.classList.add('visible');
}

// ─────────────────────────────────────────────
// Tampilkan banner "Selesai Edit" dengan tombol Oke
// Tidak hilang otomatis sampai user mengeklik tombol Oke
// ─────────────────────────────────────────────
function showModuleCompletedBroker(moduleId, userInfo, editedParts = []) {
  if (isModuleCompletedDismissed(moduleId)) return;

  const wrapper = document.querySelector(`[data-module-card="${moduleId}"]`);
  if (!wrapper) return;

  let banner = wrapper.querySelector('.module-broker-banner');
  if (banner) banner.remove();

  banner = document.createElement('div');
  banner.className = 'module-broker-banner completed';
  wrapper.insertBefore(banner, wrapper.firstChild);

  const shortLabels = {
    'Nama Bahan': 'Nama',
    'Harga Satuan': 'Harga',
    'Keterangan': 'Catatan',
  };
  const groupedParts = editedParts.reduce((groups, part) => {
    const key = String(part.itemNo);
    const group = groups.find(item => item.itemNo === key);
    const label = shortLabels[part.fieldLabel] || part.fieldLabel;
    if (group) {
      if (!group.fields.includes(label)) group.fields.push(label);
    } else {
      groups.push({ itemNo: key, fields: [label] });
    }
    return groups;
  }, []);
  const editedText = groupedParts.length
    ? `Diubah: ${groupedParts.slice(0, 3).map(part => `Bahan ${part.itemNo} (${part.fields.join(', ')})`).join('; ')}${groupedParts.length > 3 ? '; lainnya' : ''}`
    : 'Tidak ada detail bagian';

  banner.innerHTML = `
    <span class="broker-avatar" style="background:${userInfo.color || '#10b981'}">
      ${(userInfo.name || '?').charAt(0).toUpperCase()}
    </span>
    <div class="broker-text">
      <strong>${userInfo.name || 'Seseorang'}</strong> telah selesai mengedit modul ini
      <small>${editedText}</small>
    </div>
    <button class="btn-broker-ok">Oke</button>
  `;

  const btnOk = banner.querySelector('.btn-broker-ok');
  if (btnOk) {
    btnOk.addEventListener('click', (e) => {
      e.stopPropagation();
      markModuleCompletedDismissed(moduleId);
      wsSend({ type: 'clearModuleComplete', moduleId: moduleId });
      banner.classList.remove('visible');
      setTimeout(() => banner.remove(), 350);
    });
  }

  banner.classList.remove('visible');
  void banner.offsetWidth;
  banner.classList.add('visible');
}

// ─────────────────────────────────────────────
// Sembunyikan broker banner ketika modul sudah bebas
// (Tetap tampilkan jika banner dalam kondisi 'completed' sampai tombol Oke diklik)
// ─────────────────────────────────────────────
function hideModuleBroker(moduleId) {
  const wrapper = document.querySelector(`[data-module-card="${moduleId}"]`);
  if (!wrapper) return;
  const banner = wrapper.querySelector('.module-broker-banner');
  if (!banner) return;
  if (banner.classList.contains('completed')) return;

  banner.classList.remove('visible');
  setTimeout(() => banner.remove(), 350);
}