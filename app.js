'use strict';

// ══════════════════════════════════════════════
// KONEKSI REALTIME — sebelumnya Firebase, sekarang WebSocket ke server PHP
// ══════════════════════════════════════════════
const configuredWsUrl = window.RAB_WS_URL || new URLSearchParams(location.search).get('ws');
const WS_URL = configuredWsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8080`;
const PROJECT_ID = new URLSearchParams(location.search).get('project') || 'default';

let ws = null;
let wsReconnectDelay = 1000;

// Configurasi user
const DEBOUNCE = 80;     // Jeda (ms) sebelum data dikirim ke server setelah user berhenti mengetik
const LOCK_TTL = 3000;   // Berapa lama (ms) sebuah sel dianggap "dikunci" oleh seseorang

// User ID & Color — dibuat acak tiap kali halaman dibuka
const myId    = 'user_' + Math.random().toString(36).slice(2, 7);
const myColor = "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
const myName  = prompt("Masukan nama anda") || "User";

// STATE — variabel yang menyimpan data aktif selama halaman terbuka
let tableData    = [];  // Semua baris tabel RAB
let activeLocks  = {};  // Sel mana saja yang sedang diedit (oleh siapa)
let remoteEditors = {}; // Editor remote, dipertahankan sampai menerima editorStop
let debounceMap  = {};  // Penyimpan timer debounce per sel
let editDirtyMap = {};  // Menandai sel yang berubah selama sesi edit aktif
let presenceData = {};  // Daftar pengguna yang sedang online

// Komponen DOM — referensi ke elemen HTML yang sering dipakai
const tableBody       = document.getElementById('tableBody');
const tableEl         = document.getElementById('rabTable');
const tableLoading    = document.getElementById('tableLoading');
const totalValueEl    = document.getElementById('totalValue');
const syncDot         = document.getElementById('syncDot');
const syncText        = document.getElementById('syncText');
const toastCont       = document.getElementById('toastContainer');
const userAvatarBadge = document.getElementById('userAvatarBadge');

// ─────────────────────────────────────────────
// INISIALISASI — dijalankan otomatis saat halaman pertama kali dibuka
// ─────────────────────────────────────────────
(function init() {
  // Tampilkan avatar pengguna di pojok kanan atas
  userAvatarBadge.style.background = myColor;
  userAvatarBadge.textContent = myName.charAt(0);
  userAvatarBadge.title = myName;

  // Pasang tombol "Tambah Baris" dan "Ekspor CSV"
  document.getElementById('btnAddRow').addEventListener('click', addNewRow);
  document.getElementById('btnExport').addEventListener('click', exportCSV);

  // Kirim nama proyek ke server saat pengguna mengetik (dengan jeda 300ms)
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

  // Bersihkan kunci kita di layar sendiri saat tab ditutup.
  // Catatan: server otomatis melepas lock & presence milik kita begitu
  // koneksi WebSocket terputus (event onClose di RTserver.php) — jadi
  // gak perlu trik onDisconnect/beforeunload manual seperti di Firebase.
  window.addEventListener('beforeunload', () => {
    clearMyLocks();
  });

  connectWS();
  setSyncState('connecting');
})();

// ─────────────────────────────────────────────
// Buka koneksi WebSocket ke server realtime, dan pasang semua
// penanganan pesan masuk (gantinya onValue() di versi Firebase)
// ─────────────────────────────────────────────
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = function () {
    wsReconnectDelay = 1000;
    setSyncState('ok');

    ws.send(JSON.stringify({
      type: 'join',
      projectId: PROJECT_ID,
      userId: myId,
    }));

    // Kirim sinyal "saya online", lalu ulangi tiap 3 detik selama koneksi hidup
    sendHeartbeat();
    if (window.__heartbeatInterval) clearInterval(window.__heartbeatInterval);
    window.__heartbeatInterval = setInterval(sendHeartbeat, 3000);
  };

  ws.onmessage = function (event) {
    const msg = JSON.parse(event.data);

    if (msg.type === 'state') {
      // state lengkap dikirim server sekali, begitu kita baru join
      const prevDataLength = tableData.length;
      tableData    = msg.data || [];
      activeLocks  = msg.locks || {};
      remoteEditors = {};
      presenceData = msg.presence || {};

      renderTable(true);
      updateTotal();
      renderPresence();

      const titleEl = document.getElementById('projectName');
      if (titleEl && msg.projectName) titleEl.textContent = msg.projectName;
      return;
    }

    if (msg.type === 'data') {
      const prevDataLength = tableData.length;
      tableData = msg.payload || [];
      if (msg.editor?.key && msg.editor.userId !== myId) {
        activeLocks[msg.editor.key] = msg.editor;
        remoteEditors[msg.editor.key] = msg.editor;
      }
      renderTable(prevDataLength !== tableData.length);
      updateTotal();
      syncRemoteLocks();
      return;
    }

    if (msg.type === 'locks') {
      activeLocks = msg.payload || {};
      renderTable(false);
      syncRemoteLocks();
      return;
    }

    if (msg.type === 'editorStart') {
      if (msg.editor?.key && msg.editor.userId !== myId) {
        activeLocks[msg.editor.key] = msg.editor;
        remoteEditors[msg.editor.key] = msg.editor;
        syncRemoteLocks();
      }
      return;
    }

    if (msg.type === 'editorStop') {
      if (msg.key) {
        delete activeLocks[msg.key];
        delete remoteEditors[msg.key];
        syncRemoteLocks();
      }
      return;
    }

    if (msg.type === 'presence') {
      presenceData = msg.payload || {};
      renderPresence();
      return;
    }

    if (msg.type === 'action') {
      // notifikasi aksi user lain (tambah/hapus baris), muncul di layar kita juga
      showToast(msg.text, 'info');
      return;
    }

    if (msg.type === 'projectName') {
      const titleEl = document.getElementById('projectName');
      if (!titleEl) return;
      // Jangan timpa teks jika pengguna sedang mengedit nama proyek
      if (document.activeElement !== titleEl && msg.payload) {
        titleEl.textContent = msg.payload;
      }
      return;
    }
  };

  ws.onclose = function () {
    setSyncState('offline');
    setTimeout(connectWS, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, 10000);
  };

  ws.onerror = function () {
    ws.close();
  };
}

// ─────────────────────────────────────────────
// Kirim pesan ke server, kalau koneksi lagi gak hidup ya diabaikan
// (nanti kekirim ulang otomatis lewat mekanisme lain begitu reconnect)
// ─────────────────────────────────────────────
function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─────────────────────────────────────────────
// Menyimpan seluruh data tabel ke server
// Dipanggil setiap kali ada perubahan isi sel
// ─────────────────────────────────────────────
function saveToStorage(editor = null) {
  setSyncState('syncing');
  wsSend({ type: 'data', payload: tableData, editor });
  // Tunda status "ok" 200ms agar animasi "menyimpan" terlihat
  setTimeout(() => setSyncState('ok'), 200);
}

// ─────────────────────────────────────────────
// Menyimpan data kunci (lock) ke server
// Dipanggil setiap kali pengguna mulai atau berhenti mengedit sebuah sel
// ─────────────────────────────────────────────
function saveLocksToStorage() {
  wsSend({ type: 'locks', payload: activeLocks });
}

// ─────────────────────────────────────────────
// Menghapus semua kunci milik pengguna ini dari daftar kunci
// Dipanggil saat tab ditutup agar sel tidak terkunci terus untuk orang lain
// ─────────────────────────────────────────────
function clearMyLocks() {
  for (const key in activeLocks) {
    if (activeLocks[key].userId === myId) {
      delete activeLocks[key];
    }
  }
  saveLocksToStorage();
}

// ─────────────────────────────────────────────
// Mengirim sinyal "saya masih online" ke server
// Berisi nama, warna, dan waktu terakhir aktif
// ─────────────────────────────────────────────
function sendHeartbeat() {
  wsSend({
    type: 'presence',
    userId: myId,
    entry: { name: myName, color: myColor, ts: Date.now() },
  });
}

// ─────────────────────────────────────────────
// Menampilkan avatar pengguna lain yang sedang online di header
// Hanya tampilkan yang aktif dalam 10 detik terakhir
// ─────────────────────────────────────────────
function renderPresence() {
  const container = document.getElementById('presenceAvatars');
  if (!container) return;

  container.innerHTML = '';
  const now = Date.now();

  for (const pId in presenceData) {
    if (pId === myId) continue; // Lewati diri sendiri, tidak perlu tampil

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
   RENDER TABLE
   ════════════════════════════════════════════ */

// ─────────────────────────────────────────────
// Menggambar ulang tabel RAB di layar berdasarkan data terbaru
// fullRender=true → hapus dan buat ulang semua baris (dipakai saat jumlah baris berubah)
// fullRender=false → hanya perbarui isi sel yang berubah saja (lebih cepat)
// ─────────────────────────────────────────────
function renderTable(fullRender = false) {
  if (fullRender) {
    tableBody.innerHTML = '';
    for (const item of tableData) {
      tableBody.appendChild(createRow(item));
    }
    tableLoading.style.display = 'none';
    tableEl.style.display = 'table';
  } else {
    for (const item of tableData) {
      patchRow(item);
    }
  }
}

// ─────────────────────────────────────────────
// Membuat satu baris tabel (<tr>) lengkap dengan semua sel dan tombol hapus
// Menerima satu objek item (satu baris RAB) lalu mengembalikan elemen <tr>
// ─────────────────────────────────────────────
function createRow(item) {
  const tr = document.createElement('tr');
  tr.dataset.id = item.id;
  tr.classList.add('row-new');

  // Definisi kolom: nama field, bisa diedit atau tidak, tipe data, posisi teks
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
      // Kolom "jumlah" tidak bisa diedit langsung, nilainya hasil perkalian otomatis
      td.innerHTML = `<span class="cell-editable cell-numeric cell-formatted positive" style="pointer-events:none; user-select:none;">${formatCurrency(item.jumlah)}</span>`;
    } else if (col.editable) {
      // Kolom yang bisa diedit: buat div contenteditable dan pasang semua event
      const div = document.createElement('div');
      div.className = 'cell-editable';
      div.contentEditable = 'true';
      div.spellcheck = false;
      div.dataset.field = col.key;
      div.dataset.itemId = item.id;
      div.dataset.type = col.type;

      if (col.type === 'currency' || col.type === 'number') div.classList.add('cell-numeric');
      if (col.align === 'center') div.classList.add('cell-center');

      div.textContent = displayValue(item[col.key], col.type);
      div.addEventListener('focus',   onCellFocus);
      div.addEventListener('blur',    onCellBlur);
      div.addEventListener('input',   onCellInput);
      div.addEventListener('keydown', onCellKeydown);

      // Jika sel ini sedang dikunci oleh pengguna lain, tampilkan indikator warna
      const lockKey = `${item.id}_${col.key}`;
      const remoteLock = remoteEditors[lockKey] || activeLocks[lockKey];
      if (remoteLock && remoteLock.userId !== myId) {
        div.classList.add('editing-other');
        addTypingLabel(div, remoteLock);
      }

      td.appendChild(div);
    } else {
      // Kolom tidak bisa diedit (misal: nomor urut) — cukup tampilkan teks biasa
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

  // Tambahkan kolom aksi berisi tombol hapus baris
  const tdAct = document.createElement('td');
  tdAct.className = 'td-action col-act';
  tdAct.innerHTML = `
    <button class="btn-del-row" data-id="${item.id}" title="Hapus baris">
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M2 2l9 9M11 2l-9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>`;
  tdAct.querySelector('.btn-del-row').addEventListener('click', () => deleteRow(item.id));
  tr.appendChild(tdAct);

  return tr;
}

// ─────────────────────────────────────────────
// Memperbarui isi sel pada baris yang sudah ada (tanpa menghapus dan membuat ulang)
// Dipakai saat data dari server berubah tapi jumlah baris tetap sama
// ─────────────────────────────────────────────
function patchRow(item) {
  const tr = tableBody.querySelector(`tr[data-id="${item.id}"]`);
  if (!tr) return; // Baris belum ada di DOM, biarkan createRow yang menangani

  tr.querySelectorAll('[data-field]').forEach(cell => {
    const field = cell.dataset.field;
    const lockKey = `${item.id}_${field}`;
    const activeLock = remoteEditors[lockKey] || activeLocks[lockKey];
    const isOtherLocked = activeLock && activeLock.userId !== myId;

    // Jangan timpa sel yang sedang aktif diketik oleh pengguna ini
    if (document.activeElement === cell) return;

    if (field === 'jumlah') {
      // Update kolom jumlah yang dihitung otomatis
      const span = cell.querySelector('span');
      if (span) span.textContent = formatCurrency(item.jumlah);
    } else if (cell.contentEditable === 'true') {
      // Update isi sel jika nilainya berbeda dari yang tampil
      const newVal = displayValue(item[field], cell.dataset.type);
      if (cell.textContent !== newVal) {
        cell.textContent = newVal;
      }

      if (isOtherLocked) {
        // Pertahankan badge yang sama selama lock aktif agar tidak berkedip saat mengetik.
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
   CELL EVENTS — kejadian saat pengguna berinteraksi dengan sel tabel
   ════════════════════════════════════════════ */

// ─────────────────────────────────────────────
// Dipanggil saat pengguna mengklik (fokus ke) sebuah sel
// Memberi warna hijau pada sel dan mengunci sel agar orang lain tahu kita sedang edit
// ─────────────────────────────────────────────
function onCellFocus(e) {
  const cell = e.currentTarget;
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  editDirtyMap[key] = false;
  cell.classList.add('editing-you');
  sendLock(cell.dataset.itemId, cell.dataset.field, true);
  sendEditorPresence(cell, true);
  selectAllContent(cell); // Otomatis pilih semua teks di sel saat diklik
}

// ─────────────────────────────────────────────
// Dipanggil saat pengguna pindah dari sel (blur/klik di tempat lain)
// Menghapus warna hijau, melepas kunci, dan langsung menyimpan perubahan
// ─────────────────────────────────────────────
function onCellBlur(e) {
  const cell = e.currentTarget;
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  const wasDirty = editDirtyMap[key];
  cell.classList.remove('editing-you');
  removeTypingLabel(cell);
  sendLock(cell.dataset.itemId, cell.dataset.field, false);
  sendEditorPresence(cell, false);

  clearTimeout(debounceMap[key]);
  saveCell(cell); // Simpan langsung tanpa menunggu debounce
  delete editDirtyMap[key];

  // Beri tahu user lain sekali saja, setelah sesi edit selesai.
  if (wasDirty) {
    const item = tableData.find(i => i.id === parseInt(cell.dataset.itemId));
    const fieldLabel = {
      uraian: 'Uraian', volume: 'Volume', satuan: 'Satuan',
      harga_satuan: 'Harga Satuan', keterangan: 'Keterangan',
    }[cell.dataset.field] || cell.dataset.field;
    wsSend({ type: 'action', text: `${myName} mengubah ${fieldLabel} pada baris #${item?.no || '?'}` });
  }
}

