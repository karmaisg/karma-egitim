// Aşama 2 arayüzü: video yükleme, kontrol soruları, özel oynatıcı, katılım raporları.
// app.js'deki yardımcılar (h, api, toast, openModal, formModal, confirmModal...) çağrı anında kullanılır.
'use strict';

const EVENT_LABELS = {
  giris: 'Sisteme giriş yaptı',
  cikis: 'Sistemden çıkış yaptı',
  konu_acildi: 'Konuyu açtı',
  sekme_degisti: 'Sekmeden ayrıldı (video duraklatıldı)',
  sekmeye_dondu: 'Sekmeye geri döndü',
  konudan_ayrildi: 'Konudan ayrıldı',
  ileri_sarma_engellendi: 'İleri sarma engellendi',
  kontrol_sorusu_dogru: 'Kontrol sorusu: doğru cevap',
  kontrol_sorusu_yanlis: 'Kontrol sorusu: yanlış cevap',
  konu_tamamlandi: 'Konuyu tamamladı',
};

function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const hh = Math.floor(sec / 3600); const mm = Math.floor((sec % 3600) / 60); const ss = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}
const fmtMB = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : (b / 1024 ** 2).toFixed(1) + ' MB');
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

// "1:30" veya "90" biçimindeki zamanı saniyeye çevirir
function parseTime(text) {
  const t = String(text).trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(\d+):([0-5]?\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  throw new Error('Zamanı "dakika:saniye" (örn. 1:30) veya saniye (örn. 90) olarak yazın.');
}

// ---------- Video yükleme (yönetici) ----------
function readDuration(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const fail = () => { URL.revokeObjectURL(url); reject(new Error('Video süresi okunamadı. Dosya bozuk veya bu tarayıcıda desteklenmiyor olabilir (MP4/H.264 önerilir).')); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      if (Number.isFinite(v.duration) && v.duration >= 1) resolve(v.duration); else fail();
    };
    v.onerror = fail;
    v.src = url;
  });
}

async function putPart(topicId, st, n, blob) {
  const url = `/api/admin/topics/${topicId}/video/part?key=${encodeURIComponent(st.key)}&upload_id=${encodeURIComponent(st.upload_id)}&n=${n}`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream', 'x-karma-upload': '1' }, body: blob });
      if (res.ok) return await res.json();
      let msg = 'Yükleme başarısız.';
      try { msg = (await res.json()).error || msg; } catch { /* boş */ }
      if (res.status < 500) throw new Error(msg);
      lastErr = new Error(msg);
    } catch (e) {
      if (e.message && !/Failed to fetch|NetworkError|Load failed/i.test(e.message)) throw e;
      lastErr = new Error('Bağlantı koptu.');
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  throw lastErr;
}

async function uploadVideo(topicId, file, onProgress) {
  if (!['video/mp4', 'video/webm'].includes(file.type)) throw new Error('Yalnızca MP4 veya WebM video yüklenebilir.');
  const duration = await readDuration(file);
  const st = await api('POST', `/api/admin/topics/${topicId}/video/start`, { type: file.type, size: file.size });
  const CHUNK = 16 * 1024 * 1024;
  const parts = [];
  for (let off = 0, n = 1; off < file.size; off += CHUNK, n++) {
    parts.push(await putPart(topicId, st, n, file.slice(off, off + CHUNK)));
    onProgress(Math.min(off + CHUNK, file.size) / file.size);
  }
  await api('POST', `/api/admin/topics/${topicId}/video/complete`, { key: st.key, upload_id: st.upload_id, type: file.type, name: file.name, duration, parts });
}

