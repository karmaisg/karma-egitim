// Aşama 3 arayüzü: sınav soruları (yönetici), sınav sonuçları, katılımcı sınav ekranı (md. 16).
// stage2.js'teki yardımcılar (fmtDur, fmtDateTime, downloadCsv) ve app.js'teki h/api/toast/modal'lar çağrı anında kullanılır.
'use strict';

const EXAM_KIND = { on_test: 'Ön test', konu: 'Konu sınavı', final: 'Eğitim sonu sınavı' };
const EXAM_STATE = {
  gecti: ['Geçti', 'chip chip-ok'],
  hazir: ['Girilebilir', 'chip chip-red'],
  devam: ['Yarım kaldı', 'chip chip-red'],
  kilitli: ['Kilitli', 'chip'],
  hak_doldu: ['Hak doldu', 'chip chip-red'],
};
const fmtScore = (n) => (n === null || n === undefined ? '—' : String(n));

// ---------- Yönetici: soru yönetimi ----------
async function ensureExam(courseId, spec, existing) {
  if (existing) return existing.id;
  const r = await api('POST', `/api/admin/courses/${courseId}/exams`, spec);
  return r.id;
}

async function examEditor(examId, reload) {
  const { exam, locked, questions } = await api('GET', `/api/admin/exams/${examId}/questions`);
  let dlg;
  const refresh = () => { if (dlg && dlg.open) dlg.close(); examEditor(examId, reload).catch((e) => toast(e.message, true)); reload(); };

  const form = (q) => formModal({
    title: q ? 'Soruyu düzenle' : 'Yeni sınav sorusu',
    intro: 'Seçenekler her sınavda karışık sırayla gösterilir. En az 2, en çok 5 seçenek girin.',
    fields: [
      { name: 'question', label: 'Soru', type: 'textarea', rows: 3, required: true, value: q?.question, max: 500 },
      ...[0, 1, 2, 3, 4].map((i) => ({ name: 'o' + i, label: `${i + 1}. seçenek` + (i < 2 ? '' : ' (isteğe bağlı)'), required: i < 2, value: q?.options[i] || '', max: 300 })),
      { name: 'correct', label: 'Doğru seçenek', type: 'select', value: q ? q.correct + 1 : 1, options: [1, 2, 3, 4, 5].map((n) => ({ value: n, label: n + '. seçenek' })) },
    ],
    onSubmit: async (v) => {
      const filled = [0, 1, 2, 3, 4].map((i) => v['o' + i].trim());
      const chosen = Number(v.correct) - 1;
      if (!filled[chosen]) throw new Error('Doğru olarak işaretlediğiniz seçenek boş.');
      const body = { question: v.question, options: filled.filter(Boolean), correct: filled.slice(0, chosen).filter(Boolean).length };
      if (q) await api('PUT', `/api/admin/exam-questions/${q.id}`, body); else await api('POST', `/api/admin/exams/${examId}/questions`, body);
      toast('Soru kaydedildi.'); refresh();
    },
  });
  const del = (q) => confirmModal({ title: 'Soruyu sil', message: 'Bu soru silinsin mi?', onConfirm: async () => { await api('DELETE', `/api/admin/exam-questions/${q.id}`); refresh(); } });
  const toggle = async (q) => { try { await api('POST', `/api/admin/exam-questions/${q.id}/active`, { active: !q.active }); refresh(); } catch (e) { toast(e.message, true); } };
  const delExam = () => confirmModal({ title: 'Sınavı sil', message: 'Sınav ve tüm soruları silinsin mi?', onConfirm: async () => { await api('DELETE', `/api/admin/exams/${examId}`); dlg.close(); reload(); } });

  const active = questions.filter((q) => q.active).length;
  dlg = openModal({
    title: exam.title,
    body: h('div', { class: 'modal-body' },
      h('p', { class: 'muted small' }, `Geçme notu ${exam.pass_score}/100 · ${exam.kind === 'on_test' ? 'tek deneme (başarı şartı yok)' : `en fazla ${exam.max_attempts} deneme (ilk sınav + 2 hak, md. 16/3)`} · ${active} aktif soru`),
      locked ? h('div', { class: 'callout' }, 'Bu sınava giren katılımcılar var. Kayıtların tutarlılığı için mevcut sorular değiştirilemez veya silinemez; sorunu pasife alıp yeni soru ekleyebilirsiniz.') : null,
      active === 0 ? h('div', { class: 'callout' }, 'Aktif soru yok; sınav katılımcılara görünmez. En az bir soru ekleyin.') : null,
      questions.length === 0 ? h('div', { class: 'empty small' }, 'Henüz soru yok.')
        : questions.map((q, i) => h('div', { class: 'topic-row' + (q.active ? '' : ' inactive') },
          h('span', { class: 'topic-no' }, i + 1),
          h('div', { class: 't-title' }, h('b', {}, q.question), q.active ? null : h('span', { class: 'chip' }, 'pasif'),
            h('span', { class: 'sub' }, q.options.map((o, k) => (k === q.correct ? '✓ ' : '') + o).join('  ·  '))),
          locked ? null : h('button', { class: 'btn btn-sm', onclick: () => form(q) }, 'Düzenle'),
          locked ? h('button', { class: 'btn btn-sm', onclick: () => toggle(q) }, q.active ? 'Pasife al' : 'Aktifleştir')
            : h('button', { class: 'btn btn-sm btn-danger', onclick: () => del(q) }, 'Sil')))),
    footer: h('div', { class: 'modal-foot' },
      locked ? null : h('button', { class: 'btn btn-danger', onclick: delExam }, 'Sınavı sil'),
      h('button', { class: 'btn', onclick: () => dlg.close() }, 'Kapat'),
      h('button', { class: 'btn btn-primary', onclick: () => form(null) }, '+ Soru ekle')),
  });
  dlg.classList.add('wide');
}

