// Автотесты по приёмочным тест-кейсам из RTM (TC-01…TC-12, TC-14, TC-16, TC-17).
// Запуск: npm test  (или node --test tests/)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const N = require('../src/core.js');

const TODAY = '2026-10-17';
const HEADER = 'customer_id,customer_name,phone,vehicle_id,make_model,mileage,service_date,service_name,note,amount\n';
const demo = fs.readFileSync(path.join(__dirname, '..', 'data', 'demo-history.csv'), 'utf8');
const withErrors = fs.readFileSync(path.join(__dirname, '..', 'data', 'demo-with-errors.csv'), 'utf8');

function load(csv = demo) {
  const s = N.createState();
  N.importCSV(s, csv, 'test.csv', TODAY);
  return s;
}
const oppOf = (s, customerId, categoryId) => s.opportunities.find(o => o.customerId === customerId && o.categoryId === categoryId && N.ACTIVE.includes(o.status));

// Проводит opportunity по цепочке до Contacted.
function contact(s, opp) {
  assert.ok(N.approve(s, opp.id).ok);
  const r = N.send(s, opp.id, { today: TODAY });
  assert.ok(r.ok, r.error);
  return r;
}

test('TC-01 / FR-01: импорт CSV, ошибки по строкам, повтор без дублей', () => {
  const s = N.createState();
  const r1 = N.importCSV(s, withErrors, 'errors.csv', TODAY);
  assert.equal(r1.imported, 2);
  assert.equal(r1.duplicates, 1, 'дубль строки внутри файла не сохраняется');
  assert.deepEqual(r1.errors.map(e => e.row), [3, 4, 5, 6, 7]);
  assert.match(r1.errors[0].message, /customer_id/);

  const r2 = N.importCSV(s, withErrors, 'errors.csv', TODAY);
  assert.equal(r2.imported, 0);
  assert.equal(s.services.length, 2);
  assert.equal(Object.keys(s.customers).length, 2);
});

test('TC-01 / FR-01: валидный CSV на 5000 строк импортируется полностью', () => {
  let csv = HEADER;
  for (let i = 0; i < 5000; i++) csv += `C${i % 1500},Клиент ${i % 1500},,V${i % 1800},Kia Rio,${50000 + i},2026-0${1 + (i % 9)}-1${i % 9},Замена масла,,100\n`;
  const s = N.createState();
  const r = N.importCSV(s, csv, 'big.csv', TODAY);
  assert.equal(r.imported + r.duplicates, 5000);
  assert.equal(r.errors.length, 0);
});

test('TC-02 / FR-02: AI Notes извлекает future work; неоднозначная → Needs review', () => {
  const fw = N.extractFutureWork('Через 3 месяца проверить передние тормозные диски', '2026-07-20');
  assert.equal(fw.serviceType, 'проверка/тормозные диски');
  assert.equal(fw.dueDate, '2026-10-20');
  assert.equal(fw.sourceNote, 'Через 3 месяца проверить передние тормозные диски');
  assert.equal(fw.needsReview, false);

  const vague = N.extractFutureWork('Через какое-то время посмотреть амортизаторы', '2026-08-02');
  assert.equal(vague.needsReview, true);
  assert.equal(N.extractFutureWork('Клиент доволен, всё в порядке', '2026-08-02'), null);

  // Needs review не попадает в outreach: у Сергея (C005) нет opportunity по подвеске.
  const s = load();
  assert.equal(oppOf(s, 'C005', 'suspension'), undefined);
});

test('TC-03 / FR-03: due date по интервалу; более ранний срок из заметки, оба источника', () => {
  assert.equal(N.addDays('2026-01-01', 180), '2026-06-30');
  const s = load();
  const opp = oppOf(s, 'C003', 'oil'); // правило 365 дн. + заметка «через 6 месяцев»
  assert.equal(opp.dueDate, '2026-10-10');
  assert.equal(opp.reasons[0].kind, 'note');
  assert.ok(opp.reasons.some(r => r.kind === 'interval' && r.dueDate === '2027-04-10'));
});

test('TC-04 / FR-04: повторный импорт/пересчёт не создаёт вторую активную opportunity', () => {
  const s = load();
  const before = s.opportunities.length;
  N.importCSV(s, demo, 'test.csv', TODAY);
  N.recompute(s, TODAY);
  assert.equal(s.opportunities.length, before);

  // После Completed следующий цикл допустим.
  const opp = oppOf(s, 'C017', 'oil');
  contact(s, opp);
  N.book(s, opp.id, '2026-10-25', '10:00', TODAY);
  N.complete(s, opp.id, 165);
  N.recompute(s, TODAY);
  const next = oppOf(s, 'C017', 'oil');
  assert.ok(next && next.id !== opp.id);
  assert.equal(next.dueDate, '2027-10-25');
});