// ─────────────────────────────────────────────
// Dipanggil setiap kali pengguna mengetik sesuatu di dalam sel
// Menghitung ulang jumlah jika yang diubah adalah volume atau harga satuan,
// lalu menjadwalkan penyimpanan ke server setelah jeda singkat (debounce)
// ─────────────────────────────────────────────
function onCellInput(e) {
  const cell = e.currentTarget;
  const key = `${cell.dataset.itemId}_${cell.dataset.field}`;
  editDirtyMap[key] = true;

  // Jika yang diubah volume atau harga satuan, hitung ulang kolom jumlah secara langsung
  if (cell.dataset.field === 'volume' || cell.dataset.field === 'harga_satuan') {
    updateComputedJumlah(cell);
  }

  // Perbarui timestamp kunci agar tidak kedaluwarsa saat pengguna masih mengetik
  sendLock(cell.dataset.itemId, cell.dataset.field, true);

  // Jadwalkan penyimpanan ke server setelah pengguna berhenti mengetik (debounce)
  clearTimeout(debounceMap[key]);
  debounceMap[key] = setTimeout(() => saveCell(cell), DEBOUNCE);
}

// ─────────────────────────────────────────────
// Dipanggil saat pengguna menekan tombol keyboard di dalam sel
// Enter → pindah ke baris berikutnya pada kolom yang sama
// Escape → keluar dari sel (batal edit)
// ─────────────────────────────────────────────
function onCellKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const nextTr = e.currentTarget.closest('tr')?.nextElementSibling;
    if (nextTr) nextTr.querySelector(`[data-field="${e.currentTarget.dataset.field}"]`)?.focus();
  }
  if (e.key === 'Escape') e.currentTarget.blur();
}