function videoModal(topic, reload) {
  const status = h('p', {}, topic.has_video
    ? ['Mevcut video: ', h('b', {}, topic.video_name || 'video'), ` — ${fmtDur(topic.video_duration)}, ${fmtMB(topic.video_size || 0)}`]
    : 'Bu konuda henüz video yok.');
  const input = h('input', { type: 'file', accept: 'video/mp4,video/webm', id: 'video_file' });
  const bar = h('progress', { max: 100, value: 0, class: 'hidden' });
  const barText = h('span', { class: 'muted small' });
  const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const upload = h('button', { class: 'btn btn-primary', type: 'button' }, topic.has_video ? 'Videoyu değiştir' : 'Videoyu yükle');
  const remove = topic.has_video ? h('button', { class: 'btn btn-danger', type: 'button' }, 'Videoyu kaldır') : null;
  let busy = false;

  const dlg = openModal({
    title: 'Video — ' + topic.title,
    body: h('div', { class: 'modal-body' }, status,
      h('div', { class: 'callout' }, 'Videoyu yüklemeden önce 720p çözünürlüğe küçültmeniz önerilir (HandBrake gibi ücretsiz bir programla). Böylece 8-10 saatlik içerik ücretsiz depolama kotasına sığar. Yükleme sırasında bu pencereyi kapatmayın.'),
      errorBox, h('div', { class: 'field' }, h('label', { for: 'video_file' }, 'Video dosyası (MP4 veya WebM)'), input), bar, barText),
    footer: h('div', { class: 'modal-foot' }, remove, h('button', { class: 'btn', type: 'button', onclick: () => { if (!busy) dlg.close(); } }, 'Kapat'), upload),
  });
  dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });

  upload.addEventListener('click', async () => {
    const file = input.files[0];
    errorBox.classList.add('hidden');
    if (!file) { errorBox.textContent = 'Lütfen bir video dosyası seçin.'; errorBox.classList.remove('hidden'); return; }
    busy = true; upload.disabled = true; if (remove) remove.disabled = true;
    bar.classList.remove('hidden');
    try {
      await uploadVideo(topic.id, file, (f) => { bar.value = Math.round(f * 100); barText.textContent = `%${Math.round(f * 100)} yüklendi`; });
      busy = false; toast('Video yüklendi.'); dlg.close(); reload();
    } catch (e) {
      busy = false; upload.disabled = false; if (remove) remove.disabled = false;
      errorBox.textContent = e.message; errorBox.classList.remove('hidden'); bar.classList.add('hidden'); barText.textContent = '';
    }
  });
  if (remove) {
    remove.addEventListener('click', () => confirmModal({
      title: 'Videoyu kaldır', message: 'Video ve bu konuya ait kontrol soruları silinsin mi?', confirmLabel: 'Evet, kaldır',
      onConfirm: async () => { await api('DELETE', `/api/admin/topics/${topic.id}/video`); toast('Video kaldırıldı.'); dlg.close(); reload(); },
    }));
  }
}