test('TC-05 / FR-05: просроченные выше, при равном сроке — выше confidence; причина видна', () => {
  const s = load();
  const q = N.getQueue(s, TODAY);
  for (let i = 1; i < q.length; i++) {
    assert.ok(q[i - 1].dueDate < q[i].dueDate || (q[i - 1].dueDate === q[i].dueDate && q[i - 1].confidence >= q[i].confidence));
  }
  const irina = q.findIndex(o => o.customerId === 'C014'); // 12.10, conf 0.93
  const alexey = q.findIndex(o => o.customerId === 'C009'); // 12.10, conf 0.90
  assert.ok(irina < alexey);
  assert.match(N.positionReason(q[0], TODAY), /Просрочено/);
});

test('TC-06 / FR-06: черновик содержит имя, авто и услугу; других услуг нет', () => {
  const s = load();
  const opp = oppOf(s, 'C001', 'oil');
  assert.match(opp.draft, /Иван/);
  assert.match(opp.draft, /BMW 320i/);
  assert.match(opp.draft, /замена масла/);
  assert.doesNotMatch(opp.draft, /тормоз|колодк|шин/i, 'услуги не из opportunity не упоминаются');
});

test('TC-07 / FR-07: без approve отправка запрещена; Edit+Approve отправляет правленый текст; Reject не отправляет', () => {
  const s = load();
  const opp = oppOf(s, 'C001', 'oil');
  N.markReviewed(s, opp.id);
  const blocked = N.send(s, opp.id, { today: TODAY });
  assert.equal(blocked.ok, false);
  assert.equal(s.messages.length, 0);

  const edited = opp.draft + '\nСкидка 10% на работу.';
  N.approve(s, opp.id, edited);
  const r = N.send(s, opp.id, { today: TODAY });
  assert.equal(r.message.text, edited);

  const other = oppOf(s, 'C006', 'ac');
  assert.ok(N.reject(s, other.id, 'Клиент продал авто').ok);
  assert.equal(other.status, 'rejected');
  assert.equal(s.messages.filter(m => m.oppId === other.id).length, 0);
  assert.ok(s.events.some(e => e.type === 'opportunity_rejected' && e.oppId === other.id));
});

test('TC-08 / FR-08: одна отправка при retry; сбой канала → Failed и управляемый повтор', () => {
  const s = load();
  const opp = oppOf(s, 'C004', 'tires');
  N.approve(s, opp.id);
  const failed = N.send(s, opp.id, { idempotencyKey: 'k1', simulateFailure: true, today: TODAY });
  assert.equal(failed.ok, false);
  assert.equal(opp.status, 'failed');

  const ok = N.send(s, opp.id, { idempotencyKey: 'k1', today: TODAY });
  assert.ok(ok.ok);
  const again = N.send(s, opp.id, { idempotencyKey: 'k1', today: TODAY });
  assert.ok(again.duplicate);
  assert.equal(s.messages.length, 1);
  assert.equal(opp.status, 'contacted');
  assert.ok(ok.message.providerMessageId && ok.message.at && ok.message.status === 'sent');
});

test('TC-09 / FR-09: booking создаётся один раз, изменение обновляет, пустая дата отклонена', () => {
  const s = load();
  const opp = oppOf(s, 'C013', 'to');
  contact(s, opp);
  assert.equal(N.book(s, opp.id, '', '', TODAY).ok, false);
  assert.equal(N.book(s, opp.id, '2026-10-01', '10:00', TODAY).ok, false, 'прошедшая дата');
  assert.ok(N.book(s, opp.id, '2026-10-22', '10:00', TODAY).ok);
  assert.ok(N.book(s, opp.id, '2026-10-22', '15:30', TODAY).updated);
  assert.equal(opp.booking.time, '15:30');
  assert.equal(s.events.filter(e => e.type === 'booking_created').length, 1);
});

test('TC-10 / FR-10: Completed с €240 увеличивает выручку один раз', () => {
  const s = load();
  const opp = oppOf(s, 'C002', 'brakes');
  contact(s, opp);
  N.book(s, opp.id, '2026-10-23', '09:00', TODAY);
  N.complete(s, opp.id, 240);
  N.complete(s, opp.id, 240);
  assert.equal(N.computeMetrics(s).revenue, 240);
  const rejected = oppOf(s, 'C006', 'ac');
  N.reject(s, rejected.id);
  assert.equal(N.complete(s, rejected.id, 500).ok, false);
  assert.equal(N.computeMetrics(s).revenue, 240);
});