/* ════════════════════════════════════════════
   LOGIKA CRUD & LOCK
   ════════════════════════════════════════════ */

// ─────────────────────────────────────────────
// Menyimpan nilai satu sel ke dalam data lokal lalu kirim ke server
// Hanya menyimpan jika nilai benar-benar berubah (tidak menyimpan ulang yang sama)
// ─────────────────────────────────────────────
function saveCell(cell) {
  const itemId = parseInt(cell.dataset.itemId);
  const field  = cell.dataset.field;
  let rawValue = cell.textContent.trim();

  // Ubah teks angka/mata uang menjadi angka murni sebelum disimpan
  if (cell.dataset.type === 'number' || cell.dataset.type === 'currency') {
    rawValue = parseFloat(rawValue.replace(/[^0-9.-]/g, '')) || 0;
  }

  const itemIndex = tableData.findIndex(i => i.id === itemId);
  if (itemIndex === -1) return;
  const item = tableData[itemIndex];

  // Tidak perlu simpan jika nilainya tidak berubah
  if (item[field] === rawValue) return;

  const patch = { [field]: rawValue };
  // Jika volume atau harga satuan berubah, hitung ulang jumlah harga
  if (field === 'volume' || field === 'harga_satuan') {
    const vol  = field === 'volume' ? rawValue : item.volume;
    const hsat = field === 'harga_satuan' ? rawValue : item.harga_satuan;
    patch.jumlah = vol * hsat;
  }

  Object.assign(item, patch);
  updateTotal();
  saveToStorage({
    key: `${itemId}_${field}`,
    userId: myId,
    name: myName,
    color: myColor,
    ts: Date.now(),
  });

  // TODO: kirim juga ke controller PHP lewat AJAX buat disimpan permanen
  // ke database, terpisah dari jalur WebSocket ini. Contoh:
  // $.post('/rab/save_item', { itemId, field, value: rawValue });
}

