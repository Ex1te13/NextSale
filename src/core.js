/*
 * NextSale MVP — ядро (бизнес-логика без UI).
 * Работает и в браузере (window.NextSale), и в Node.js (require) — для автотестов.
 *
 * C-1 CSV-импорт            → importCSV            (FR-01)
 * C-2 AI Notes              → extractFutureWork    (FR-02)
 * C-3 Opportunity Engine    → recompute, getQueue  (FR-03, FR-04, FR-05, FR-11)
 * C-4 Outreach              → generateMessage, approve, reject, send, setOptOut (FR-06, FR-07, FR-08, FR-12)
 * C-5 Booking + Revenue     → book, complete, computeMetrics (FR-09, FR-10, NFR-04)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NextSale = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Настройки (предварительные допущения SRS, уточняются после пилота) ----------
  const CONFIDENCE_THRESHOLD = 0.7; // ниже — Needs review, без авто-outreach
  const KM_PER_DAY = 45;            // ≈16 400 км/год — средний пробег для оценки срока по км
  const EXPIRE_AFTER_DAYS = 180;    // opportunity, просроченная дольше, уходит в Expired
  const ACTIVE = ['new', 'reviewed', 'approved', 'failed', 'contacted', 'booked'];
  const CLOSED = ['rejected', 'completed', 'expired'];

  const STATUS_LABELS = {
    new: 'New', reviewed: 'Reviewed', approved: 'Approved', rejected: 'Rejected',
    failed: 'Failed', contacted: 'Contacted', booked: 'Booked', completed: 'Completed', expired: 'Expired',
  };

  // Каталог услуг и правил обслуживания. Порядок важен для названий услуг: ТО проверяется первым.
  const CATALOG = [
    { id: 'to', label: 'Плановое ТО', re: /(^|[^а-я])то(-?\s?\d)?([^а-я]|$)|техобслуж|техническое обслуж/, defaultAction: 'обслуживание', object: 'плановое ТО', intervalDays: 365, intervalKm: 15000, avgValue: 280 },
    { id: 'oil', label: 'Замена масла', re: /масл/, defaultAction: 'замена', object: 'моторное масло', intervalDays: 365, intervalKm: 15000, avgValue: 160 },
    { id: 'brakes', label: 'Тормозная система', re: /тормоз|колодк/, defaultAction: 'проверка', object: 'тормозная система',
      objects: [[/диск/, 'тормозные диски'], [/колодк/, 'тормозные колодки'], [/жидк/, 'тормозная жидкость']], intervalDays: 730, intervalKm: 40000, avgValue: 240 },
    { id: 'tires', label: 'Сезонная замена шин', re: /(^|[^а-я])шин|резин|переобу|шиномонтаж/, defaultAction: 'замена', object: 'шины (сезонная замена)', intervalDays: 182, avgValue: 80 },
    { id: 'ac', label: 'Обслуживание кондиционера', re: /кондиц|фреон|климат/, defaultAction: 'обслуживание', object: 'кондиционер', intervalDays: 365, avgValue: 110 },
    { id: 'battery', label: 'Замена аккумулятора', re: /аккумулят|(^|[^а-я])акб/, defaultAction: 'замена', object: 'аккумулятор', avgValue: 150 },
    { id: 'suspension', label: 'Ремонт подвески', re: /амортиз|подвеск|сайлент|шрус|стойк|рычаг/, defaultAction: 'проверка', object: 'подвеска',
      objects: [[/амортиз/, 'амортизаторы'], [/сайлент/, 'сайлентблоки'], [/шрус/, 'ШРУС']], avgValue: 300 },
    { id: 'timing', label: 'Замена ремня ГРМ', re: /грм/, defaultAction: 'замена', object: 'ремень ГРМ', intervalKm: 90000, avgValue: 450 },
    { id: 'coolant', label: 'Замена антифриза', re: /антифриз|тосол|охлажд/, defaultAction: 'замена', object: 'антифриз', intervalDays: 730, avgValue: 90 },
    { id: 'spark', label: 'Замена свечей', re: /свеч/, defaultAction: 'замена', object: 'свечи зажигания', intervalKm: 30000, avgValue: 120 },
    { id: 'cabin', label: 'Замена салонного фильтра', re: /салонн\S*\s+фильтр|фильтр\S*\s+салон/, defaultAction: 'замена', object: 'салонный фильтр', intervalDays: 365, avgValue: 45 },
  ];
  const CATEGORY = Object.fromEntries(CATALOG.map(c => [c.id, c]));

  // ---------- Даты (строки YYYY-MM-DD, арифметика в UTC) ----------
  const DAY_MS = 86400000;
  const pad = n => String(n).padStart(2, '0');
  function toISO(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  function fromISO(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
  function todayISO() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseDate(s) {
    s = String(s || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    let y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
    else return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return toISO(dt);
  }
  function addDays(iso, n) { return toISO(new Date(fromISO(iso).getTime() + Math.round(n) * DAY_MS)); }
  function addMonths(iso, n) {
    const d = fromISO(iso);
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
    return toISO(target);
  }
  function diffDays(from, to) { return Math.round((fromISO(to) - fromISO(from)) / DAY_MS); }
  function fmtDate(iso) { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }
  function nextSeasonDate(base, month, day) {
    const d = fromISO(base);
    let y = d.getUTCFullYear();
    if (toISO(new Date(Date.UTC(y, month - 1, day))) <= base) y += 1;
    return toISO(new Date(Date.UTC(y, month - 1, day)));
  }

  // ---------- Состояние ----------
  function createState() {
    return {
      version: 1,
      settings: { shopName: 'Автосервис «Мотор»', saasPrice: 149, cooldownDays: 14, horizonDays: 30, channel: 'SMS (демо-канал)' },
      customers: {}, vehicles: {}, services: [], futureWork: {},
      opportunities: [], messages: [], events: [], imports: [], seq: {},
    };
  }
  function nextId(state, prefix) { state.seq[prefix] = (state.seq[prefix] || 0) + 1; return `${prefix}-${String(state.seq[prefix]).padStart(4, '0')}`; }
  // NFR-04: журнал событий — только типы, UTC-время и ID, без текста сообщений клиентам.
  function logEvent(state, type, data) {
    const ev = Object.assign({ id: nextId(state, 'EV'), type, at: new Date().toISOString() }, data || {});
    state.events.push(ev);
    return ev;
  }
  const findOpp = (state, id) => state.opportunities.find(o => o.id === id);
  const fail = error => ({ ok: false, error });

  // ---------- C-1 · Импорт CSV (FR-01) ----------
  const REQUIRED = ['customer_id', 'customer_name', 'vehicle_id', 'make_model', 'service_date'];
  const CSV_COLUMNS = ['customer_id', 'customer_name', 'phone', 'vehicle_id', 'make_model', 'mileage', 'service_date', 'service_name', 'note', 'amount', 'opt_out'];

  function parseCSV(text) {
    text = String(text).replace(/^﻿/, '');
    const head = text.split(/\r?\n/, 1)[0];
    const delim = head.split(';').length > head.split(',').length ? ';' : ',';
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function categorize(text, forNote) {
    const t = ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е') + ' ';
    const hits = CATALOG.filter(c => c.re.test(t));
    if (!hits.length) return null;
    // В заметке «на следующем ТО поменять масло» важна конкретная работа, а не ТО.
    if (forNote && hits.length > 1) return hits.find(c => c.id !== 'to') || hits[0];
    return hits[0];
  }

  function importCSV(state, text, fileName, today) {
    today = today || todayISO();
    fileName = fileName || 'import.csv';
    const records = parseCSV(text).map((cells, i) => ({ n: i + 1, cells }));
    if (!records.length) return { ok: false, error: 'Файл пуст', imported: 0, duplicates: 0, errors: [] };
    const header = records[0].cells.map(h => h.trim().toLowerCase());
    const missingCols = REQUIRED.filter(c => !header.includes(c));
    if (missingCols.length || (!header.includes('service_name') && !header.includes('note'))) {
      return { ok: false, error: `В заголовке нет обязательных колонок: ${missingCols.concat(header.includes('service_name') || header.includes('note') ? [] : ['service_name/note']).join(', ')}`, imported: 0, duplicates: 0, errors: [] };
    }
    const known = new Set(state.services.map(s => s.key));
    const result = { ok: true, file: fileName, total: 0, imported: 0, duplicates: 0, errors: [] };

    for (const rec of records.slice(1)) {
      if (rec.cells.every(c => c.trim() === '')) continue;
      result.total++;
      const r = {};
      header.forEach((h, i) => { r[h] = (rec.cells[i] || '').trim(); });
      const missing = REQUIRED.filter(f => !r[f]);
      if (!r.service_name && !r.note) missing.push('service_name или note');
      if (missing.length) { result.errors.push({ row: rec.n, message: `Не заполнено: ${missing.join(', ')}` }); continue; }
      const date = parseDate(r.service_date);
      if (!date) { result.errors.push({ row: rec.n, message: `Неверная дата service_date: «${r.service_date}»` }); continue; }
      const mileage = r.mileage ? parseInt(r.mileage.replace(/\s/g, ''), 10) : null;
      const amount = r.amount ? parseFloat(r.amount.replace(/\s/g, '').replace(',', '.')) : null;

      const key = [r.customer_id, r.vehicle_id, date, r.service_name || '', r.note || ''].join('|');
      if (known.has(key)) { result.duplicates++; continue; }
      known.add(key);

      const c = state.customers[r.customer_id] || (state.customers[r.customer_id] = { id: r.customer_id, optOut: false });
      c.name = r.customer_name;
      if (r.phone) c.phone = r.phone;
      if (/^(1|yes|true|да)$/i.test(r.opt_out || '')) c.optOut = true;
      const v = state.vehicles[r.vehicle_id] || (state.vehicles[r.vehicle_id] = { id: r.vehicle_id, mileage: null });
      v.customerId = r.customer_id;
      v.makeModel = r.make_model;
      if (Number.isFinite(mileage)) v.mileage = Math.max(v.mileage || 0, mileage);

      const cat = r.service_name ? categorize(r.service_name) : null;
      state.services.push({
        key, row: rec.n, file: fileName, customerId: r.customer_id, vehicleId: r.vehicle_id, serviceDate: date,
        serviceName: r.service_name || '', note: r.note || '', mileage: Number.isFinite(mileage) ? mileage : null,
        amount: Number.isFinite(amount) ? amount : null, categoryId: cat ? cat.id : null,
      });
      result.imported++;
    }
    state.imports.push({ file: fileName, at: new Date().toISOString(), total: result.total, imported: result.imported, duplicates: result.duplicates, errors: result.errors.length });
    logEvent(state, 'import_completed', { file: fileName, imported: result.imported, duplicates: result.duplicates, errors: result.errors.length });
    const t0 = Date.now();
    result.recompute = recompute(state, today);
    result.recomputeMs = Date.now() - t0;
    return result;
  }

  // ---------- C-2 · AI Notes: заметка механика → future work (FR-02) ----------
  // MVP: детерминированный NLP-разбор (правила + словари). Интерфейс тот же, что у LLM-экстрактора:
  // на выходе service_type, due_date/due_interval, source_note, confidence.
  const NUM_WORDS = { 'один': 1, 'одну': 1, 'одного': 1, 'два': 2, 'две': 2, 'двух': 2, 'пару': 2, 'три': 3, 'трех': 3, 'четыре': 4, 'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10, 'одиннадцать': 11, 'двенадцать': 12, 'полтора': 1.5, 'полторы': 1.5 };
  const NUM_RE = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUM_WORDS).join('|')})`;

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function detectTerm(t, base) {
    let m;
    if ((m = t.match(new RegExp(`через\\s+${NUM_RE}\\s*(тыс\\.?|т\\.)?\\s*км`)))) {
      const n = NUM_WORDS[m[1]] || parseFloat(m[1].replace(',', '.'));
      const km = Math.round(n * (m[2] ? 1000 : 1));
      const days = Math.round(km / KM_PER_DAY);
      return { kind: 'km', dueDate: addDays(base, days), label: `через ${km.toLocaleString('ru-RU')} км (≈${days} дн.)` };
    }
    if (/через\s+пол\s*-?\s*года/.test(t)) return { kind: 'interval', dueDate: addMonths(base, 6), label: 'через 6 мес.' };
    if ((m = t.match(new RegExp(`через\\s+${NUM_RE}\\s+(дн|день|дня|недел|нед|месяц|мес|год|лет)`)))) {
      const n = NUM_WORDS[m[1]] || parseFloat(m[1].replace(',', '.'));
      return termFromUnit(base, n, m[2]);
    }
    if ((m = t.match(/через\s+(день|неделю|месяц|год)/))) return termFromUnit(base, 1, m[1]);
    if (/(к|до|перед)\s+зим|зимой|на зиму/.test(t)) {
      const d = nextSeasonDate(base, 11, 1);
      return { kind: 'season', dueDate: d, label: `к зиме (до ${fmtDate(d)})` };
    }
    if (/весн|(к|до|перед)\s+лет[уа]/.test(t)) {
      const d = nextSeasonDate(base, 4, 1);
      return { kind: 'season', dueDate: d, label: `весной (до ${fmtDate(d)})` };
    }
    return null;
  }
  function termFromUnit(base, n, unit) {
    if (/^(дн|день|дня)/.test(unit)) return { kind: 'interval', dueDate: addDays(base, n), label: `через ${n} ${plural(n, 'день', 'дня', 'дней')}` };
    if (/^нед/.test(unit)) return { kind: 'interval', dueDate: addDays(base, n * 7), label: `через ${n} нед.` };
    const months = /^(год|лет)/.test(unit) ? n * 12 : n;
    const due = Number.isInteger(months) ? addMonths(base, months) : addDays(base, months * 30);
    return { kind: 'interval', dueDate: due, label: `через ${months} мес.` };
  }
  function detectAction(t) {
    const actions = [[/провер|осмотр|посмотр|диагност/, 'проверка'], [/замен|поменя|менять|переобу/, 'замена'], [/обслуж|заправ|почист/, 'обслуживание']];
    let best = null;
    for (const [re, name] of actions) {
      const m = t.match(re);
      if (m && (!best || m.index < best.index)) best = { index: m.index, name };
    }
    return best ? best.name : null;
  }

  function extractFutureWork(note, serviceDate) {
    if (!note || !String(note).trim()) return null;
    const t = ' ' + String(note).toLowerCase().replace(/ё/g, 'е') + ' ';
    const cat = categorize(note, true);
    const term = detectTerm(t, serviceDate);
    const action = detectAction(t);
    const futureHint = /через|рекоменд|нужно|надо|следующ|скоро|позже|потом|проверить|заменить|поменять|менять|посмотреть/.test(t);
    if (!cat && !term) return null;            // в заметке нет будущей работы
    if (!term && !futureHint) return null;     // констатация факта, а не рекомендация

    let object = null, detail = null;
    if (cat) {
      object = cat.object;
      for (const [re, name] of cat.objects || []) if (re.test(t)) { object = name; break; }
      if (/передн/.test(t)) detail = 'передние';
      else if (/задн/.test(t)) detail = 'задние';
    }
    const act = action || (cat ? cat.defaultAction : null);
    let confidence, reviewReason = null;
    if (cat && term) confidence = term.kind === 'km' ? 0.8 : term.kind === 'season' ? 0.85 : action ? 0.93 : 0.82;
    else if (cat) { confidence = 0.45; reviewReason = 'Не удалось уверенно извлечь срок'; }
    else { confidence = 0.4; reviewReason = 'Не удалось определить работу'; }

    return {
      categoryId: cat ? cat.id : null,
      serviceType: `${act || 'работа'}/${object || '?'}`,
      action: act, object, detail,
      dueDate: term ? term.dueDate : null,
      dueInterval: term ? term.label : null,
      sourceNote: note,
      confidence,
      needsReview: confidence < CONFIDENCE_THRESHOLD,
      reviewReason,
    };
  }

  function humanService(fw) {
    return `${fw.action}: ${fw.object}${fw.detail ? ` (${fw.detail})` : ''}`;
  }

  // ---------- C-3 · Opportunity Engine (FR-03, FR-04, FR-05, FR-11) ----------
  function buildCandidates(state) {
    const byVehicle = {};
    for (const s of state.services) (byVehicle[s.vehicleId] = byVehicle[s.vehicleId] || []).push(s);
    const candidates = [];

    for (const [vehicleId, list] of Object.entries(byVehicle)) {
      list.sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));
      const perCat = {};
      const add = (catId, reason) => (perCat[catId] = perCat[catId] || []).push(reason);

      // 1) Правила интервалов по сроку и пробегу — от последней услуги категории.
      for (const cat of CATALOG) {
        const last = list.filter(s => s.categoryId === cat.id).pop();
        if (!last) continue;
        const src = { sourceRow: last.row, sourceFile: last.file, sourceDate: last.serviceDate, sourceService: last.serviceName };
        if (cat.intervalDays) {
          add(cat.id, Object.assign({ kind: 'interval', title: `Правило: «${cat.label}» каждые ${cat.intervalDays} дн.`,
            detail: `Последняя услуга «${last.serviceName}» ${fmtDate(last.serviceDate)} + ${cat.intervalDays} дн.`,
            dueDate: addDays(last.serviceDate, cat.intervalDays), confidence: 0.9 }, src));
        }
        if (cat.intervalKm && last.mileage) {
          const days = Math.round(cat.intervalKm / KM_PER_DAY);
          add(cat.id, Object.assign({ kind: 'mileage', title: `Правило: «${cat.label}» каждые ${cat.intervalKm.toLocaleString('ru-RU')} км`,
            detail: `Пробег ${last.mileage.toLocaleString('ru-RU')} км на ${fmtDate(last.serviceDate)}; ≈${KM_PER_DAY} км/день → +${days} дн.`,
            dueDate: addDays(last.serviceDate, days), confidence: 0.75 }, src));
        }
      }

      // 2) Deferred work из заметок механика (только уверенно извлечённые).
      for (const s of list) {
        const fw = state.futureWork[s.key];
        if (!fw || fw.needsReview || !fw.categoryId) continue;
        const doneLater = list.some(x => x.categoryId === fw.categoryId && x.serviceDate > s.serviceDate);
        if (doneLater) continue;
        add(fw.categoryId, {
          kind: 'note', title: `Заметка механика: «${fw.sourceNote}»`,
          detail: `AI Notes → ${fw.serviceType}${fw.detail ? ` (${fw.detail})` : ''}, ${fw.dueInterval} от ${fmtDate(s.serviceDate)}`,
          dueDate: fw.dueDate, confidence: fw.confidence, human: humanService(fw),
          sourceRow: s.row, sourceFile: s.file, sourceDate: s.serviceDate, sourceService: s.serviceName,
        });
      }

      const v = state.vehicles[vehicleId];
      for (const [catId, reasons] of Object.entries(perCat)) {
        reasons.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.confidence - a.confidence);
        const main = reasons[0]; // ближайший допустимый срок (FR-03)
        const cat = CATEGORY[catId];
        const paid = list.filter(s => s.categoryId === catId && s.amount > 0).map(s => s.amount);
        candidates.push({
          customerId: v.customerId, vehicleId, categoryId: catId,
          title: main.kind === 'note' ? capitalize(main.human) : cat.label,
          human: main.kind === 'note' ? main.human : cat.label.toLowerCase(),
          reasons, dueDate: main.dueDate,
          confidence: Math.max(...reasons.map(r => r.confidence)),
          value: paid.length ? Math.round(paid.reduce((a, b) => a + b, 0) / paid.length) : cat.avgValue,
          anchor: reasons.map(r => r.sourceDate).sort().pop(),
        });
      }
    }
    return candidates;
  }

  function recompute(state, today) {
    today = today || todayISO();
    // AI Notes — идемпотентно: каждая заметка разбирается один раз.
    for (const s of state.services) {
      if (s.note && !(s.key in state.futureWork)) {
        const fw = extractFutureWork(s.note, s.serviceDate);
        state.futureWork[s.key] = fw ? Object.assign(fw, { serviceKey: s.key, customerId: s.customerId, vehicleId: s.vehicleId, sourceRow: s.row, serviceDate: s.serviceDate }) : null;
      }
    }
    const stats = { created: 0, updated: 0, expired: 0 };
    for (const c of buildCandidates(state)) {
      const same = state.opportunities.filter(o => o.customerId === c.customerId && o.vehicleId === c.vehicleId && o.categoryId === c.categoryId);
      const active = same.find(o => ACTIVE.includes(o.status));
      if (active) { // FR-04: не более одной активной opportunity — обновляем причины
        if (['new', 'reviewed'].includes(active.status)) Object.assign(active, { reasons: c.reasons, dueDate: c.dueDate, confidence: c.confidence, title: c.title, human: c.human, value: c.value, anchor: c.anchor });
        stats.updated++;
        continue;
      }
      if (same.some(o => o.anchor === c.anchor)) continue; // этот цикл уже закрыт (Rejected/Expired/Completed)
      const opp = Object.assign({ id: nextId(state, 'OPP'), status: 'new', createdAt: new Date().toISOString(), draft: '', approvedText: null, booking: null, revenue: null }, c);
      opp.draft = opp.generated = generateMessage(state, opp);
      state.opportunities.push(opp);
      logEvent(state, 'opportunity_created', { oppId: opp.id, customerId: opp.customerId });
      stats.created++;
    }
    for (const o of state.opportunities) {
      if (['new', 'reviewed'].includes(o.status) && diffDays(o.dueDate, today) > EXPIRE_AFTER_DAYS) {
        o.status = 'expired';
        logEvent(state, 'opportunity_expired', { oppId: o.id, customerId: o.customerId });
        stats.expired++;
      }
    }
    return stats;
  }

  function readiness(opp, today) {
    const d = diffDays(today, opp.dueDate);
    const time = d <= 0 ? 1 : Math.max(0, 1 - d / 60);
    return Math.round(100 * (0.6 * time + 0.4 * opp.confidence));
  }

  function positionReason(opp, today) {
    const d = diffDays(today, opp.dueDate);
    const when = d < 0 ? `просрочено на ${-d} ${plural(-d, 'день', 'дня', 'дней')}` : d === 0 ? 'срок сегодня' : `срок через ${d} ${plural(d, 'день', 'дня', 'дней')}`;
    const src = opp.reasons.length > 1 ? `${opp.reasons.length} источника` : opp.reasons[0].kind === 'note' ? 'заметка механика' : opp.reasons[0].kind === 'mileage' ? 'правило пробега' : 'правило интервала';
    return `${capitalize(when)} · уверенность ${Math.round(opp.confidence * 100)}% · ${src}`;
  }

  // FR-05: просроченные и ближайшие выше, затем выше confidence, затем ожидаемая ценность.
  function compareOpps(a, b) {
    return a.dueDate.localeCompare(b.dueDate) || b.confidence - a.confidence || b.value - a.value;
  }

  function getQueue(state, today, filter) {
    today = today || todayISO();
    const horizon = addDays(today, state.settings.horizonDays);
    let list;
    if (filter === 'closed') list = state.opportunities.filter(o => CLOSED.includes(o.status));
    else if (filter === 'active') list = state.opportunities.filter(o => ACTIVE.includes(o.status));
    else list = state.opportunities.filter(o => ACTIVE.includes(o.status) && (o.dueDate <= horizon || !['new', 'reviewed'].includes(o.status)));
    return list.slice().sort(compareOpps);
  }

  // ---------- C-4 · Outreach (FR-06, FR-07, FR-08, FR-12) ----------
  function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

  function generateMessage(state, opp) {
    const c = state.customers[opp.customerId];
    const v = state.vehicles[opp.vehicleId];
    const first = (c.name || '').split(/\s+/)[0];
    const main = opp.reasons[0];
    let why;
    if (main.kind === 'note') {
      why = `При визите ${fmtDate(main.sourceDate)} наш мастер рекомендовал для вашего ${v.makeModel}: ${opp.human}. Срок как раз подходит.`;
    } else if (main.kind === 'mileage') {
      why = `По пробегу вашего ${v.makeModel} подходит срок: ${opp.human}.`;
    } else {
      const months = Math.max(1, Math.round(diffDays(main.sourceDate, main.dueDate) / 30.4));
      why = `Для вашего ${v.makeModel} подходит срок: ${opp.human} — последний раз делали ${fmtDate(main.sourceDate)}, рекомендуемый интервал ${months} мес.`;
    }
    return `${first}, здравствуйте! Это ${state.settings.shopName}. ${why}\n\nПредлагаем записаться в удобное для вас время — просто ответьте на это сообщение.\nЧтобы не получать напоминания, ответьте СТОП.`;
  }

  function markReviewed(state, oppId) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    if (o.status === 'new') {
      o.status = 'reviewed';
      o.reviewedAt = new Date().toISOString();
      logEvent(state, 'opportunity_reviewed', { oppId, customerId: o.customerId });
    }
    return { ok: true };
  }

  function updateDraft(state, oppId, text) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    if (!['new', 'reviewed', 'approved', 'failed'].includes(o.status)) return fail('Сообщение уже отправлено');
    o.draft = text;
    if (o.approvedText !== null && o.approvedText !== text) { o.status = 'reviewed'; o.approvedText = null; } // правка сбрасывает approve
    return { ok: true };
  }

  function approve(state, oppId, text) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    if (!['new', 'reviewed', 'approved'].includes(o.status)) return fail(`Нельзя подтвердить в статусе ${STATUS_LABELS[o.status]}`);
    if (o.status === 'new') markReviewed(state, oppId);
    const finalText = typeof text === 'string' ? text : o.draft;
    if (!finalText.trim()) return fail('Пустое сообщение');
    const edited = finalText !== o.generated;
    o.draft = finalText;
    o.approvedText = finalText;
    o.approvedAt = new Date().toISOString();
    o.status = 'approved';
    logEvent(state, 'message_approved', { oppId, customerId: o.customerId, edited: !!edited });
    return { ok: true };
  }

  function reject(state, oppId, reason) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    if (!['new', 'reviewed', 'approved'].includes(o.status)) return fail(`Нельзя отклонить в статусе ${STATUS_LABELS[o.status]}`);
    if (o.status === 'new') markReviewed(state, oppId);
    o.status = 'rejected';
    o.rejectReason = reason || '';
    logEvent(state, 'opportunity_rejected', { oppId, customerId: o.customerId });
    return { ok: true };
  }

  function canSend(state, oppId, today) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    const c = state.customers[o.customerId];
    if (c.optOut) return fail('Клиент отказался от сообщений (opt-out) — отправка запрещена');
    if (!['approved', 'failed'].includes(o.status) || o.approvedText === null) return fail('Сообщение не подтверждено менеджером (нужен Approve)');
    if (o.approvedText !== o.draft) return fail('Текст изменён после подтверждения — подтвердите заново');
    const cooldownFrom = addDays(today || todayISO(), -state.settings.cooldownDays);
    const recent = state.messages.find(m => m.customerId === o.customerId && m.oppId !== o.id && m.status === 'sent' && m.sentDate > cooldownFrom);
    if (recent) return fail(`Клиенту уже писали ${fmtDate(recent.sentDate)} — действует cooldown ${state.settings.cooldownDays} дн.`);
    return { ok: true };
  }

  // FR-08: idempotencyKey — повтор с тем же ключом не создаёт второе сообщение.
  function send(state, oppId, opts) {
    opts = opts || {};
    const today = opts.today || todayISO();
    const key = opts.idempotencyKey || `${oppId}:${(findOpp(state, oppId) || {}).approvedAt}`;
    const existing = state.messages.find(m => m.idempotencyKey === key);
    if (existing && existing.status === 'sent') return { ok: true, duplicate: true, message: existing };
    const check = canSend(state, oppId, today);
    if (!check.ok) { logEvent(state, 'send_blocked', { oppId, reason: check.error }); return check; }
    const o = findOpp(state, oppId);
    const msg = existing || { id: nextId(state, 'MSG'), oppId, customerId: o.customerId, idempotencyKey: key, channel: state.settings.channel, attempts: 0 };
    if (!existing) state.messages.push(msg);
    msg.attempts++;
    msg.text = o.approvedText;
    msg.at = new Date().toISOString();
    if (opts.simulateFailure) {
      msg.status = 'failed';
      msg.error = 'Канал недоступен (timeout)';
      o.status = 'failed';
      logEvent(state, 'message_failed', { oppId, customerId: o.customerId, messageId: msg.id });
      return { ok: false, error: 'Ошибка канала: сообщение не отправлено, можно повторить', message: msg };
    }
    msg.status = 'sent';
    msg.sentDate = today;
    msg.providerMessageId = 'prov_' + Math.random().toString(36).slice(2, 10);
    msg.approvedBeforeSend = true;
    msg.optOutAtSend = !!state.customers[o.customerId].optOut;
    delete msg.error;
    o.status = 'contacted';
    o.contactedAt = msg.at;
    logEvent(state, 'message_sent', { oppId, customerId: o.customerId, messageId: msg.id });
    return { ok: true, message: msg };
  }

  function setOptOut(state, customerId, value) {
    const c = state.customers[customerId];
    if (!c) return fail('Клиент не найден');
    if (c.optOut === !!value) return { ok: true };
    c.optOut = !!value;
    logEvent(state, value ? 'opt_out' : 'opt_out_removed', { customerId });
    return { ok: true };
  }

  // ---------- C-5 · Booking + Revenue (FR-09, FR-10) ----------
  function book(state, oppId, date, time, today) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    if (!['contacted', 'booked'].includes(o.status)) return fail('Запись возможна только после контакта (Contacted)');
    if (!date || !time) return fail('Укажите дату и время записи');
    const d = parseDate(date);
    if (!d || !/^\d{1,2}:\d{2}$/.test(time)) return fail('Неверный формат даты или времени');
    if (d < (today || todayISO())) return fail('Дата записи должна быть в будущем');
    const isUpdate = !!o.booking;
    o.booking = { date: d, time, service: o.title, updatedAt: new Date().toISOString() };
    o.status = 'booked';
    logEvent(state, isUpdate ? 'booking_updated' : 'booking_created', { oppId, customerId: o.customerId });
    return { ok: true, updated: isUpdate };
  }

  function complete(state, oppId, revenue) {
    const o = findOpp(state, oppId);
    if (!o) return fail('Opportunity не найдена');
    if (o.status === 'completed') return { ok: true, duplicate: true }; // NFR-02: повтор не дублирует выручку
    if (o.status !== 'booked') return fail('Completed можно отметить только для Booked');
    const amount = Number(revenue);
    if (revenue === '' || revenue === null || !Number.isFinite(amount) || amount < 0) return fail('Укажите выручку заказа ≥ 0');
    o.status = 'completed';
    o.revenue = amount;
    o.completedAt = new Date().toISOString();
    // Выполненная работа попадает в историю — следующий цикл считается от неё.
    const key = `nextsale|${o.id}`;
    if (!state.services.some(s => s.key === key)) {
      state.services.push({ key, row: null, file: 'NextSale', customerId: o.customerId, vehicleId: o.vehicleId, serviceDate: o.booking.date,
        serviceName: CATEGORY[o.categoryId].label, note: '', mileage: null, amount, categoryId: o.categoryId });
    }
    logEvent(state, 'revenue_completed', { oppId, customerId: o.customerId, amount });
    return { ok: true };
  }

  // ---------- Метрики пилота G-1…G-4 (NFR-04, US-10) ----------
  function computeMetrics(state) {
    const ratio = (num, den) => (den > 0 ? num / den : null); // null → «Нет данных»
    const opps = state.opportunities;
    const approvedIds = new Set(state.events.filter(e => e.type === 'message_approved').map(e => e.oppId));
    const rejectedIds = new Set(state.events.filter(e => e.type === 'opportunity_rejected').map(e => e.oppId));
    const decided = new Set([...approvedIds, ...rejectedIds]);
    const sent = state.messages.filter(m => m.status === 'sent');
    const contactedOpps = new Set(sent.map(m => m.oppId));
    const bookedOpps = new Set(state.events.filter(e => e.type === 'booking_created').map(e => e.oppId));
    const revenue = opps.filter(o => o.status === 'completed').reduce((a, o) => a + o.revenue, 0);

    // G-4: нарушения guardrail — отправки без approve, с opt-out, дубли и cooldown.
    const perOpp = {};
    for (const m of sent) perOpp[m.oppId] = (perOpp[m.oppId] || 0) + 1;
    const violations = {
      withoutApprove: sent.filter(m => !m.approvedBeforeSend || !approvedIds.has(m.oppId)).length,
      optOut: sent.filter(m => m.optOutAtSend).length,
      duplicates: Object.values(perOpp).reduce((a, n) => a + Math.max(0, n - 1), 0),
      cooldown: sent.filter(m => sent.some(x => x.at < m.at && x.customerId === m.customerId && x.oppId !== m.oppId && diffDays(x.sentDate, m.sentDate) < state.settings.cooldownDays)).length,
    };
    const g4 = violations.withoutApprove + violations.optOut + violations.duplicates + violations.cooldown;

    return {
      revenue,
      saasPrice: state.settings.saasPrice,
      g1: ratio(revenue, state.settings.saasPrice),
      g2: ratio(approvedIds.size, decided.size), approved: approvedIds.size, reviewed: decided.size,
      g3: ratio([...bookedOpps].filter(id => contactedOpps.has(id)).length, contactedOpps.size), booked: bookedOpps.size, contacted: contactedOpps.size,
      g4, violations,
      funnel: [
        ['Opportunities создано', opps.length],
        ['Просмотрено менеджером', opps.filter(o => o.reviewedAt).length],
        ['Одобрено (Approve)', approvedIds.size],
        ['Отправлено (Contacted)', contactedOpps.size],
        ['Записались (Booked)', bookedOpps.size],
        ['Визит завершён (Completed)', opps.filter(o => o.status === 'completed').length],
      ],
      needsReview: Object.values(state.futureWork).filter(f => f && f.needsReview).length,
    };
  }

  return {
    CATALOG, CATEGORY, STATUS_LABELS, ACTIVE, CLOSED, CSV_COLUMNS, CONFIDENCE_THRESHOLD, KM_PER_DAY,
    createState, parseCSV, importCSV, categorize, extractFutureWork, recompute, getQueue, readiness, positionReason,
    generateMessage, markReviewed, updateDraft, approve, reject, canSend, send, setOptOut, book, complete, computeMetrics,
    parseDate, addDays, addMonths, diffDays, fmtDate, todayISO, plural,
  };
});