// ---------- Kontrol soruları (yönetici) ----------
async function checkpointsModal(topic, reload) {
  const { checkpoints } = await api('GET', `/api/admin/topics/${topic.id}/checkpoints`);
  let dlg;
  const reopen = () => { if (dlg && dlg.open) dlg.close(); checkpointsModal(topic, reload); };

  const form = (cp) => {
    const opts = cp ? cp.options : [];
    formModal({
      title: cp ? 'Soruyu düzenle' : 'Yeni kontrol sorusu',
      intro: `Video süresi ${fmtDur(topic.video_duration)}. Soru bu saniyede çıkar ve doğru cevaplanmadan video devam etmez.`,
      fields: [
        { name: 'at', label: 'Soru zamanı (dk:sn)', required: true, value: cp ? fmtDur(cp.at_second) : '', placeholder: 'Örn: 2:30', full: false },
        { name: 'correct', label: 'Doğru seçenek', type: 'select', value: cp ? cp.correct + 1 : 1, full: false,
          options: [1, 2, 3, 4].map((n) => ({ value: n, label: n + '. seçenek' })) },
        { name: 'question', label: 'Soru', type: 'textarea', rows: 3, required: true, value: cp?.question },
        ...[0, 1, 2, 3].map((i) => ({ name: 'o' + i, label: `${i + 1}. seçenek` + (i < 2 ? '' : ' (isteğe bağlı)'), required: i < 2, value: opts[i] || '', max: 200 })),
      ],
      onSubmit: async (v) => {
        const filled = [0, 1, 2, 3].map((i) => v['o' + i].trim());
        const chosen = Number(v.correct) - 1;
        if (!filled[chosen]) throw new Error('Doğru olarak işaretlediğiniz seçenek boş.');
        const options = filled.filter(Boolean);
        const correct = filled.slice(0, chosen).filter(Boolean).length;
        const body = { at_second: parseTime(v.at), question: v.question, options, correct };
        if (cp) await api('PUT', `/api/admin/checkpoints/${cp.id}`, body); else await api('POST', `/api/admin/topics/${topic.id}/checkpoints`, body);
        toast('Soru kaydedildi.'); reopen(); reload();
      },
    });
  };
  const del = (cp) => confirmModal({
    title: 'Soruyu sil', message: 'Bu kontrol sorusu silinsin mi?',
    onConfirm: async () => { await api('DELETE', `/api/admin/checkpoints/${cp.id}`); reopen(); reload(); },
  });

  dlg = openModal({
    title: 'Kontrol soruları — ' + topic.title,
    body: h('div', { class: 'modal-body' },
      h('p', { class: 'muted small' }, 'Videonun belirlediğiniz saniyelerinde kısa sorular çıkar. Katılımcı doğru cevap vermeden videoya devam edemez (Yönetmelik md. 12/5).'),
      checkpoints.length === 0 ? h('div', { class: 'empty small' }, 'Henüz kontrol sorusu yok.')
        : checkpoints.map((c) => h('div', { class: 'topic-row' },
          h('span', { class: 'topic-no' }, fmtDur(c.at_second)),
          h('div', { class: 't-title' }, h('b', {}, c.question), h('span', { class: 'sub' }, c.options.map((o, i) => (i === c.correct ? '✓ ' : '') + o).join('  ·  '))),
          h('button', { class: 'btn btn-sm', onclick: () => form(c) }, 'Düzenle'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: () => del(c) }, 'Sil')))),
    footer: h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Kapat'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => form(null) }, '+ Soru ekle')),
  });
  dlg.classList.add('wide');
}

// ---------- Raporlar (yönetici) ----------
function downloadCsv(filename, rows) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const text = '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function showActivity(row) {
  const r = await api('GET', `/api/admin/reports/activity?user_id=${row.user_id}&course_id=${row.course_id}`);
  const dlg = openModal({
    title: `${row.full_name} — ${row.course_title}`,
    body: h('div', { class: 'modal-body' },
      h('h3', {}, 'Kontrol soruları'),
      r.answers.length === 0 ? h('p', { class: 'muted small' }, 'Cevaplanmış kontrol sorusu yok.')
        : h('div', { class: 'table-wrap card' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Tarih', 'Konu', 'Süre', 'Soru', 'Sonuç'].map((t) => h('th', {}, t)))),
          h('tbody', {}, r.answers.map((a) => h('tr', {}, h('td', {}, fmtDateTime(a.answered_at)), h('td', {}, a.topic_title), h('td', {}, fmtDur(a.at_second)),
            h('td', {}, a.question), h('td', {}, a.is_correct ? h('span', { class: 'chip chip-ok' }, 'Doğru') : h('span', { class: 'chip chip-red' }, 'Yanlış'))))))),
      h('h3', {}, 'Etkinlik günlüğü'),
      r.events.length === 0 ? h('p', { class: 'muted small' }, 'Kayıt yok.')
        : h('div', { class: 'table-wrap card' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Tarih', 'Olay', 'Konu', 'Ayrıntı'].map((t) => h('th', {}, t)))),
          h('tbody', {}, r.events.map((e) => h('tr', {}, h('td', {}, fmtDateTime(e.created_at)), h('td', {}, EVENT_LABELS[e.event] || e.event), h('td', {}, e.topic_title || '—'), h('td', {}, e.detail || '')))))),
    ),
    footer: h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', onclick: () => downloadCsv(`etkinlik-${row.username}.csv`, [['Tarih', 'Olay', 'Konu', 'Ayrıntı'], ...r.events.map((e) => [fmtDateTime(e.created_at), EVENT_LABELS[e.event] || e.event, e.topic_title || '', e.detail || ''])]) }, 'CSV indir'),
      h('button', { class: 'btn btn-primary', onclick: () => dlg.close() }, 'Kapat')),
  });
  dlg.classList.add('wide');
}