// ─────────────────────────────────────────────
// Mengunci atau membuka kunci sebuah sel di server
// isLocking=true → tandai sel sebagai "sedang diedit oleh saya"
// isLocking=false → lepas kunci saat selesai mengedit
// ─────────────────────────────────────────────
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
  wsSend(isEditing ? {
    type: 'editorStart',
    editor: { key, userId: myId, name: myName, color: myColor, ts: Date.now() },
  } : {
    type: 'editorStop',
    key,
    userId: myId,
  });
}

// ─────────────────────────────────────────────
// Menambahkan baris baru kosong ke tabel RAB
// Nomor urut otomatis diisi (lanjutan dari baris terakhir)
// Setelah baris ditambah, kursor langsung pindah ke kolom "Uraian"
// ─────────────────────────────────────────────
function addNewRow() {
  const maxNo = tableData.reduce((m, i) => Math.max(m, i.no || 0), 0);
  const newItem = {
    id:           Date.now(), // ID unik berdasarkan waktu saat ini
    no:           maxNo + 1,
    uraian:       '',
    volume:       0,
    satuan:       'unit',
    harga_satuan: 0,
    jumlah:       0,
    keterangan:   ''
  };

  tableData.push(newItem);
  tableBody.appendChild(createRow(newItem));
  updateTotal();
  saveToStorage();
  wsSend({ type: 'action', text: `${myName} menambahkan baris baru` });

  // Fokus ke kolom "Uraian" pada baris baru setelah 50ms (tunggu DOM selesai)
  setTimeout(() => {
    const lastTr = tableBody.querySelector('tr:last-child');
    lastTr?.querySelector('.cell-editable[data-field="uraian"]')?.focus();
  }, 50);
}

