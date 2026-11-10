// KARMA OSGB Eğitim Platformu - ön yüz (bağımlılık yok, tek dosya)
'use strict';

const app = document.getElementById('app');
const state = { user: null };

const HAZARD = { az_tehlikeli: 'Az tehlikeli', tehlikeli: 'Tehlikeli', cok_tehlikeli: 'Çok tehlikeli' };

// ---------- Yardımcılar ----------
// Güvenli öğe oluşturucu: metinler her zaman textContent ile eklenir (XSS'e karşı).
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* boş */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Bir hata oluştu.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, isError = false) {
  const t = h('div', { class: 'toast' + (isError ? ' error' : '') }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), isError ? 6000 : 3500);
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
const go = (hash) => { location.hash = hash; };

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Panoya kopyalandı.'); }
  catch { toast('Kopyalanamadı, lütfen elle seçip kopyalayın.', true); }
}

// ---------- Modal ----------
function openModal({ title, body, footer, onClose }) {
  const dlg = h('dialog', {},
    h('div', { class: 'modal-head' }, h('h2', {}, title),
      h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Kapat', onclick: () => dlg.close() }, '✕')),
    body, footer);
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// fields: [{name,label,type,value,options,required,hint,placeholder,rows,full}]
function formModal({ title, fields, submitLabel = 'Kaydet', intro, onSubmit }) {
  const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const inputs = {};
  const fieldEls = fields.map((f) => {
    let input;
    const id = 'f_' + f.name;
    if (f.type === 'textarea') {
      input = h('textarea', { id, rows: f.rows || 6, placeholder: f.placeholder }); input.value = f.value || '';
    } else if (f.type === 'select') {
      input = h('select', { id }, f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, o.label)));
    } else {
      input = h('input', { id, type: f.type || 'text', placeholder: f.placeholder, autocomplete: f.type === 'password' ? 'new-password' : 'off', maxlength: f.max });
      input.value = f.value || '';
    }
    if (f.required) input.required = true;
    inputs[f.name] = input;
    return h('div', { class: 'field' + (f.full === false ? '' : ' full') },
      h('label', { for: id }, f.label + (f.required ? ' *' : '')), input, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
  });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, submitLabel);
  const form = h('form', { novalidate: false },
    h('div', { class: 'modal-body' }, intro ? h('p', { class: 'muted small' }, intro) : null, errorBox,
      h('div', { class: 'form-grid' }, fieldEls)),
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Vazgeç'), submit));
  const dlg = openModal({ title, body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const values = {};
    for (const f of fields) values[f.name] = inputs[f.name].value;
    submit.disabled = true;
    try {
      await onSubmit(values, dlg);
      if (dlg.open) dlg.close();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
      submit.disabled = false;
    }
  });
  // Odaklama anında yapılır; gecikmeli odaklama, hızlı yazan kullanıcının metnini yanlış alana kaydırabilir.
  const first = fieldEls.length ? Object.values(inputs)[0] : null;
  if (first) first.focus();
  return dlg;
}

function confirmModal({ title, message, confirmLabel = 'Evet, sil', danger = true, onConfirm }) {
  const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const ok = h('button', { class: 'btn ' + (danger ? 'btn-primary' : 'btn-primary'), type: 'button' }, confirmLabel);
  const dlg = openModal({
    title,
    body: h('div', { class: 'modal-body' }, h('p', {}, message), errorBox),
    footer: h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Vazgeç'), ok),
  });
  ok.addEventListener('click', async () => {
    ok.disabled = true;
    try { await onConfirm(); dlg.close(); }
    catch (err) { errorBox.textContent = err.message; errorBox.classList.remove('hidden'); ok.disabled = false; }
  });
}

function credentialsModal(title, username, password) {
  const rows = [];
  if (username) rows.push(['Kullanıcı adı', username]);
  rows.push(['Şifre', password]);
  const dlg = openModal({
    title,
    body: h('div', { class: 'modal-body' },
      h('div', { class: 'callout' }, 'Bu şifre yalnızca şimdi gösterilir, sistemde saklanmaz. Lütfen katılımcıya iletin veya bir yere not edin.'),
      rows.map(([label, value]) => h('div', { class: 'cred' }, h('span', {}, label), h('code', {}, value),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(value) }, 'Kopyala'))),
      username ? h('button', { class: 'btn', type: 'button', onclick: () => copyText(`Kullanıcı adı: ${username}\nŞifre: ${password}`) }, 'İkisini birlikte kopyala') : null),
    footer: h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => dlg.close() }, 'Tamam')),
  });
}