async function adminReports() {
  const { rows } = await api('GET', '/api/admin/reports/progress');
  const courseTitles = [...new Map(rows.map((r) => [r.course_id, r.course_title])).entries()];
  const courseSel = h('select', { 'aria-label': 'Eğitim' }, h('option', { value: '' }, 'Tüm eğitimler'), courseTitles.map(([id, t]) => h('option', { value: id }, t)));
  const search = h('input', { type: 'search', placeholder: 'Katılımcı ara…', 'aria-label': 'Ara' });
  const box = h('div', { class: 'card table-wrap' });
  let shown = [];

  function draw() {
    const q = search.value.trim().toLocaleLowerCase('tr');
    shown = rows.filter((r) => (!courseSel.value || String(r.course_id) === courseSel.value) &&
      (!q || r.full_name.toLocaleLowerCase('tr').includes(q) || r.username.includes(q) || (r.company_name || '').toLocaleLowerCase('tr').includes(q)));
    box.replaceChildren(shown.length === 0 ? h('div', { class: 'empty' }, rows.length ? 'Eşleşen kayıt yok.' : 'Henüz atama yapılmamış.')
      : h('table', {}, h('thead', {}, h('tr', {}, ['Katılımcı', 'Eğitim', 'İlerleme', 'İzleme süresi', 'Son giriş', 'Son etkinlik', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, shown.map((r) => h('tr', {},
          h('td', {}, h('b', {}, r.full_name), h('span', { class: 'sub' }, [r.company_name, r.username].filter(Boolean).join(' · '))),
          h('td', {}, r.course_title),
          h('td', {}, h('div', { class: 'prog' }, h('progress', { max: 100, value: r.percent }), h('span', {}, `%${r.percent}`)),
            h('span', { class: 'sub' }, `${r.topics_completed} / ${r.topics_total} konu`)),
          h('td', {}, fmtDur(r.watched_seconds)), h('td', {}, fmtDateTime(r.last_login)), h('td', {}, fmtDateTime(r.last_activity)),
          h('td', {}, h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', onclick: () => showActivity(r).catch((e) => toast(e.message, true)) }, 'Ayrıntı'))))))));
  }
  courseSel.addEventListener('change', draw); search.addEventListener('input', draw);
  draw();

  const exportCsv = () => downloadCsv('katilim-raporu.csv', [
    ['Ad soyad', 'Kullanıcı adı', 'T.C. kimlik no', 'Firma', 'Görev', 'Eğitim', 'Tamamlanan konu', 'Toplam konu', 'İlerleme %', 'İzleme süresi', 'İlk etkinlik', 'Son etkinlik', 'Son giriş'],
    ...shown.map((r) => [r.full_name, r.username, r.tc_no || '', r.company_name || '', r.job_title || '', r.course_title, r.topics_completed, r.topics_total, r.percent,
      fmtDur(r.watched_seconds), fmtDateTime(r.first_activity), fmtDateTime(r.last_activity), fmtDateTime(r.last_login)]),
  ]);

  adminPage('reports', h('div', {},
    pageHead('Katılım raporları', 'Giriş, izleme süresi, tamamlama oranı ve kontrol soruları (Yönetmelik md. 12/4, 17/2)',
      h('button', { class: 'btn', onclick: exportCsv }, 'CSV indir')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, search), courseSel), h('div', { class: 'stack' }, box)));
}

// ---------- Özel video oynatıcı (katılımcı) ----------
// - İleri sarma yok: ilerleme çubuğu tıklanamaz, yalnızca "10 sn geri" vardır; sunucu da konumu doğrular.
// - Sekme/pencere değişince video duraklar ve olay kaydedilir.
// - Belirlenen saniyelerde kontrol sorusu çıkar; doğru cevaplanmadan devam edilmez.
function createPlayer(topic, { onCompleted }) {
  const dur = topic.video_duration;
  let serverMax = topic.progress.max_position;
  let furthest = serverMax;
  let completed = topic.progress.completed;
  let questionOpen = false;
  let timer = null;
  let destroyed = false;

  const pending = () => topic.checkpoints.filter((c) => !c.answered).sort((a, b) => a.at_second - b.at_second);
  const allowedMax = () => {
    const p = pending()[0];
    const base = completed ? dur : Math.max(serverMax, furthest);
    return p ? Math.min(base, p.at_second) : base;
  };

  const video = h('video', {
    playsinline: '', preload: 'metadata', disablepictureinpicture: '',
    controlslist: 'nodownload noplaybackrate noremoteplayback', src: `/api/my/topics/${topic.id}/video`,
  });
  video.disablePictureInPicture = true;
  const notice = h('div', { class: 'player-notice hidden' });
  const questionBox = h('div', { class: 'player-question hidden' });
  const playBtn = h('button', { class: 'btn btn-sm', type: 'button' }, '▶ Oynat');
  const backBtn = h('button', { class: 'btn btn-sm', type: 'button', title: '10 saniye geri' }, '⟲ 10 sn');
  const muteBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Ses: açık');
  const fsTarget = h('div', { class: 'player' });
  const canFs = !!(fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen);
  const fsBtn = canFs ? h('button', { class: 'btn btn-sm', type: 'button' }, 'Tam ekran') : null;
  const bar = h('progress', { max: dur, value: 0, 'aria-label': 'Video ilerlemesi' });
  const timeLabel = h('span', { class: 'ptime' }, `0:00 / ${fmtDur(dur)}`);
  const completedBadge = h('span', { class: 'chip chip-ok' + (completed ? '' : ' hidden') }, 'Konu tamamlandı');

  const ui = () => {
    bar.value = video.currentTime || 0;
    timeLabel.textContent = `${fmtDur(video.currentTime)} / ${fmtDur(dur)}`;
    playBtn.textContent = video.paused ? '▶ Oynat' : '⏸ Duraklat';
  };

  const postEvent = (event, keepalive = false) => {
    fetch(`/api/my/topics/${topic.id}/event`, {
      method: 'POST', credentials: 'same-origin', keepalive, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }),
    }).catch(() => {});
  };

  async function sendHb(playing, position) {
    if (destroyed) return;
    const p = pending()[0];
    const pos = position ?? Math.min(video.currentTime || 0, p ? p.at_second : Infinity);
    try {
      const r = await api('POST', `/api/my/topics/${topic.id}/heartbeat`, { position: pos, playing });
      if (destroyed || r.preview) return;
      if (typeof r.max_position === 'number') { serverMax = Math.max(serverMax, r.max_position); }
      if (r.clamped) {
        video.currentTime = Math.min(video.currentTime, serverMax);
        toast('Videoyu ileri saramazsınız.', true);
      }
      if (r.completed && !completed) {
        completed = true; completedBadge.classList.remove('hidden'); toast('Bu konuyu tamamladınız.');
        if (onCompleted) onCompleted();
      }
    } catch (e) {
      if (e.status === 401) { video.pause(); toast('Oturumunuz sona erdi. Lütfen tekrar giriş yapın.', true); }
    }
  }

  function showQuestion(cp) {
    questionOpen = true;
    const feedback = h('p', { class: 'pq-feedback' });
    const buttons = cp.options.map((text, i) => {
      const b = h('button', { class: 'btn pq-option', type: 'button' }, text);
      b.addEventListener('click', async () => {
        buttons.forEach((x) => { x.disabled = true; });
        try {
          const r = await api('POST', `/api/my/checkpoints/${cp.id}/answer`, { selected: i });
          if (r.correct) {
            cp.answered = true; questionOpen = false;
            questionBox.classList.add('hidden'); questionBox.replaceChildren();
            await sendHb(false);
            video.play().catch(() => {});
          } else {
            feedback.textContent = 'Yanlış cevap. Lütfen tekrar deneyin.';
            buttons.forEach((x) => { x.disabled = false; });
          }
        } catch (e) {
          feedback.textContent = e.message;
          buttons.forEach((x) => { x.disabled = false; });
        }
      });
      return b;
    });
    questionBox.replaceChildren(h('p', { class: 'pq-label' }, 'Kontrol sorusu'), h('h3', {}, cp.question), h('div', { class: 'pq-options' }, buttons), feedback);
    questionBox.classList.remove('hidden');
  }

  // --- Olaylar ---
  video.addEventListener('loadedmetadata', () => {
    const start = completed ? 0 : Math.min(topic.progress.last_position || 0, serverMax);
    if (start > 1) video.currentTime = start;
    ui();
  });
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime;
    if (!video.seeking && t <= allowedMax() + 1.5) furthest = Math.max(furthest, t);
    const p = pending()[0];
    if (p && t >= p.at_second && !questionOpen) {
      video.pause();
      video.currentTime = Math.min(video.currentTime, p.at_second);
      sendHb(false, p.at_second);
      showQuestion(p);
    }
    ui();
  });
  video.addEventListener('seeking', () => {
    const lim = allowedMax();
    if (video.currentTime > lim + 1) video.currentTime = lim;
  });
  video.addEventListener('ratechange', () => { if (video.playbackRate !== 1) video.playbackRate = 1; });
  video.addEventListener('play', () => {
    notice.classList.add('hidden');
    sendHb(true);
    clearInterval(timer);
    timer = setInterval(() => { if (!video.paused) sendHb(true); }, 15000);
    ui();
  });
  video.addEventListener('pause', () => { clearInterval(timer); if (!video.ended) sendHb(false); ui(); });
  video.addEventListener('ended', () => { clearInterval(timer); sendHb(true, dur); ui(); });
  video.addEventListener('error', () => {
    notice.textContent = 'Video yüklenemedi. Lütfen sayfayı yenileyin; sorun sürerse yöneticinize bildirin.';
    notice.classList.remove('hidden');
  });
  video.addEventListener('contextmenu', (e) => e.preventDefault());

  const toggle = () => { if (questionOpen) return; if (video.paused) video.play().catch(() => {}); else video.pause(); };
  playBtn.addEventListener('click', toggle);
  video.addEventListener('click', toggle);
  backBtn.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
  muteBtn.addEventListener('click', () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? 'Ses: kapalı' : 'Ses: açık'; });
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else (fsTarget.requestFullscreen || fsTarget.webkitRequestFullscreen).call(fsTarget);
    });
  }

  const onVis = () => {
    if (document.hidden) {
      if (!video.paused) {
        video.pause();
        notice.textContent = 'Sekmeden ayrıldığınız için video duraklatıldı. Devam etmek için “Oynat”a basın.';
        notice.classList.remove('hidden');
      }
      postEvent('tab_hidden');
    } else {
      postEvent('tab_visible');
    }
  };
  const onPageHide = () => postEvent('left', true);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', onPageHide);
  postEvent('opened');

  fsTarget.append(video, notice, questionBox);
  const el = h('div', { class: 'player-wrap' }, fsTarget,
    h('div', { class: 'player-bar' }, playBtn, backBtn, bar, timeLabel, muteBtn, fsBtn),
    h('div', { class: 'row' }, completedBadge, h('span', { class: 'muted small' }, 'Video ileri sarılamaz. Sekmeden ayrılırsanız video duraklar. Bazı noktalarda kontrol soruları çıkar.')));

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
      postEvent('left', true);
      video.pause(); video.removeAttribute('src'); video.load();
    },
  };
}