// ─────────────────────────────────────────────
// Menghapus satu baris dari tabel RAB
// Minta konfirmasi dulu, lalu animasi hapus, perbarui nomor urut, dan simpan ke server
// ─────────────────────────────────────────────
function deleteRow(itemId) {
  if (!confirm('Hapus baris ini?')) return;

  tableData = tableData.filter(i => i.id !== itemId);
  // Urutkan ulang nomor baris agar tetap 1, 2, 3, ...
  tableData.forEach((item, idx) => { item.no = idx + 1; });

  // Animasi baris menghilang ke kanan sebelum benar-benar dihapus dari DOM
  const tr = tableBody.querySelector(`tr[data-id="${itemId}"]`);
  if (tr) {
    tr.style.transition = 'opacity .2s, transform .2s';
    tr.style.opacity = '0';
    tr.style.transform = 'translateX(20px)';
    setTimeout(() => tr.remove(), 200);
  }
  updateTotal();
  saveToStorage();
  showToast('Baris dihapus', 'info');
  wsSend({ type: 'action', text: `${myName} menghapus sebuah baris` });
}

/* ════════════════════════════════════════════
   COMPUTED & UTILS — fungsi pembantu
   ════════════════════════════════════════════ */

// ─────────────────────────────────────────────
// Menghitung ulang kolom "Jumlah Harga" saat volume atau harga satuan berubah
// Rumus: Jumlah = Volume × Harga Satuan
// Langsung update tampilan tanpa harus menyimpan ke server dulu
// ─────────────────────────────────────────────
function updateComputedJumlah(editedCell) {
  const itemId = parseInt(editedCell.dataset.itemId);
  const item = tableData.find(i => i.id === itemId);
  if (!item) return;

  const tr = tableBody.querySelector(`tr[data-id="${itemId}"]`);
  if (!tr) return;

  const volCell  = tr.querySelector('[data-field="volume"]');
  const hsatCell = tr.querySelector('[data-field="harga_satuan"]');
  const jmlCell  = tr.querySelector('[data-field="jumlah"] span');

  const vol  = parseFloat(volCell?.textContent) || 0;
  const hsat = parseFloat(hsatCell?.textContent.replace(/[^0-9.-]/g, '')) || 0;
  const jml  = vol * hsat;

  if (jmlCell) jmlCell.textContent = formatCurrency(jml);
  item.jumlah = jml;
  updateTotal();
}