// ---------- Ortak iskelet ----------
function brand(href) {
  return h('a', { class: 'brand', href },
    h('img', { src: '/logo.png', alt: 'KARMA İş Sağlığı Güvenliği' }),
    h('div', { class: 'brand-text' }, h('b', {}, 'Eğitim Platformu')));
}

function layout(navItems, activeKey, content) {
  const isAdmin = state.user.role === 'admin';
  const header = h('header', { class: 'topbar' },
    h('div', { class: 'topbar-inner' },
      brand(isAdmin ? '#/admin' : '#/learner'),
      h('nav', { class: 'nav', 'aria-label': 'Ana menü' },
        navItems.map((n) => h('a', { href: n.href, class: n.key === activeKey ? 'active' : '', 'aria-current': n.key === activeKey ? 'page' : null }, n.label))),
      h('div', { class: 'user-area' },
        h('div', { class: 'user-name' }, state.user.full_name, h('small', {}, isAdmin ? 'Yönetici' : (state.user.company || 'Katılımcı'))),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: changePasswordModal }, 'Şifre'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: logout }, 'Çıkış'))));
  app.replaceChildren(header, h('main', { class: 'page' + (content.narrow ? ' page-narrow' : '') }, content.el));
  window.scrollTo(0, 0);
}

const ADMIN_NAV = [
  { key: 'home', href: '#/admin', label: 'Özet' },
  { key: 'courses', href: '#/admin/courses', label: 'Eğitimler' },
  { key: 'users', href: '#/admin/users', label: 'Katılımcılar' },
  { key: 'companies', href: '#/admin/companies', label: 'Firmalar' },
  { key: 'assignments', href: '#/admin/assignments', label: 'Atamalar' },
  { key: 'reports', href: '#/admin/reports', label: 'Raporlar' },
  { key: 'exams', href: '#/admin/exams', label: 'Sınavlar' },
];
const LEARNER_NAV = [{ key: 'home', href: '#/learner', label: 'Eğitimlerim' }];

const adminPage = (key, el) => layout(ADMIN_NAV, key, { el });

function pageHead(title, subtitle, actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), subtitle ? h('p', {}, subtitle) : null),
    actions ? h('div', { class: 'row' }, actions) : null);
}

function errorPage(err) {
  return h('div', { class: 'card card-pad' }, h('h2', {}, 'Bir sorun oluştu'), h('p', { class: 'muted' }, err.message || String(err)));
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* yine de çıkış yap */ }
  state.user = null;
  go('#/login');
  render();
}

function changePasswordModal() {
  formModal({
    title: 'Şifre değiştir',
    submitLabel: 'Şifreyi değiştir',
    fields: [
      { name: 'current_password', label: 'Mevcut şifre', type: 'password', required: true },
      { name: 'new_password', label: 'Yeni şifre', type: 'password', required: true, hint: 'En az 8 karakter.' },
      { name: 'again', label: 'Yeni şifre (tekrar)', type: 'password', required: true },
    ],
    onSubmit: async (v) => {
      if (v.new_password !== v.again) throw new Error('Yeni şifreler birbiriyle aynı değil.');
      await api('POST', '/api/change-password', { current_password: v.current_password, new_password: v.new_password });
      toast('Şifreniz değiştirildi.');
    },
  });
}

// ---------- Giriş / kurulum ----------
async function loginPage() {
  let needSetup = false;
  try { needSetup = (await api('GET', '/api/setup-status')).needed; } catch { /* giriş formu gösterilir */ }
  const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, needSetup ? 'Kurulumu tamamla' : 'Giriş yap');

  const fields = needSetup
    ? [
      field('setup_code', 'Kurulum kodu', 'password', 'Cloudflare ayarlarında belirlediğiniz SETUP_CODE değeri.'),
      field('full_name', 'Ad soyad', 'text'),
      field('username', 'Yönetici kullanıcı adı', 'text', 'Küçük harf, rakam, nokta veya tire. Örn: yonetici'),
      field('password', 'Şifre', 'password', 'En az 8 karakter.'),
    ]
    : [field('username', 'Kullanıcı adı', 'text'), field('password', 'Şifre', 'password')];

  function field(name, label, type, hint) {
    const attrs = { id: 'a_' + name, name, type, required: true, autocomplete: type === 'password' ? (needSetup ? 'new-password' : 'current-password') : 'username', autocapitalize: 'none', spellcheck: 'false' };
    return h('div', { class: 'field' }, h('label', { for: 'a_' + name }, label), h('input', attrs), hint ? h('span', { class: 'hint' }, hint) : null);
  }

  const form = h('form', {}, errorBox, fields, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const data = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    try {
      await api('POST', needSetup ? '/api/setup' : '/api/login', data);
      await loadUser();
      go(state.user.role === 'admin' ? '#/admin' : '#/learner');
      render();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.classList.remove('hidden');
      submit.disabled = false;
    }
  });

  app.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'card auth-card' },
      h('img', { class: 'auth-logo', src: '/logo.png', alt: 'KARMA İş Sağlığı Güvenliği' }),
      h('h1', {}, 'Eğitim Platformu'),
      h('p', { class: 'lead' }, needSetup ? 'İlk kurulum: yönetici hesabınızı oluşturun.' : 'Hesabınızla giriş yaparak size atanan eğitimlere ulaşın.'),
      form,
      h('p', { class: 'auth-foot' }, 'KARMA İş Sağlığı Güvenliği'))));
  form.querySelector('input').focus();
}

