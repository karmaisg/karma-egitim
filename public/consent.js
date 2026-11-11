// KVKK aydınlatma metni: katılımcı eğitime başlamadan önce okuyup onaylar; yönetici onay kayıtlarını görür.
'use strict';

function consentBody(c) {
  const nodes = [];
  let list = null;
  for (const b of c.blocks) {
    if (b.li) { if (!list) { list = h('ul', {}); nodes.push(list); } list.append(h('li', {}, b.li)); continue; }
    list = null;
    nodes.push(b.h ? h('h3', {}, b.h) : h('p', {}, b.p));
  }
  return h('div', { class: 'consent-text', tabindex: '0', 'aria-label': 'Aydınlatma metni' },
    h('h2', {}, c.title), h('p', { class: 'muted' }, c.subtitle), ...nodes);
}

// Onay gerekiyorsa gösterilir; onaylanınca onDone() çağrılır.
async function consentPage(onDone) {
  const c = await api('GET', '/api/my/consent');
  if (c.accepted) { onDone(); return; }
  const chk = h('input', { type: 'checkbox', id: 'consent_chk' });
  const btn = h('button', { class: 'btn btn-primary', disabled: true }, 'Onaylıyorum ve devam ediyorum');
  chk.addEventListener('change', () => { btn.disabled = !chk.checked; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await api('POST', '/api/my/consent', { accept: true }); onDone(); } catch (e) { toast(e.message, true); btn.disabled = !chk.checked; }
  });
  layout(LEARNER_NAV, '', { narrow: true, el: h('div', {},
    pageHead('Aydınlatma metni', 'Eğitime başlamadan önce lütfen metni okuyun ve onaylayın.'),
    h('div', { class: 'card consent-card' },
      consentBody(c),
      h('label', { class: 'consent-check', for: 'consent_chk' }, chk, h('span', {}, 'Kişisel Verilerin İşlenmesi ve Yurt Dışına Aktarılmasına İlişkin Aydınlatma Metni\'ni okudum, anladım.')),
      h('div', { class: 'modal-foot' }, btn))) });
}

async function adminConsents() {
  const { consents, version } = await api('GET', '/api/admin/consents');
  const done = consents.filter((r) => r.accepted_at).length;
  const q = h('input', { type: 'search', placeholder: 'Katılımcı ara...', 'aria-label': 'Ara' });
  const body = h('tbody', {});
  const draw = () => {
    const t = q.value.trim().toLocaleLowerCase('tr-TR');
    body.replaceChildren(...consents.filter((r) => !t || `${r.full_name} ${r.username} ${r.company || ''}`.toLocaleLowerCase('tr-TR').includes(t)).map((r) => h('tr', {},
      h('td', {}, h('b', {}, r.full_name), h('div', { class: 'muted small' }, (r.company ? r.company + ' · ' : '') + r.username)),
      h('td', {}, r.accepted_at ? h('span', { class: 'chip chip-ok' }, 'Onayladı') : h('span', { class: 'chip chip-red' }, 'Bekliyor')),
      h('td', {}, r.accepted_at ? fmtDateTime(r.accepted_at) : '—'),
      h('td', {}, r.ip || '—'))));
  };
  q.addEventListener('input', draw); draw();
  const csv = () => downloadCsv('aydinlatma-onaylari.csv', [['Ad soyad', 'Kullanıcı adı', 'Firma', 'Sürüm', 'Durum', 'Onay tarihi', 'IP', 'Tarayıcı', 'Metin özeti (SHA-256)'],
    ...consents.map((r) => [r.full_name, r.username, r.company || '', version, r.accepted_at ? 'Onayladı' : 'Bekliyor', r.accepted_at ? fmtDateTime(r.accepted_at) : '', r.ip || '', r.user_agent || '', r.text_hash || ''])]);
  adminPage('users', h('div', {},
    pageHead('Aydınlatma metni onayları', `Metin sürümü ${version} — ${done} / ${consents.length} katılımcı onayladı`,
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/admin/users' }, '← Katılımcılar'), h('button', { class: 'btn', onclick: csv }, 'CSV indir'))),
    h('div', { class: 'stack' }, q, h('div', { class: 'card table-card' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ...['Katılımcı', 'Durum', 'Onay tarihi', 'IP'].map((x) => h('th', {}, x)))), body)))));
}