// ---------- Katılımcı sayfaları ----------
function topicStatus(t) {
  const p = t.progress || {};
  if (p.completed) return h('span', { class: 'chip chip-ok' }, 'Tamamlandı');
  if (t.has_video && t.video_duration && p.max_position > 0) return h('span', { class: 'chip' }, `%${Math.min(99, Math.round((p.max_position * 100) / t.video_duration))}`);
  return null;
}

async function learnerCourse(id) {
  const { course, sections } = await api('GET', `/api/my/courses/${id}`);
  const all = sections.flatMap((s) => s.topics);
  const done = all.filter((t) => t.progress?.completed).length;
  const percent = all.length ? Math.round((done * 100) / all.length) : 0;
  learnerPage(h('div', {},
    h('div', { class: 'crumbs' }, h('a', { href: '#/learner' }, 'Eğitimlerim'), h('span', {}, '/'), course.title),
    pageHead(course.title, course.description || null),
    all.length ? h('div', { class: 'card card-pad course-progress' },
      h('div', { class: 'prog' }, h('progress', { max: 100, value: percent }), h('b', {}, `%${percent}`)),
      h('span', { class: 'muted small' }, `${done} / ${all.length} konu tamamlandı`)) : null,
    sections.length === 0 ? h('div', { class: 'card empty' }, 'Bu eğitimin içeriği henüz hazırlanıyor.')
      : sections.map((s, si) => h('section', { class: 'card learn-section' },
        h('div', { class: 'section-head' }, h('span', { class: 'section-no' }, si + 1), h('h3', {}, s.title)),
        s.topics.length === 0 ? h('div', { class: 'empty small' }, 'Bu bölümde henüz konu yok.') : null,
        s.topics.map((t, ti) => h('a', { class: 'learn-topic', href: `#/learner/course/${id}/topic/${t.id}` },
          h('span', { class: 'topic-no' }, `${si + 1}.${ti + 1}`), h('span', {}, t.title),
          t.has_video ? h('span', { class: 'muted small' }, 'Video · ' + fmtDur(t.video_duration)) : null,
          topicStatus(t), h('span', { class: 'arrow' }, '→')))))), true);
}