// ---------- Yönetici: özet ----------
async function adminHome() {
  const s = await api('GET', '/api/admin/summary');
  const stat = (n, label) => h('div', { class: 'card stat' }, h('b', {}, n), h('span', {}, label));
  adminPage('home', h('div', {},
    pageHead('Hoş geldiniz, ' + state.user.full_name.split(' ')[0], 'Eğitim platformunuzun genel durumu'),
    h('div', { class: 'grid grid-stats' },
      stat(s.learners, 'Aktif katılımcı'), stat(s.courses, 'Eğitim'), stat(s.assignments, 'Atama'), stat(s.companies, 'Firma')),
    h('h2', { class: 'section-title' }, 'Başlarken'),
    h('ol', { class: 'steps', style: null },
      h('li', {}, h('span', {}, h('a', { href: '#/admin/companies' }, 'Firma ekleyin'), ' — müşteri firmalarınızı ve tehlike sınıflarını tanımlayın.')),
      h('li', {}, h('span', {}, h('a', { href: '#/admin/courses' }, 'Eğitim oluşturun'), ' — bölümler ve alt konularıyla eğitim içeriğini hazırlayın.')),
      h('li', {}, h('span', {}, h('a', { href: '#/admin/users' }, 'Katılımcı ekleyin'), ' — kullanıcı adı ve şifre otomatik oluşturulur.')),
      h('li', {}, h('span', {}, h('a', { href: '#/admin/assignments' }, 'Eğitim atayın'), ' — katılımcılar yalnızca kendilerine atanan eğitimleri görür.')))));
}

// ---------- Yönetici: firmalar ----------
async function adminCompanies() {
  const { companies } = await api('GET', '/api/admin/companies');
  const hazardOptions = Object.entries(HAZARD).map(([value, label]) => ({ value, label }));
  const edit = (c) => formModal({
    title: c ? 'Firmayı düzenle' : 'Yeni firma',
    fields: [
      { name: 'name', label: 'Firma adı', required: true, value: c?.name, max: 150 },
      { name: 'hazard_class', label: 'Tehlike sınıfı', type: 'select', options: hazardOptions, value: c?.hazard_class || 'az_tehlikeli',
        hint: 'Temel eğitim süresi ve tekrar periyodu tehlike sınıfına göre belirlenir.' },
    ],
    onSubmit: async (v) => {
      if (c) await api('PUT', `/api/admin/companies/${c.id}`, v); else await api('POST', '/api/admin/companies', v);
      toast('Firma kaydedildi.'); render();
    },
  });
  const del = (c) => confirmModal({
    title: 'Firmayı sil', message: `"${c.name}" firması silinsin mi?`,
    onConfirm: async () => { await api('DELETE', `/api/admin/companies/${c.id}`); toast('Firma silindi.'); render(); },
  });
  adminPage('companies', h('div', {},
    pageHead('Firmalar', 'Hizmet verdiğiniz firmalar ve tehlike sınıfları', h('button', { class: 'btn btn-primary', onclick: () => edit(null) }, '+ Yeni firma')),
    h('div', { class: 'card table-wrap' }, companies.length === 0
      ? h('div', { class: 'empty' }, 'Henüz firma eklenmemiş.')
      : h('table', {},
        h('thead', {}, h('tr', {}, ['Firma', 'Tehlike sınıfı', 'Katılımcı', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, companies.map((c) => h('tr', {},
          h('td', {}, h('b', {}, c.name)),
          h('td', {}, h('span', { class: 'chip' + (c.hazard_class === 'cok_tehlikeli' ? ' chip-red' : '') }, HAZARD[c.hazard_class])),
          h('td', {}, c.user_count),
          h('td', {}, h('div', { class: 'actions' },
            h('button', { class: 'btn btn-sm', onclick: () => edit(c) }, 'Düzenle'),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => del(c) }, 'Sil'))))))))));
}