// ─────────────────────────────────────────────
// Menghitung dan menampilkan total semua biaya di bagian bawah tabel
// Menjumlahkan kolom "jumlah" dari semua baris
// ─────────────────────────────────────────────
function updateTotal() {
  const total = tableData.reduce((sum, item) => sum + (item.jumlah || 0), 0);
  totalValueEl.textContent = formatCurrency(total);
}

// ─────────────────────────────────────────────
// Menampilkan label nama pengguna di atas sel yang sedang dikunci orang lain
// Label berwarna sesuai warna pengguna tersebut agar mudah dibedakan
// ─────────────────────────────────────────────
function addTypingLabel(cell, lockInfo) {
  const parentTd = cell.parentElement;

  // Hapus label lama jika ada, supaya tidak duplikat
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

  // Warna label & border cell dikendalikan lewat 1 CSS variable, biar
  // panah label (::after di CSS) ikut warna user yang sama juga
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

// ─────────────────────────────────────────────
// Wrapper tambahan untuk patchRow: setelah update sel,
// reset border dan bayangan pada sel yang tidak sedang dikunci siapapun
// ─────────────────────────────────────────────
const originalPatchRow = patchRow;
patchRow = function (item) {
  originalPatchRow(item);
  const tr = tableBody.querySelector(`tr[data-id="${item.id}"]`);
  if (!tr) return;
  tr.querySelectorAll('.cell-editable').forEach(cell => {
    if (!cell.classList.contains('editing-other') && !cell.classList.contains('editing-you')) {
      cell.style.borderColor = '';
      cell.style.boxShadow = '';
    }
  });
};

// ─────────────────────────────────────────────
// Mengubah tampilan indikator sinkronisasi di header
// 'ok' → titik hijau "Terhubung"
// 'syncing' → titik berputar kuning "Menyimpan..."
// 'connecting' → belum sempat connect sama sekali
// 'offline' → koneksi WebSocket terputus, sedang mencoba nyambung ulang
// ─────────────────────────────────────────────
function setSyncState(state) {
  syncDot.className = 'sync-dot';
  if (state === 'ok') {
    syncText.textContent = 'Terhubung';
  } else if (state === 'syncing') {
    syncDot.classList.add('syncing');
    syncText.textContent = 'Menyimpan...';
  } else if (state === 'connecting') {
    syncText.textContent = 'Menghubungkan...';
  } else if (state === 'offline') {
    syncText.textContent = 'Terputus, menyambung ulang...';
  }
}

// ─────────────────────────────────────────────
// Mengubah angka menjadi format mata uang Rupiah
// Contoh: 1500000 → "Rp 1.500.000"
// ─────────────────────────────────────────────
function formatCurrency(val) {
  if (val == null || isNaN(val)) return 'Rp 0';
  return 'Rp ' + Math.round(val).toLocaleString('id-ID');
}

// ─────────────────────────────────────────────
// Mengubah nilai data menjadi teks siap tampil di sel
// Untuk tipe 'currency': angka diformat dengan titik ribuan (tanpa "Rp")
// Untuk tipe lain: ubah menjadi string biasa
// ─────────────────────────────────────────────
function displayValue(val, type) {
  if (val == null) return '';
  if (type === 'currency') return Math.round(val).toLocaleString('id-ID');
  return String(val);
}

// ─────────────────────────────────────────────
// Memilih semua teks di dalam sebuah elemen secara otomatis
// Dipakai saat pengguna mengklik sel agar bisa langsung menimpa nilai lama
// ─────────────────────────────────────────────
function selectAllContent(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ─────────────────────────────────────────────
// Menampilkan notifikasi pop-up (toast) di pojok kanan bawah layar
// Otomatis menghilang setelah 3 detik
// type: 'info', 'success', 'warn', 'error'
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// Mengekspor seluruh data tabel RAB ke file CSV
// File otomatis terunduh ke komputer dengan nama "RAB_Estimasi.csv"
// BOM (\uFEFF) ditambahkan agar Excel membaca karakter Indonesia dengan benar
// ─────────────────────────────────────────────
function exportCSV() {
  const headers = ['No', 'Uraian Pekerjaan', 'Volume', 'Satuan', 'Harga Satuan', 'Jumlah', 'Keterangan'];
  const rows = tableData.map(item => [item.no, `"${item.uraian}"`, item.volume, item.satuan, item.harga_satuan, item.jumlah, `"${item.keterangan}"`].join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `RAB_Estimasi.csv`;
  a.click();
}

function syncRemoteLocks() {
  tableBody.querySelectorAll('.cell-editable').forEach(cell => {
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