const openExam = async (courseId, spec, existing, reload) => {
  try { await examEditor(await ensureExam(courseId, spec, existing), reload); } catch (e) { toast(e.message, true); }
};

// Konu satırındaki "Sınav" düğmesi
function topicExamButton(courseId, topic, exams, reload) {
  const ex = exams.find((e) => e.topic_id === topic.id);
  return h('button', { class: 'btn btn-sm', onclick: () => openExam(courseId, { kind: 'konu', topic_id: topic.id }, ex, reload) },
    ex && ex.question_count ? `Sınav (${ex.question_count})` : 'Sınav');
}

// Eğitim sayfasındaki ön test ve eğitim sonu sınavı kartı
function courseExamsCard(courseId, exams, reload) {
  const row = (kind, text) => {
    const ex = exams.find((e) => e.kind === kind);
    return h('div', { class: 'topic-row' },
      h('div', { class: 't-title' }, h('b', {}, EXAM_KIND[kind]), ' ',
        ex && ex.question_count ? h('span', { class: 'chip chip-ok' }, ex.question_count + ' soru') : h('span', { class: 'chip' }, 'soru yok'),
        h('span', { class: 'sub' }, text)),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => openExam(courseId, { kind }, ex, reload) }, ex ? 'Soruları düzenle' : 'Oluştur'));
  };
  return h('section', { class: 'card section-card' },
    h('div', { class: 'section-head' }, h('h3', {}, 'Eğitim sınavları')),
    row('on_test', 'Eğitimden önce katılımcının seviyesini ölçer (md. 16/1). Başarı şartı yoktur, sonuç kaydedilir.'),
    row('final', 'Tüm konular bitince yapılır (md. 16/2). 100 üzerinden en az 60 puan gerekir.'),
    h('div', { class: 'add-row muted small' }, 'Konu sınavları için her konunun satırındaki “Sınav” düğmesini kullanın.'));
}

// ---------- Yönetici: sınav sonuçları ----------
async function showAttempt(id) {
  const { attempt: a, answers } = await api('GET', `/api/admin/attempts/${id}`);
  const dlg = openModal({
    title: `${a.full_name} — ${a.exam_title}`,
    body: h('div', { class: 'modal-body' },
      h('p', {}, h('b', {}, `${fmtScore(a.score)} puan`), ` (${a.correct_count ?? 0}/${a.total} doğru) · ${fmtDateTime(a.finished_at)}`),
      answers.map((x, i) => h('div', { class: 'card card-pad review' },
        h('p', {}, h('b', {}, `${i + 1}. ${x.question_text}`), ' ', x.is_correct ? h('span', { class: 'chip chip-ok' }, 'Doğru') : h('span', { class: 'chip chip-red' }, x.selected === null ? 'Boş' : 'Yanlış')),
        h('ul', { class: 'review-opts' }, x.options.map((o, k) => h('li', { class: (k === x.correct_index ? 'right ' : '') + (k === x.selected ? 'picked' : '') },
          (k === x.correct_index ? '✓ ' : k === x.selected ? '✗ ' : '') + o)))))),
    footer: h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-primary', onclick: () => dlg.close() }, 'Kapat')),
  });
  dlg.classList.add('wide');
}