// ---------- Yönetici: katılımcılar ----------
async function adminUsers() {
  const [{ users }, { companies }] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/companies')]);
  const companyOptions = [{ value: '', label: '— Firma seçilmedi —' }, ...companies.map((c) => ({ value: c.id, label: c.name }))];

  const userFields = (u) => [
    { name: 'full_name', label: 'Ad soyad', required: true, value: u?.full_name, max: 100 },
    ...(u ? [] : [{ name: 'username', label: 'Kullanıcı adı', required: true, max: 40, hint: 'Küçük harf, rakam, nokta, tire. Örn: ali.yilmaz' }]),
    { name: 'company_id', label: 'Firma', type: 'select', options: companyOptions, value: u?.company_id ?? '', full: false },
    { name: 'job_title', label: 'Görev / unvan', value: u?.job_title, max: 100, full: false },
    { name: 'tc_no', label: 'T.C. kimlik no (belge için)', value: u?.tc_no, max: 11, full: false, hint: 'İsteğe bağlı, 11 haneli.' },
    { name: 'role', label: 'Rol', type: 'select', value: u?.role || 'learner', full: false,
      options: [{ value: 'learner', label: 'Katılımcı' }, { value: 'admin', label: 'Yönetici' }] },
    ...(u ? [] : [{ name: 'password', label: 'Şifre', type: 'password', hint: 'Boş bırakırsanız güvenli bir şifre otomatik oluşturulur.' }]),
  ];

  const create = () => formModal({
    title: 'Yeni katılımcı', fields: userFields(null), submitLabel: 'Oluştur',
    onSubmit: async (v) => {
      const body = { ...v, company_id: v.company_id || null, password: v.password || undefined };
      const r = await api('POST', '/api/admin/users', body);
      render();
      credentialsModal('Katılımcı oluşturuldu', r.username, r.password);
    },
  });
  const edit = (u) => formModal({
    title: 'Katılımcıyı düzenle', fields: userFields(u),
    intro: 'Kullanıcı adı: ' + u.username,
    onSubmit: async (v) => {
      await api('PUT', `/api/admin/users/${u.id}`, { ...v, company_id: v.company_id || null, active: !!u.active });
      toast('Kaydedildi.'); render();
    },
  });
  const reset = (u) => confirmModal({
    title: 'Şifreyi sıfırla', message: `${u.full_name} için yeni bir şifre oluşturulsun mu? Eski şifre geçersiz olur ve açık oturumları kapanır.`,
    confirmLabel: 'Yeni şifre oluştur', danger: false,
    onConfirm: async () => { const r = await api('POST', `/api/admin/users/${u.id}/reset-password`, {}); render(); credentialsModal('Yeni şifre', u.username, r.password); },
  });
  const toggle = (u) => confirmModal({
    title: u.active ? 'Hesabı pasife al' : 'Hesabı aktifleştir',
    message: u.active
      ? `${u.full_name} sisteme giremeyecek. Eğitim kayıtları mevzuat gereği silinmez, saklanmaya devam eder.`
      : `${u.full_name} tekrar giriş yapabilecek.`,
    confirmLabel: u.active ? 'Pasife al' : 'Aktifleştir', danger: false,
    onConfirm: async () => {
      await api('PUT', `/api/admin/users/${u.id}`, { full_name: u.full_name, role: u.role, tc_no: u.tc_no, job_title: u.job_title, company_id: u.company_id, active: !u.active });
      toast('Güncellendi.'); render();
    },
  });

  const search = h('input', { type: 'search', placeholder: 'Ad veya kullanıcı adı ara…', 'aria-label': 'Ara' });
  const companyFilter = h('select', { 'aria-label': 'Firmaya göre filtrele' },
    h('option', { value: '' }, 'Tüm firmalar'), companies.map((c) => h('option', { value: c.id }, c.name)));
  const tbody = h('tbody');
  const tableCard = h('div', { class: 'card table-wrap' });

  function draw() {
    const q = search.value.trim().toLocaleLowerCase('tr');
    const cf = companyFilter.value;
    const rows = users.filter((u) =>
      (!q || u.full_name.toLocaleLowerCase('tr').includes(q) || u.username.includes(q)) && (!cf || String(u.company_id) === cf));
    tbody.replaceChildren(...rows.map((u) => h('tr', { class: u.active ? '' : 'inactive' },
      h('td', {}, h('b', {}, u.full_name), h('span', { class: 'sub' }, u.username)),
      h('td', {}, u.company_name || '—', u.job_title ? h('span', { class: 'sub' }, u.job_title) : null),
      h('td', {}, u.role === 'admin' ? h('span', { class: 'chip chip-red' }, 'Yönetici') : h('span', { class: 'chip' }, 'Katılımcı')),
      h('td', {}, u.active ? h('span', { class: 'chip chip-ok' }, 'Aktif') : h('span', { class: 'chip' }, 'Pasif')),
      h('td', {}, u.assignment_count),
      h('td', {}, h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm', onclick: () => edit(u) }, 'Düzenle'),
        h('button', { class: 'btn btn-sm', onclick: () => reset(u) }, 'Şifre sıfırla'),
        h('button', { class: 'btn btn-sm ' + (u.active ? 'btn-danger' : ''), onclick: () => toggle(u) }, u.active ? 'Pasife al' : 'Aktifleştir'))))));
    tableCard.replaceChildren(rows.length === 0
      ? h('div', { class: 'empty' }, users.length === 0 ? 'Henüz katılımcı eklenmemiş.' : 'Aramanızla eşleşen kayıt yok.')
      : h('table', {}, h('thead', {}, h('tr', {}, ['Ad soyad', 'Firma', 'Rol', 'Durum', 'Atama', ''].map((t) => h('th', {}, t)))), tbody));
  }
  search.addEventListener('input', draw);
  companyFilter.addEventListener('change', draw);
  draw();

  adminPage('users', h('div', {},
    pageHead('Katılımcılar', 'Kullanıcı adı ve şifreleriyle sisteme giriş yapacak kişiler', h('button', { class: 'btn btn-primary', onclick: create }, '+ Yeni katılımcı')),
    h('div', { class: 'row', 'aria-label': 'Filtreler' }, h('div', { class: 'grow' }, search), h('div', {}, companyFilter)),
    h('div', { style: null, class: 'stack' }, tableCard)));
}