test('TC-11 / FR-11: карточка показывает источник — строку, правило, срок, confidence', () => {
  const s = load();
  for (const o of s.opportunities.filter(o => ['new', 'reviewed'].includes(o.status))) {
    assert.ok(o.reasons.length >= 1);
    for (const r of o.reasons) assert.ok(r.sourceRow && r.sourceDate && r.dueDate && r.confidence && r.title);
  }
  const anna = oppOf(s, 'C002', 'brakes');
  assert.equal(anna.reasons[0].sourceRow, 5); // строка 5 в demo-history.csv
  assert.match(anna.reasons[0].title, /тормозные диски/);
});

test('TC-12 / FR-12: при opt-out Send недоступен, opportunity видима', () => {
  const s = load();
  const opp = oppOf(s, 'C009', 'oil'); // opt_out=yes в CSV
  assert.ok(N.getQueue(s, TODAY).includes(opp));
  N.approve(s, opp.id);
  const r = N.send(s, opp.id, { today: TODAY });
  assert.equal(r.ok, false);
  assert.match(r.error, /opt-out/);
  N.setOptOut(s, 'C009', false);
  assert.ok(N.send(s, opp.id, { today: TODAY }).ok);
});

test('Guardrail G-4: cooldown — второй контакт тому же клиенту блокируется', () => {
  const s = load();
  const oil = oppOf(s, 'C002', 'oil');
  const brakes = oppOf(s, 'C002', 'brakes');
  contact(s, oil);
  N.approve(s, brakes.id);
  const r = N.send(s, brakes.id, { today: TODAY });
  assert.equal(r.ok, false);
  assert.match(r.error, /cooldown/);
});

test('TC-14 / NFR-02: повтор импорта, отправки и Completed не создаёт дублей', () => {
  const s = load();
  const counts = () => [Object.keys(s.customers).length, s.opportunities.length, s.messages.length, N.computeMetrics(s).revenue];
  const opp = oppOf(s, 'C020', 'oil');
  contact(s, opp);
  N.book(s, opp.id, '2026-11-12', '12:00', TODAY);
  N.complete(s, opp.id, 120);
  const before = counts();
  N.importCSV(s, demo, 'test.csv', TODAY);
  N.send(s, opp.id, { today: TODAY });
  N.complete(s, opp.id, 120);
  assert.deepEqual(counts().slice(0, 4), [before[0], before[1] + 1 /* следующий цикл после Completed */, before[2], before[3]]);
});

test('TC-16 / NFR-04: G-1…G-4 по эталонному сценарию, события без текста сообщений', () => {
  const s = load();
  assert.equal(N.computeMetrics(s).g2, null, 'знаменатель 0 → «Нет данных»');
  const a = oppOf(s, 'C001', 'oil');
  const b = oppOf(s, 'C003', 'oil');
  const c = oppOf(s, 'C006', 'ac');
  contact(s, a); contact(s, b); N.reject(s, c.id);
  N.book(s, a.id, '2026-10-20', '11:00', TODAY);
  N.complete(s, a.id, 298);

  const m = N.computeMetrics(s);
  assert.equal(m.revenue, 298);
  assert.equal(m.g1, 298 / 149);       // 2×
  assert.equal(m.g2, 2 / 3);          // 2 approved из 3 решений
  assert.equal(m.g3, 1 / 2);          // 1 запись из 2 контактов
  assert.equal(m.g4, 0);
  for (const t of ['import_completed', 'opportunity_created', 'opportunity_reviewed', 'message_approved', 'message_sent', 'booking_created', 'revenue_completed']) {
    assert.ok(s.events.some(e => e.type === t), t);
  }
  assert.ok(s.events.every(e => !('text' in e)), 'в журнале нет текста сообщений');
});

test('TC-17 / NFR-05: 5000 строк → очередь готова < 60 с', () => {
  let csv = HEADER;
  for (let i = 0; i < 5000; i++) csv += `C${i},Клиент ${i},,V${i},Kia Rio,${40000 + i},2025-${String(1 + (i % 12)).padStart(2, '0')}-15,Замена масла,Через ${1 + (i % 6)} месяца проверить тормозные колодки,100\n`;
  const t0 = Date.now();
  const s = N.createState();
  N.importCSV(s, csv, 'big.csv', TODAY);
  N.getQueue(s, TODAY);
  assert.ok(Date.now() - t0 < 60000);
  assert.ok(s.opportunities.length >= 5000);
});