function grantModal(row, reload) {
  formModal({
    title: 'Yeni sınav hakkı tanı',
    intro: `${row.full_name} — ${row.exam_title}. Mevzuat gereği hakkı dolan katılımcı temel eğitime yeniden katılır; bu işlem sonrası katılımcı yeniden sınava girebilir. Önceki denemeler silinmez.`,
    submitLabel: 'Hak tanı',
    fields: [{ name: 'note', label: 'Not (isteğe bağlı)', max: 300, placeholder: 'Örn: Eğitime yeniden katıldı' }],
    onSubmit: async (v) => { await api('POST', `/api/admin/exams/${row.exam_id}/grant`, { user_id: row.user_id, note: v.note || undefined }); toast('Yeni hak tanındı.'); reload(); },
  });
}

async function adminExamResults() {
  const { rows } = await api('GET', '/api/admin/reports/exams');
  const courses = [...new Map(rows.map((r) => [r.course_id, r.course_title])).entries()];
  const courseSel = h('select', { 'aria-label': 'Eğitim' }, h('option', { value: '' }, 'Tüm eğitimler'), courses.map(([id, t]) => h('option', { value: id }, t)));
  const search = h('input', { type: 'search', placeholder: 'Katılımcı ara…', 'aria-label': 'Ara' });
  const box = h('div', { class: 'card table-wrap' });
  let shown = [];

  const result = (r) => (!r.finished_at ? h('span', { class: 'chip' }, 'Tamamlanmadı') : r.passed === null ? h('span', { class: 'chip' }, 'Ön test')
    : r.passed ? h('span', { class: 'chip chip-ok' }, 'Başarılı') : h('span', { class: 'chip chip-red' }, 'Başarısız'));

  function draw() {
    const q = search.value.trim().toLocaleLowerCase('tr');
    shown = rows.filter((r) => (!courseSel.value || String(r.course_id) === courseSel.value) && (!q || r.full_name.toLocaleLowerCase('tr').includes(q) || r.username.includes(q)));
    box.replaceChildren(shown.length === 0 ? h('div', { class: 'empty' }, rows.length ? 'Eşleşen kayıt yok.' : 'Henüz sınava giren katılımcı yok.')
      : h('table', {}, h('thead', {}, h('tr', {}, ['Katılımcı', 'Eğitim / sınav', 'Deneme', 'Tarih', 'Puan', 'Sonuç', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, shown.map((r) => h('tr', {},
          h('td', {}, h('b', {}, r.full_name), h('span', { class: 'sub' }, [r.company_name, r.username].filter(Boolean).join(' · '))),
          h('td', {}, r.exam_title, h('span', { class: 'sub' }, r.course_title)),
          h('td', {}, r.attempt_no), h('td', {}, fmtDateTime(r.finished_at || r.started_at)),
          h('td', {}, r.finished_at ? `${r.score}` : '—'), h('td', {}, result(r)),
          h('td', {}, h('div', { class: 'actions' },
            r.finished_at ? h('button', { class: 'btn btn-sm', onclick: () => showAttempt(r.id).catch((e) => toast(e.message, true)) }, 'Cevaplar') : null,
            r.passed === false && !rows.some((x) => x.user_id === r.user_id && x.exam_id === r.exam_id && x.passed === true) ? h('button', { class: 'btn btn-sm', onclick: () => grantModal(r, () => render()) }, 'Hak tanı') : null)))))));
  }
  courseSel.addEventListener('change', draw); search.addEventListener('input', draw);
  draw();

  const exportCsv = () => downloadCsv('sinav-sonuclari.csv', [
    ['Ad soyad', 'Kullanıcı adı', 'Firma', 'Eğitim', 'Sınav', 'Deneme no', 'Başlangıç', 'Bitiş', 'Doğru', 'Soru sayısı', 'Puan', 'Sonuç'],
    ...shown.map((r) => [r.full_name, r.username, r.company_name || '', r.course_title, r.exam_title, r.attempt_no, fmtDateTime(r.started_at), fmtDateTime(r.finished_at),
      r.correct_count ?? '', r.total, r.score ?? '', !r.finished_at ? 'Tamamlanmadı' : r.passed === null ? 'Ön test' : r.passed ? 'Başarılı' : 'Başarısız']),
  ]);
  adminPage('exams', h('div', {},
    pageHead('Sınav sonuçları', 'Tüm denemeler, verilen cevaplar ve puanlar kayıt altındadır (Yönetmelik md. 16)', h('button', { class: 'btn', onclick: exportCsv }, 'CSV indir')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, search), courseSel), h('div', { class: 'stack' }, box)));
}

// ---------- Katılımcı: sınav ekranı ----------
const examLink = (courseId, examId) => `#/learner/course/${courseId}/exam/${examId}`;

function examStateChip(e) {
  const [label, cls] = EXAM_STATE[e.state] || ['', 'chip'];
  return h('span', { class: cls }, e.state === 'gecti' ? `${label} · ${e.best_score}` : label);
}

async function learnerExam(courseId, examId) {
  const [{ exams }, { course }] = await Promise.all([api('GET', `/api/my/courses/${courseId}/exams`), api('GET', `/api/my/courses/${courseId}`)]);
  const ex = exams.find((e) => e.id === Number(examId));
  if (!ex) throw new Error('Sınav bulunamadı.');
  const crumbs = h('div', { class: 'crumbs' }, h('a', { href: '#/learner' }, 'Eğitimlerim'), h('span', {}, '/'), h('a', { href: '#/learner/course/' + courseId }, course.title), h('span', {}, '/'), ex.title);
  const showInfo = () => learnerPage(h('div', {}, crumbs, infoCard()), true);

  function infoCard() {
    const rules = h('ul', { class: 'exam-rules' },
      h('li', {}, `${ex.question_count} soru, çoktan seçmeli.`),
      ex.kind === 'on_test' ? h('li', {}, 'Bu bir seviye tespitidir; başarı şartı yoktur, tek deneme hakkınız vardır.')
        : h('li', {}, `Başarılı sayılmak için 100 üzerinden en az ${ex.pass_score} puan gerekir. En fazla ${ex.max_attempts} kez girebilirsiniz.`),
      h('li', {}, 'Sınav süresince sayfayı kapatırsanız deneme devam eder ve hakkınızdan sayılır.'),
      h('li', {}, 'Cevaplarınız ve sonucunuz kayıt altına alınır.'));
    const startBtn = h('button', { class: 'btn btn-primary', type: 'button' }, ex.state === 'devam' ? 'Sınava devam et' : 'Sınava başla');
    startBtn.addEventListener('click', () => beginExam());
    const history = ex.attempts.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Deneme', 'Tarih', 'Puan', 'Sonuç'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ex.attempts.map((a, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, fmtDateTime(a.finished_at)), h('td', {}, a.score),
        h('td', {}, a.passed === null ? '—' : a.passed ? h('span', { class: 'chip chip-ok' }, 'Başarılı') : h('span', { class: 'chip chip-red' }, 'Başarısız'))))))) : null;
    let action;
    if (ex.state === 'hazir' || ex.state === 'devam') action = startBtn;
    else if (ex.state === 'gecti') action = h('div', { class: 'callout ok' }, `Bu sınavı başarıyla geçtiniz (${ex.best_score} puan).`);
    else if (ex.state === 'hak_doldu') action = h('div', { class: 'callout' }, 'Deneme hakkınız doldu. Mevzuat gereği eğitime yeniden katılmanız gerekir; lütfen eğitim yöneticinizle iletişime geçin.');
    else action = h('div', { class: 'callout' }, ex.reason || 'Bu sınav henüz açılmadı.');
    return h('article', { class: 'card card-pad stack' }, h('h1', {}, ex.title), rules,
      ex.state === 'hazir' || ex.state === 'devam' ? h('p', { class: 'muted' }, `Kalan hak: ${ex.attempts_left}`) : null, history, action,
      h('div', {}, h('a', { class: 'btn', href: '#/learner/course/' + courseId }, '← Eğitime dön')));
  }

  async function beginExam() {
    let data;
    try { data = await api('POST', `/api/my/exams/${ex.id}/start`); } catch (e) { toast(e.message, true); return render(); }
    takeExam(data);
  }

  function takeExam(data) {
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    state.cleanup = () => window.removeEventListener('beforeunload', warn);
    const total = data.questions.length;
    const errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
    const counter = h('span', { class: 'muted small' }, `0 / ${total} cevaplandı`);
    const qEls = data.questions.map((q, qi) => h('fieldset', { class: 'card card-pad exam-q' },
      h('legend', {}, `${qi + 1}. ${q.question}`),
      q.options.map((o, oi) => h('label', { class: 'exam-opt' }, h('input', { type: 'radio', name: 'q' + q.id, value: String(oi) }), h('span', {}, o)))));
    const answered = () => data.questions.filter((q) => document.querySelector(`input[name="q${q.id}"]:checked`)).length;
    const submit = h('button', { class: 'btn btn-primary', type: 'button' }, 'Sınavı bitir');
    const form = h('div', { class: 'stack' }, qEls);
    form.addEventListener('change', () => { counter.textContent = `${answered()} / ${total} cevaplandı`; });

    const send = async () => {
      const answers = data.questions.map((q) => {
        const c = document.querySelector(`input[name="q${q.id}"]:checked`);
        return { question_id: q.id, selected: c ? Number(c.value) : null };
      });
      submit.disabled = true;
      try {
        const res = await api('POST', `/api/my/attempts/${data.attempt_id}/submit`, { answers });
        window.removeEventListener('beforeunload', warn); state.cleanup = null;
        showResult(res);
      } catch (e) { submit.disabled = false; errorBox.textContent = e.message; errorBox.classList.remove('hidden'); }
    };
    submit.addEventListener('click', () => {
      const left = total - answered();
      confirmModal({
        title: 'Sınavı bitir', confirmLabel: 'Evet, bitir', danger: false,
        message: left ? `${left} soruyu boş bıraktınız. Sınavı bitirmek istiyor musunuz?` : 'Tüm soruları cevapladınız. Sınav teslim edilsin mi?',
        onConfirm: send,
      });
    });
    learnerPage(h('div', {}, crumbs,
      h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, data.exam.title), h('p', {}, 'Her soru için bir seçenek işaretleyin.')), counter),
      errorBox, form, h('div', { class: 'pager' }, h('span', {}), submit)), true);
  }

  function showResult(res) {
    const isPre = res.passed === null;
    const verdict = isPre ? 'Ön testiniz kaydedildi.' : res.passed ? 'Tebrikler, sınavı başarıyla geçtiniz.' : 'Bu denemede başarılı olamadınız.';
    const wrong = res.results.filter((r) => !r.is_correct).length;
    const more = !isPre && !res.passed
      ? (res.attempts_left > 0 ? h('p', {}, `Kalan deneme hakkınız: ${res.attempts_left}. Konuları tekrar gözden geçirip yeniden deneyebilirsiniz.`)
        : h('div', { class: 'callout' }, 'Deneme hakkınız doldu. Mevzuat gereği eğitime yeniden katılmanız gerekir; lütfen eğitim yöneticinizle iletişime geçin.')) : null;
    learnerPage(h('div', {}, crumbs, h('article', { class: 'card card-pad stack result ' + (isPre ? '' : res.passed ? 'result-pass' : 'result-fail') },
      h('div', { class: 'score' }, h('b', {}, res.score), h('span', {}, '/ 100')),
      h('h2', {}, verdict),
      h('p', {}, `${res.correct_count} / ${res.total} soruyu doğru cevapladınız${wrong ? `, ${wrong} soru yanlış veya boş` : ''}.${isPre ? '' : ` Geçme notu: ${res.pass_score}.`}`),
      more,
      h('div', { class: 'row' }, h('a', { class: 'btn btn-primary', href: '#/learner/course/' + courseId }, 'Eğitime dön')))), true);
  }

  showInfo();
}