// ---------- Yönetici: eğitimler ----------
async function adminCourses() {
  const { courses } = await api('GET', '/api/admin/courses');
  const create = () => formModal({
    title: 'Yeni eğitim',
    fields: [
      { name: 'title', label: 'Eğitim adı', required: true, max: 200, placeholder: 'Örn: Temel İş Sağlığı ve Güvenliği Eğitimi' },
      { name: 'description', label: 'Açıklama', type: 'textarea', rows: 3, hint: 'Katılımcıya gösterilir (isteğe bağlı).' },
    ],
    submitLabel: 'Oluştur',
    onSubmit: async (v) => { const r = await api('POST', '/api/admin/courses', v); go('#/admin/courses/' + r.id); },
  });
  adminPage('courses', h('div', {},
    pageHead('Eğitimler', 'Bölümler ve alt konulardan oluşan eğitim içerikleri', h('button', { class: 'btn btn-primary', onclick: create }, '+ Yeni eğitim')),
    courses.length === 0
      ? h('div', { class: 'card empty' }, 'Henüz eğitim oluşturulmamış. “Yeni eğitim” ile başlayın.')
      : h('div', { class: 'grid grid-cards' }, courses.map((c) => h('a', { class: 'card course-card', href: '#/admin/courses/' + c.id },
        h('h3', {}, c.title),
        h('p', {}, c.description || 'Açıklama eklenmemiş.'),
        h('div', { class: 'course-meta' }, h('span', {}, c.section_count + ' bölüm'), h('span', {}, c.topic_count + ' konu'), h('span', {}, c.assignment_count + ' atama')))))));
}

