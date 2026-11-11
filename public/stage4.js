// Aşama 4 arayüzü: katılım belgesi (md. 17) — belge ayarları, belge listesi, katılımcının belge indirmesi.
'use strict';

const TRAINING_TYPE = { ilk: 'İlk defa', tekrar: 'Tekrar' };
const FORM_OPTIONS = [
  { value: 'remote', label: 'Uzaktan' },
  { value: 'in_person', label: 'Yüz yüze' },
  { value: 'both', label: 'Yüz yüze ve uzaktan' },
];

// ---------- Yönetici: eğitim sayfasında belge ayarları ----------
function certSettingsCard(courseId) {
  const open = async () => {
    let c;
    try { c = await api('GET', `/api/admin/courses/${courseId}/certificate-settings`); } catch (e) { toast(e.message, true); return; }
    const t = c.trainers;
    formModal({
      title: 'Katılım belgesi bilgileri',
      intro: 'Bu eğitimin belgesinde yazacak bilgiler. Belge düzenlendikten sonra değişiklikler o belgeyi etkilemez.',
      fields: [
        { name: 'hours', label: 'Eğitimin süresi (saat)', required: true, value: String(c.hours).replace('.', ','), max: 6, full: false, hint: 'Örn: 8, 12 veya 16' },
        { name: 'form', label: 'Eğitimin şekli', type: 'select', options: FORM_OPTIONS, value: c.in_person && c.remote ? 'both' : c.in_person ? 'in_person' : 'remote', full: false },
        { name: 't1_name', label: '1. eğitici adı soyadı', value: t[0]?.name || '', max: 100, full: false },
        { name: 't1_title', label: '1. eğitici unvanı', value: t[0]?.title || '', max: 100, full: false, placeholder: 'Örn: B Sınıfı İş Güvenliği Uzmanı' },
        { name: 't2_name', label: '2. eğitici adı soyadı', value: t[1]?.name || '', max: 100, full: false },
        { name: 't2_title', label: '2. eğitici unvanı', value: t[1]?.title || '', max: 100, full: false, placeholder: 'Örn: İşyeri Hekimi' },
      ],
      onSubmit: async (v) => {
        await api('PUT', `/api/admin/courses/${courseId}/certificate-settings`, {
          hours: v.hours, in_person: v.form !== 'remote', remote: v.form !== 'in_person',
          trainers: [{ name: v.t1_name, title: v.t1_title }, { name: v.t2_name, title: v.t2_title }],
        });
        toast('Belge bilgileri kaydedildi.');
      },
    });
  };
  return h('section', { class: 'card section-card' },
    h('div', { class: 'section-head' }, h('h3', {}, 'Katılım belgesi')),
    h('div', { class: 'topic-row' },
      h('div', { class: 't-title' }, h('b', {}, 'Belge bilgileri'),
        h('span', { class: 'sub' }, 'Eğitim süresi, eğitimin şekli ve eğiticiler. Katılımcı eğitimi (ve sınavları) bitirince belgesini kendisi indirir.')),
      h('button', { class: 'btn btn-sm btn-primary', onclick: open }, 'Düzenle')));
}

// ---------- Yönetici: belgeler sayfası ----------
function orgTitleModal() {
  api('GET', '/api/admin/settings').then((s) => formModal({
    title: 'OSGB unvanı',
    intro: 'Belgedeki "… tarafından gerçekleştirilen" ifadesinde yazar. Düzenlenmiş belgeler değişmez.',
    fields: [{ name: 'org_title', label: 'OSGB ticari unvanı', required: true, value: s.org_title, max: 200 }],
    onSubmit: async (v) => { await api('PUT', '/api/admin/settings', v); toast('Unvan kaydedildi.'); },
  })).catch((e) => toast(e.message, true));
}

async function adminCertificates() {
  const { certificates } = await api('GET', '/api/admin/certificates');
  const search = h('input', { type: 'search', placeholder: 'Katılımcı veya belge no ara…', 'aria-label': 'Ara' });
  const box = h('div', { class: 'card table-wrap' });
  function draw() {
    const q = search.value.trim().toLocaleLowerCase('tr');
    const rows = certificates.filter((c) => !q || c.full_name.toLocaleLowerCase('tr').includes(q) || c.number.toLocaleLowerCase('tr').includes(q) || c.username.includes(q));
    box.replaceChildren(rows.length === 0 ? h('div', { class: 'empty' }, certificates.length ? 'Eşleşen belge yok.' : 'Henüz katılım belgesi düzenlenmedi. Katılımcılar eğitimi bitirince belgelerini kendileri alır.')
      : h('table', {}, h('thead', {}, h('tr', {}, ['Belge no', 'Katılımcı', 'Eğitim', 'Düzenleme tarihi', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((c) => h('tr', {},
          h('td', {}, h('b', {}, c.number)),
          h('td', {}, h('b', {}, c.full_name), h('span', { class: 'sub' }, [c.company_name, c.username].filter(Boolean).join(' · '))),
          h('td', {}, c.course_title), h('td', {}, fmtDateTime(c.issued_at)),
          h('td', {}, h('div', { class: 'actions' }, h('a', { class: 'btn btn-sm', href: `/api/admin/certificates/${c.id}/pdf` }, 'PDF indir'))))))));
  }
  search.addEventListener('input', draw);
  draw();
  adminPage('certs', h('div', {},
    pageHead('Katılım belgeleri', 'Düzenlenmiş tüm belgeler (Yönetmelik md. 17)', h('button', { class: 'btn', onclick: orgTitleModal }, 'OSGB unvanı')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, search)), h('div', { class: 'stack' }, box)));
}

// ---------- Katılımcı: belge kartı ----------
async function learnerCertificateCard(courseId) {
  let st;
  try { st = await api('GET', `/api/my/courses/${courseId}/certificate`); } catch { return null; }
  const pdfUrl = `/api/my/courses/${courseId}/certificate.pdf`;
  const download = () => { const a = h('a', { href: pdfUrl, download: '' }); document.body.append(a); a.click(); a.remove(); };
  const btn = h('button', { class: 'btn btn-primary', type: 'button' }, st.issued ? 'Katılım belgesini indir (PDF)' : 'Katılım belgemi oluştur ve indir (PDF)');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (!st.issued) { const r = await api('POST', `/api/my/courses/${courseId}/certificate`); st.issued = { number: r.number, issued_at: r.issued_at }; }
      download();
      toast('Belgeniz indiriliyor.');
      setTimeout(() => render(), 600);
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  });
  if (st.eligible) {
    return h('section', { class: 'card card-pad cert-card cert-ready' },
      h('div', {}, h('h3', {}, 'Katılım belgesi'),
        h('p', { class: 'muted' }, st.issued ? `Belge no: ${st.issued.number} · ${fmtDateTime(st.issued.issued_at)}` : 'Eğitimi başarıyla tamamladınız. Belgenizi indirebilirsiniz.')),
      btn);
  }
  return h('section', { class: 'card card-pad cert-card' },
    h('div', {}, h('h3', {}, 'Katılım belgesi'),
      h('p', { class: 'muted' }, 'Belgenizi alabilmek için şunları tamamlamanız gerekir:'),
      h('ul', { class: 'exam-rules' }, st.reasons.map((r) => h('li', {}, r)))));
}