async function learnerTopic(courseId, topicId) {
  const [{ topic }, { course, sections }] = await Promise.all([api('GET', `/api/my/topics/${topicId}`), api('GET', `/api/my/courses/${courseId}`)]);
  if (topic.course_id !== Number(courseId)) throw new Error('Konu bulunamadı.');
  const flat = sections.flatMap((s) => s.topics.map((t) => ({ ...t, section: s.title })));
  const i = flat.findIndex((t) => t.id === topic.id);
  const nav = (x, label, cls) => (x ? h('a', { class: 'btn ' + cls, href: `#/learner/course/${courseId}/topic/${x.id}` }, label) : h('span', {}));

  const parts = [];
  let player = null;
  if (topic.has_video) {
    player = createPlayer(topic, {});
    state.cleanup = () => player.destroy();
    parts.push(player.el);
  } else {
    fetch(`/api/my/topics/${topic.id}/event`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'opened' }) }).catch(() => {});
  }

  if (topic.content) parts.push(h('div', { class: 'content-box' }, topic.content));
  else if (!topic.has_video) parts.push(h('p', { class: 'muted' }, 'Bu konunun içeriği henüz eklenmedi.'));

  if (!topic.has_video) {
    const doneBtn = h('button', { class: 'btn btn-primary', type: 'button' }, topic.progress.completed ? 'Tamamlandı ✓' : 'Konuyu tamamladım');
    doneBtn.disabled = topic.progress.completed;
    doneBtn.addEventListener('click', async () => {
      doneBtn.disabled = true;
      try { await api('POST', `/api/my/topics/${topic.id}/complete`); doneBtn.textContent = 'Tamamlandı ✓'; toast('Bu konuyu tamamladınız.'); }
      catch (e) { toast(e.message, true); doneBtn.disabled = false; }
    });
    parts.push(h('div', {}, doneBtn));
  }

  learnerPage(h('div', {},
    h('div', { class: 'crumbs' }, h('a', { href: '#/learner' }, 'Eğitimlerim'), h('span', {}, '/'),
      h('a', { href: '#/learner/course/' + courseId }, course.title), h('span', {}, '/'), flat[i]?.section || ''),
    h('article', { class: 'card card-pad stack' }, h('h1', {}, topic.title), parts),
    h('div', { class: 'pager' }, nav(flat[i - 1], '← ' + (flat[i - 1]?.title || ''), ''), nav(flat[i + 1], (flat[i + 1]?.title || '') + ' →', 'btn-primary'))), true);
}