async function adminCourse(id) {
  const [{ course, sections }, { exams }] = await Promise.all([api('GET', `/api/admin/courses/${id}`), api('GET', `/api/admin/courses/${id}/exams`)]);
  const reload = () => render();

  const editCourse = () => formModal({
    title: 'Eğitim bilgileri',
    fields: [
      { name: 'title', label: 'Eğitim adı', required: true, value: course.title, max: 200 },
      { name: 'description', label: 'Açıklama', type: 'textarea', rows: 3, value: course.description },
    ],
    onSubmit: async (v) => { await api('PUT', `/api/admin/courses/${id}`, v); toast('Kaydedildi.'); reload(); },
  });
  const deleteCourse = () => confirmModal({
    title: 'Eğitimi sil', message: `"${course.title}" eğitimi, tüm bölüm ve konularıyla birlikte silinsin mi?`,
    onConfirm: async () => { await api('DELETE', `/api/admin/courses/${id}`); toast('Eğitim silindi.'); go('#/admin/courses'); },
  });
  const addSection = () => formModal({
    title: 'Yeni bölüm', fields: [{ name: 'title', label: 'Bölüm adı', required: true, max: 200, placeholder: 'Örn: Genel Konular' }], submitLabel: 'Ekle',
    onSubmit: async (v) => { await api('POST', `/api/admin/courses/${id}/sections`, v); reload(); },
  });
  const editSection = (s) => formModal({
    title: 'Bölümü düzenle', fields: [{ name: 'title', label: 'Bölüm adı', required: true, value: s.title, max: 200 }],
    onSubmit: async (v) => { await api('PUT', `/api/admin/sections/${s.id}`, v); reload(); },
  });
  const deleteSection = (s) => confirmModal({
    title: 'Bölümü sil', message: `"${s.title}" bölümü ve içindeki ${s.topics.length} konu silinsin mi?`,
    onConfirm: async () => { await api('DELETE', `/api/admin/sections/${s.id}`); reload(); },
  });
  const topicForm = (s, t) => formModal({
    title: t ? 'Konuyu düzenle' : `Yeni konu — ${s.title}`,
    submitLabel: t ? 'Kaydet' : 'Ekle',
    fields: [
      { name: 'title', label: 'Konu adı', required: true, value: t?.title, max: 200 },
      { name: 'content', label: 'Konu içeriği (metin)', type: 'textarea', rows: 10, value: t?.content, hint: 'Videonun altında veya tek başına gösterilecek anlatım metni (isteğe bağlı). Video için konu satırındaki “Video” düğmesini kullanın.' },
    ],
    onSubmit: async (v) => {
      if (t) await api('PUT', `/api/admin/topics/${t.id}`, v); else await api('POST', `/api/admin/sections/${s.id}/topics`, v);
      reload();
    },
  });
  const deleteTopic = (t) => confirmModal({
    title: 'Konuyu sil', message: `"${t.title}" konusu silinsin mi?`,
    onConfirm: async () => { await api('DELETE', `/api/admin/topics/${t.id}`); reload(); },
  });
  const move = async (kind, item, direction) => {
    try { await api('POST', `/api/admin/${kind}/${item.id}/move`, { direction }); reload(); } catch (e) { toast(e.message, true); }
  };

  const arrows = (kind, item, i, total) => [
    h('button', { class: 'btn btn-sm btn-icon', 'aria-label': 'Yukarı taşı', disabled: i === 0, onclick: () => move(kind, item, 'up') }, '↑'),
    h('button', { class: 'btn btn-sm btn-icon', 'aria-label': 'Aşağı taşı', disabled: i === total - 1, onclick: () => move(kind, item, 'down') }, '↓'),
  ];

  const sectionEls = sections.map((s, si) => h('section', { class: 'card section-card' },
    h('div', { class: 'section-head' },
      h('span', { class: 'section-no' }, si + 1), h('h3', {}, s.title),
      arrows('sections', s, si, sections.length),
      h('button', { class: 'btn btn-sm', onclick: () => editSection(s) }, 'Düzenle'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteSection(s) }, 'Sil')),
    s.topics.length === 0 ? h('div', { class: 'empty small' }, 'Bu bölümde henüz konu yok.') : null,
    s.topics.map((t, ti) => h('div', { class: 'topic-row' },
      h('span', { class: 'topic-no' }, `${si + 1}.${ti + 1}`),
      h('div', { class: 't-title' }, h('b', {}, t.title), ' ',
        t.content ? h('span', { class: 'chip chip-ok' }, 'içerik var') : h('span', { class: 'chip' }, 'içerik yok'), ' ',
        t.has_video ? h('span', { class: 'chip chip-ok' }, 'video ' + fmtDur(t.video_duration)) : h('span', { class: 'chip' }, 'video yok'), ' ',
        t.checkpoint_count ? h('span', { class: 'chip' }, t.checkpoint_count + ' soru') : null),
      arrows('topics', t, ti, s.topics.length),
      h('button', { class: 'btn btn-sm', onclick: () => videoModal(t, reload) }, 'Video'),
      t.has_video ? h('button', { class: 'btn btn-sm', onclick: () => checkpointsModal(t, reload).catch((e) => toast(e.message, true)) }, 'Sorular') : null,
      topicExamButton(id, t, exams, reload),
      h('button', { class: 'btn btn-sm', onclick: () => topicForm(s, t) }, 'Düzenle'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: () => deleteTopic(t) }, 'Sil'))),
    h('div', { class: 'add-row' }, h('button', { class: 'btn btn-sm', onclick: () => topicForm(s, null) }, '+ Konu ekle'))));

  adminPage('courses', h('div', {},
    h('div', { class: 'crumbs' }, h('a', { href: '#/admin/courses' }, 'Eğitimler'), h('span', {}, '/'), course.title),
    pageHead(course.title, course.description || null, [
      h('button', { class: 'btn', onclick: editCourse }, 'Eğitim bilgileri'),
      h('button', { class: 'btn btn-danger', onclick: deleteCourse }, 'Eğitimi sil')]),
    h('div', { class: 'stack' },
      sectionEls.length ? sectionEls : h('div', { class: 'card empty' }, 'Bu eğitimde henüz bölüm yok. İlk bölümü ekleyerek başlayın.'),
      courseExamsCard(id, exams, reload),
      h('div', {}, h('button', { class: 'btn btn-primary', onclick: addSection }, '+ Bölüm ekle')))));
}

// ---------- Yönetici: atamalar ----------
async function adminAssignments() {
  const [{ users }, { courses }, { assignments }, { companies }] = await Promise.all([
    api('GET', '/api/admin/users'), api('GET', '/api/admin/courses'), api('GET', '/api/admin/assignments'), api('GET', '/api/admin/companies')]);
  const learners = users.filter((u) => u.role === 'learner' && u.active);

  const courseSel = h('select', { id: 'as_course', 'aria-label': 'Eğitim' },
    h('option', { value: '' }, '— Eğitim seçin —'), courses.map((c) => h('option', { value: c.id }, c.title)));
  const companySel = h('select', { 'aria-label': 'Firma' }, h('option', { value: '' }, 'Tüm firmalar'), companies.map((c) => h('option', { value: c.id }, c.name)));
  const search = h('input', { type: 'search', placeholder: 'Katılımcı ara…', 'aria-label': 'Katılımcı ara' });
  const list = h('div', { class: 'picklist' });
  const selected = new Set();
  const countLabel = h('span', { class: 'muted small' });
  const assignBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Seçilenlere ata');

  const visible = () => {
    const q = search.value.trim().toLocaleLowerCase('tr');
    return learners.filter((u) => (!q || u.full_name.toLocaleLowerCase('tr').includes(q) || u.username.includes(q)) &&
      (!companySel.value || String(u.company_id) === companySel.value));
  };
  function update() {
    countLabel.textContent = selected.size + ' katılımcı seçili';
    assignBtn.disabled = selected.size === 0 || !courseSel.value;
  }
  function draw() {
    const rows = visible();
    list.replaceChildren(...(rows.length === 0 ? [h('div', { class: 'empty small' }, learners.length === 0 ? 'Önce katılımcı ekleyin.' : 'Eşleşen katılımcı yok.')]
      : rows.map((u) => {
        const cb = h('input', { type: 'checkbox', checked: selected.has(u.id) });
        cb.addEventListener('change', () => { if (cb.checked) selected.add(u.id); else selected.delete(u.id); update(); });
        return h('label', { class: 'pick' }, cb, h('span', {}, u.full_name, h('small', {}, [u.company_name, u.username].filter(Boolean).join(' · '))));
      })));
    update();
  }
  [search, companySel].forEach((el) => el.addEventListener(el === search ? 'input' : 'change', draw));
  courseSel.addEventListener('change', update);

  const selectVisible = () => { visible().forEach((u) => selected.add(u.id)); draw(); };
  const clearSel = () => { selected.clear(); draw(); };
  assignBtn.addEventListener('click', async () => {
    assignBtn.disabled = true;
    try {
      const r = await api('POST', '/api/admin/assignments', { course_id: Number(courseSel.value), user_ids: [...selected] });
      toast(r.already_assigned ? `${r.added} yeni atama yapıldı, ${r.already_assigned} kişiye zaten atanmıştı.` : `${r.added} katılımcıya eğitim atandı.`);
      render();
    } catch (e) { toast(e.message, true); update(); }
  });
  draw();

  // Mevcut atamalar
  const filterCourse = h('select', { 'aria-label': 'Eğitime göre filtrele' }, h('option', { value: '' }, 'Tüm eğitimler'), courses.map((c) => h('option', { value: c.id }, c.title)));
  const tableBox = h('div', { class: 'card table-wrap' });
  const remove = (a) => confirmModal({
    title: 'Atamayı kaldır', message: `${a.full_name} kişisinden "${a.course_title}" eğitimi kaldırılsın mı?`, confirmLabel: 'Kaldır',
    onConfirm: async () => { await api('DELETE', `/api/admin/assignments/${a.id}`); toast('Atama kaldırıldı.'); render(); },
  });
  function drawTable() {
    const rows = assignments.filter((a) => !filterCourse.value || String(a.course_id) === filterCourse.value);
    tableBox.replaceChildren(rows.length === 0 ? h('div', { class: 'empty' }, 'Henüz atama yok.')
      : h('table', {}, h('thead', {}, h('tr', {}, ['Katılımcı', 'Firma', 'Eğitim', 'Atama tarihi', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((a) => h('tr', { class: a.active ? '' : 'inactive' },
          h('td', {}, h('b', {}, a.full_name), h('span', { class: 'sub' }, a.username)),
          h('td', {}, a.company_name || '—'), h('td', {}, a.course_title), h('td', {}, fmtDate(a.assigned_at)),
          h('td', {}, h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm btn-danger', onclick: () => remove(a) }, 'Kaldır'))))))));
  }
  filterCourse.addEventListener('change', drawTable);
  drawTable();

  adminPage('assignments', h('div', {},
    pageHead('Atamalar', 'Hangi katılımcı hangi eğitimi alacak'),
    h('div', { class: 'card card-pad stack' },
      h('h2', {}, 'Yeni atama'),
      h('div', { class: 'field' }, h('label', { for: 'as_course' }, '1. Eğitimi seçin'), courseSel),
      h('div', { class: 'field' }, h('label', {}, '2. Katılımcıları seçin'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, search), companySel),
        list,
        h('div', { class: 'row' }, countLabel,
          h('button', { class: 'btn btn-sm', type: 'button', onclick: selectVisible }, 'Görünenlerin tümünü seç'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: clearSel }, 'Seçimi temizle'))),
      h('div', {}, assignBtn)),
    h('div', { class: 'row list-head' }, h('h2', { class: 'grow' }, 'Mevcut atamalar'), filterCourse),
    tableBox));
}

// ---------- Katılımcı ----------
const learnerPage = (el, narrow) => layout(LEARNER_NAV, 'home', { el, narrow });

async function learnerHome() {
  const { courses } = await api('GET', '/api/my/courses');
  learnerPage(h('div', {},
    pageHead('Eğitimlerim', 'Size atanan eğitimler'),
    courses.length === 0
      ? h('div', { class: 'card empty' }, 'Şu anda size atanmış bir eğitim bulunmuyor.')
      : h('div', { class: 'grid grid-cards' }, courses.map((c) => h('a', { class: 'card course-card', href: '#/learner/course/' + c.id },
        h('h3', {}, c.title), h('p', {}, c.description || ''),
        h('div', { class: 'course-meta' }, h('span', {}, c.section_count + ' bölüm'), h('span', {}, c.topic_count + ' konu'), h('span', {}, 'Atanma: ' + fmtDate(c.assigned_at))),
        h('span', { class: 'btn btn-primary' }, 'Eğitime git →'))))));
}

// ---------- Yönlendirme ----------
async function loadUser() {
  state.user = (await api('GET', '/api/me')).user;
}

async function render() {
  if (state.cleanup) { try { state.cleanup(); } catch { /* yoksay */ } state.cleanup = null; }
  const hash = location.hash || '#/';
  try {
    if (!state.user) await loadUser();
    if (!state.user) {
      if (hash !== '#/login') { go('#/login'); return; }
      return await loginPage();
    }
    const isAdmin = state.user.role === 'admin';
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const [area, sub, a, b, c] = parts;

    if (!area || area === 'login') { go(isAdmin ? '#/admin' : '#/learner'); return; }
    if (area === 'admin') {
      if (!isAdmin) { go('#/learner'); return; }
      if (!sub) return await adminHome();
      if (sub === 'courses') return a ? await adminCourse(a) : await adminCourses();
      if (sub === 'users') return await adminUsers();
      if (sub === 'companies') return await adminCompanies();
      if (sub === 'assignments') return await adminAssignments();
      if (sub === 'reports') return await adminReports();
      if (sub === 'exams') return await adminExamResults();
    }
    if (area === 'learner') {
      if (!sub) return await learnerHome();
      if (sub === 'course' && a && b === 'exam' && c) return await learnerExam(a, c);
      if (sub === 'course' && a && b === 'topic' && c) return await learnerTopic(a, c);
      if (sub === 'course' && a) return await learnerCourse(a);
    }
    go(isAdmin ? '#/admin' : '#/learner');
  } catch (err) {
    if (err.status === 401) { state.user = null; go('#/login'); return render(); }
    if (state.user) layout(state.user.role === 'admin' ? ADMIN_NAV : LEARNER_NAV, '', { el: errorPage(err) });
    else app.replaceChildren(errorPage(err));
  }
}

window.addEventListener('hashchange', render);
render();
