/* NextSale MVP — интерфейс сервис-менеджера и владельца. Вся логика — в core.js. */
(function () {
  'use strict';
  const N = window.NextSale;
  const STORE = 'nextsale.mvp.v1';
  const app = document.getElementById('app');

  let state = loadState();
  const ui = { view: 'queue', filter: 'today', openId: null, simulateFailure: false, lastImport: null, toast: null, playground: null };

  // ---------- Хранилище (localStorage браузера) ----------
  function loadState() {
    try { const raw = localStorage.getItem(STORE); if (raw) return JSON.parse(raw); } catch (e) { /* приватный режим */ }
    return N.createState();
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* без сохранения */ } }

  // ---------- Утилиты ----------
  const today = () => N.todayISO();
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eur = n => '€' + Math.round(n).toLocaleString('ru-RU');
  const pct = n => (n == null ? 'Нет данных' : Math.round(n * 100) + '%');
  const time = iso => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const opp = id => state.opportunities.find(o => o.id === id);
  const statusBadge = s => `<span class="badge st-${s}">${N.STATUS_LABELS[s]}</span>`;

  function toast(text, kind) {
    ui.toast = { text, kind: kind || 'ok', id: Date.now() };
    const id = ui.toast.id;
    setTimeout(() => { if (ui.toast && ui.toast.id === id) { ui.toast = null; render(); } }, 3800);
  }
  function result(r, okText) {
    if (r && r.ok === false) toast(r.error, 'err');
    else if (okText) toast(okText);
    save();
    render();
  }

  // ---------- Шапка ----------
  function header() {
    const q = N.getQueue(state, today()).length;
    const tab = (v, label, badge) => `<button class="tab ${ui.view === v ? 'on' : ''}" data-action="nav" data-view="${v}">${label}${badge ? `<span class="count">${badge}</span>` : ''}</button>`;
    return `<header class="topbar">
      <div class="brand"><span class="logo">N</span><div><b>NextSale</b><small>AI-агент повторных продаж</small></div></div>
      <nav class="tabs">
        ${tab('queue', 'Очередь', q)}
        ${tab('import', 'Импорт и AI Notes')}
        ${tab('dashboard', 'Dashboard владельца')}
        ${tab('log', 'Журнал')}
      </nav>
      <div class="shop">${esc(state.settings.shopName)}<small>${N.fmtDate(today())}</small></div>
    </header>`;
  }

  // ---------- Очередь (US-03, FR-05) ----------
  function queueView() {
    if (!state.opportunities.length) return emptyState();
    const t = today();
    const list = N.getQueue(state, t, ui.filter);
    const todayList = N.getQueue(state, t);
    const overdue = todayList.filter(o => o.dueDate < t && ['new', 'reviewed'].includes(o.status)).length;
    const potential = todayList.reduce((a, o) => a + o.value, 0);
    const m = N.computeMetrics(state);
    const chip = (f, label, n) => `<button class="chip ${ui.filter === f ? 'on' : ''}" data-action="filter" data-filter="${f}">${label} <span>${n}</span></button>`;

    return `<section class="hero">
      <div>
        <h1>Кому написать сегодня</h1>
        <p>NextSale нашёл в истории сервиса и заметках механиков повторные продажи. Откройте клиента — проверьте причину, подтвердите сообщение и зафиксируйте запись.</p>
      </div>
      <div class="flow">История → Opportunity → Сообщение → Запись → Выручка</div>
    </section>
    <section class="kpis">
      ${kpi('В очереди', todayList.length, 'срок в ближайшие ' + state.settings.horizonDays + ' дн.')}
      ${kpi('Просрочено', overdue, 'клиенты, которым пора писать', overdue ? 'warn' : '')}
      ${kpi('Потенциал очереди', eur(potential), 'ожидаемая выручка')}
      ${kpi('Атрибутировано NextSale', eur(m.revenue), m.g1 == null ? '' : `${m.g1.toFixed(1)}× к цене SaaS`, 'good')}
    </section>
    <div class="chips">
      ${chip('today', 'К работе', todayList.length)}
      ${chip('active', 'Все активные', N.getQueue(state, t, 'active').length)}
      ${chip('closed', 'Закрытые', N.getQueue(state, t, 'closed').length)}
    </div>
    <section class="queue">
      <div class="qhead"><span>Клиент · автомобиль</span><span>Возможность и причина позиции</span><span>Готовность</span><span>Ценность</span><span>Статус</span><span></span></div>
      ${list.map(o => row(o, t)).join('') || '<p class="muted pad">Здесь пока пусто.</p>'}
    </section>`;
  }
  function kpi(label, value, sub, kind) {
    return `<div class="kpi ${kind || ''}"><span>${label}</span><b>${value}</b><small>${esc(sub)}</small></div>`;
  }
  function row(o, t) {
    const c = state.customers[o.customerId], v = state.vehicles[o.vehicleId];
    const r = N.readiness(o, t);
    return `<button class="opp" data-action="open" data-id="${o.id}">
      <div class="who"><b>${esc(c.name)}</b><span>${esc(v.makeModel)}${c.optOut ? ' · <em class="optout">opt-out</em>' : ''}</span></div>
      <div class="svc"><b>${esc(o.title)}</b><span>${esc(N.positionReason(o, t))}</span></div>
      <div><span class="ready ${r >= 85 ? 'hi' : r >= 70 ? 'mid' : 'lo'}">${r}% ready</span></div>
      <div class="val">≈ ${eur(o.value)}</div>
      <div>${statusBadge(o.status)}</div>
      <div class="cta">${['new', 'reviewed'].includes(o.status) ? 'Написать →' : 'Открыть →'}</div>
    </button>`;
  }
  function emptyState() {
    return `<section class="empty">
      <div class="logo big">N</div>
      <h1>Загрузите историю сервиса</h1>
      <p>NextSale работает поверх существующей базы: импортируйте CSV с клиентами, автомобилями, работами и заметками механиков — и получите очередь повторных продаж.</p>
      <div class="row-btns">
        <button class="btn primary" data-action="demo">Загрузить демо-автосервис</button>
        <button class="btn" data-action="nav" data-view="import">Импортировать свой CSV</button>
      </div>
    </section>`;
  }

  // ---------- Карточка opportunity (US-04…US-08) ----------
  function drawer() {
    const o = opp(ui.openId);
    if (!o) return '';
    const c = state.customers[o.customerId], v = state.vehicles[o.vehicleId];
    const t = today();
    const steps = ['new', 'reviewed', 'approved', 'contacted', 'booked', 'completed'];
    const idx = steps.indexOf(o.status === 'failed' ? 'approved' : o.status);
    const closed = ['rejected', 'expired'].includes(o.status);
    const history = state.events.filter(e => e.oppId === o.id || (e.customerId === o.customerId && /opt_out/.test(e.type)));

    return `<div class="overlay" data-action="close"></div>
    <aside class="drawer" role="dialog" aria-label="Карточка opportunity">
      <div class="dhead">
        <div>
          <small class="muted">${o.id}</small>
          <h2>${esc(c.name)} · ${esc(v.makeModel)}</h2>
          <div class="muted">${esc(c.phone || 'телефон не указан')}${v.mileage ? ` · пробег ${v.mileage.toLocaleString('ru-RU')} км` : ''}</div>
        </div>
        <button class="icon" data-action="close" aria-label="Закрыть">✕</button>
      </div>

      <div class="opp-title"><b>${esc(o.title)}</b>${statusBadge(o.status)}<span class="muted">срок ${N.fmtDate(o.dueDate)} · ≈ ${eur(o.value)} · уверенность ${Math.round(o.confidence * 100)}%</span></div>

      ${closed ? `<div class="note-box">${o.status === 'rejected' ? 'Отклонено менеджером — сообщение не отправлялось.' : 'Срок давно прошёл — opportunity истекла.'}</div>` :
        `<ol class="stepper">${steps.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'cur' : ''}">${N.STATUS_LABELS[s]}</li>`).join('')}</ol>`}

      <label class="optout-toggle ${c.optOut ? 'on' : ''}">
        <input type="checkbox" data-action="optout" data-customer="${c.id}" ${c.optOut ? 'checked' : ''}>
        <span>Клиент отказался от сообщений (opt-out)</span>
      </label>

      <section class="block">
        <h3>Почему NextSale предлагает это</h3>
        <ul class="reasons">
          ${o.reasons.map((r, i) => `<li class="${r.kind}">
            <div class="rk">${r.kind === 'note' ? 'AI Notes' : r.kind === 'mileage' ? 'Пробег' : 'Интервал'}${i === 0 ? '<em>определяет срок</em>' : ''}</div>
            <b>${esc(r.title)}</b>
            <span>${esc(r.detail)}</span>
            <small>Источник: строка ${r.sourceRow} · ${esc(r.sourceFile)} · срок ${N.fmtDate(r.dueDate)} · уверенность ${Math.round(r.confidence * 100)}%</small>
          </li>`).join('')}
        </ul>
      </section>

      ${messageBlock(o, c, t)}
      ${bookingBlock(o, t)}

      <section class="block">
        <h3>История</h3>
        <ul class="history">${history.map(e => `<li><span>${time(e.at)}</span>${esc(e.type)}</li>`).join('') || '<li class="muted">Событий пока нет</li>'}</ul>
      </section>
    </aside>`;
  }

  function messageBlock(o, c, t) {
    const sent = state.messages.filter(m => m.oppId === o.id);
    if (['contacted', 'booked', 'completed'].includes(o.status)) {
      const m = sent.find(x => x.status === 'sent');
      return `<section class="block"><h3>Сообщение отправлено</h3>
        <div class="bubble">${esc(m.text)}</div>
        <small class="muted">${esc(m.channel)} · ${time(m.at)} · message_id ${m.id} · попыток: ${m.attempts}</small></section>`;
    }
    if (['rejected', 'expired'].includes(o.status)) return '';
    const approved = o.status === 'approved' || (o.status === 'failed' && o.approvedText !== null);
    const check = N.canSend(state, o.id, t);
    const failed = sent.find(x => x.status === 'failed');
    return `<section class="block">
      <h3>Сообщение клиенту <small class="muted">черновик сгенерирован, можно править</small></h3>
      <textarea id="msg-text" data-action="draft" data-id="${o.id}" rows="7">${esc(o.draft)}</textarea>
      ${failed ? `<div class="note-box err">${esc(failed.error)} — статус Failed. Можно повторить отправку.</div>` : ''}
      <div class="row-btns">
        ${approved
          ? `<span class="approved">✓ Подтверждено менеджером</span>
             <button class="btn primary" data-action="send" data-id="${o.id}" ${check.ok ? '' : 'disabled'}>${o.status === 'failed' ? 'Повторить отправку' : 'Отправить · ' + esc(state.settings.channel)}</button>`
          : `<button class="btn primary" data-action="approve" data-id="${o.id}">Подтвердить (Approve)</button>
             <button class="btn" data-action="regen" data-id="${o.id}">Сгенерировать заново</button>`}
        <button class="btn ghost danger" data-action="reject" data-id="${o.id}">Отклонить</button>
      </div>
      ${approved && !check.ok ? `<div class="note-box warn">${esc(check.error)}</div>` : ''}
      ${!approved ? '<small class="muted">Без подтверждения отправка невозможна. После правки текста подтверждение сбрасывается.</small>' : ''}
      ${approved ? `<label class="sim"><input type="checkbox" data-action="simfail" ${ui.simulateFailure ? 'checked' : ''}> Имитировать сбой канала (для проверки retry)</label>` : ''}
    </section>`;
  }

  function bookingBlock(o, t) {
    if (o.status === 'contacted' || o.status === 'booked') {
      const b = o.booking || { date: N.addDays(t, 3), time: '10:00' };
      return `<section class="block">
        <h3>${o.status === 'booked' ? 'Запись подтверждена' : 'Клиент ответил? Зафиксируйте запись'}</h3>
        <div class="form-row">
          <label>Дата<input type="date" id="bk-date" value="${b.date}" min="${t}"></label>
          <label>Время<input type="time" id="bk-time" value="${b.time}"></label>
          <button class="btn ${o.status === 'booked' ? '' : 'primary'}" data-action="book" data-id="${o.id}">${o.status === 'booked' ? 'Изменить запись' : 'Сохранить запись'}</button>
        </div>
        ${o.status === 'booked' ? `<div class="form-row sep">
          <label>Выручка заказа, €<input type="number" id="rev" min="0" step="1" value="${o.value}"></label>
          <button class="btn primary" data-action="complete" data-id="${o.id}">Визит завершён (Completed)</button>
        </div>` : ''}
      </section>`;
    }
    if (o.status === 'completed') {
      return `<section class="block done-block"><h3>Визит завершён</h3>
        <p><b>${eur(o.revenue)}</b> атрибутировано NextSale · запись ${N.fmtDate(o.booking.date)} ${esc(o.booking.time)}</p>
        <small class="muted">Работа добавлена в историю — следующий цикл обслуживания будет рассчитан от неё.</small></section>`;
    }
    return '';
  }

  // ---------- Импорт и AI Notes (US-01, US-02) ----------
  function importView() {
    const r = ui.lastImport;
    const notes = state.services.filter(s => s.note).map(s => ({ s, fw: state.futureWork[s.key] }));
    const pg = ui.playground;
    return `<section class="grid2">
      <div class="card">
        <h2>Импорт истории из CSV</h2>
        <p class="muted">Клиенты, автомобили, работы и заметки механиков. CRM менять не нужно — достаточно выгрузки.</p>
        <label class="drop" id="drop">
          <input type="file" accept=".csv,text/csv" data-action="file">
          <b>Перетащите CSV сюда</b><span>или нажмите, чтобы выбрать файл</span>
        </label>
        <div class="row-btns">
          <button class="btn primary" data-action="demo">Демо-история (25 строк)</button>
          <button class="btn" data-action="demo-errors">Файл с ошибками</button>
          <button class="btn ghost" data-action="template">Скачать шаблон CSV</button>
        </div>
        <details class="spec"><summary>Формат файла</summary>
          <p>Обязательные колонки: <code>customer_id, customer_name, vehicle_id, make_model, service_date</code> и хотя бы одна из <code>service_name</code> / <code>note</code>.</p>
          <p>Необязательные: <code>phone, mileage, amount, opt_out</code>. Даты — <code>ГГГГ-ММ-ДД</code> или <code>ДД.ММ.ГГГГ</code>. Разделитель — запятая или точка с запятой.</p>
          <p>Повторная загрузка того же файла не создаёт дублей.</p>
        </details>
      </div>
      <div class="card">
        <h2>Результат импорта</h2>
        ${r ? (r.ok === false && r.error ? `<div class="note-box err">${esc(r.error)}</div>` : `
          <div class="stats">
            <div><b>${r.imported}</b><span>импортировано</span></div>
            <div><b>${r.duplicates}</b><span>дублей пропущено</span></div>
            <div class="${r.errors.length ? 'bad' : ''}"><b>${r.errors.length}</b><span>строк с ошибками</span></div>
            <div><b>${r.recompute.created}</b><span>новых opportunities</span></div>
          </div>
          <p class="muted">Файл ${esc(r.file)} · пересчёт очереди за ${r.recomputeMs} мс</p>
          ${r.errors.length ? `<table class="tbl"><thead><tr><th>Строка</th><th>Ошибка</th></tr></thead><tbody>${r.errors.map(e => `<tr><td>${e.row}</td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table>` : ''}
          ${r.recompute.created ? '<button class="btn primary" data-action="nav" data-view="queue">Перейти к очереди →</button>' : ''}`)
        : '<p class="muted">Загрузите файл — здесь появится отчёт: что импортировано, какие строки отклонены и почему.</p>'}
        ${state.imports.length ? `<h3>История загрузок</h3><table class="tbl"><thead><tr><th>Файл</th><th>Когда</th><th>Импорт</th><th>Дубли</th><th>Ошибки</th></tr></thead><tbody>
          ${state.imports.slice().reverse().map(i => `<tr><td>${esc(i.file)}</td><td>${time(i.at)}</td><td>${i.imported}</td><td>${i.duplicates}</td><td>${i.errors}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
    </section>

    <section class="card">
      <h2>AI Notes: заметки механиков → будущая работа</h2>
      <p class="muted">Каждая заметка превращается в структуру <code>service_type · due_date · confidence</code>. Если срок или работа не извлекаются уверенно (confidence &lt; ${Math.round(N.CONFIDENCE_THRESHOLD * 100)}%), запись получает статус Needs review и не идёт в outreach.</p>
      <div class="playground">
        <textarea id="pg-note" rows="2" placeholder="Например: через 3 месяца проверить передние тормозные диски">${esc(pg ? pg.note : 'Через 3 месяца проверить передние тормозные диски')}</textarea>
        <label>Дата визита<input type="date" id="pg-date" value="${pg ? pg.date : today()}"></label>
        <button class="btn primary" data-action="parse">Разобрать заметку</button>
      </div>
      ${pg ? playgroundResult(pg.fw) : ''}
      ${notes.length ? `<table class="tbl notes"><thead><tr><th>Клиент</th><th>Заметка механика</th><th>service_type</th><th>Срок</th><th>Confidence</th><th>Статус</th></tr></thead><tbody>
        ${notes.map(({ s, fw }) => `<tr>
          <td>${esc(state.customers[s.customerId].name)}<small>${esc(state.vehicles[s.vehicleId].makeModel)} · ${N.fmtDate(s.serviceDate)}</small></td>
          <td>«${esc(s.note)}»</td>
          <td>${fw ? esc(fw.serviceType) + (fw.detail ? ` <small>${esc(fw.detail)}</small>` : '') : '—'}</td>
          <td>${fw && fw.dueDate ? N.fmtDate(fw.dueDate) + `<small>${esc(fw.dueInterval)}</small>` : '—'}</td>
          <td>${fw ? Math.round(fw.confidence * 100) + '%' : '—'}</td>
          <td>${!fw ? '<span class="badge st-expired">Нет будущей работы</span>' : fw.needsReview ? `<span class="badge st-failed">Needs review</span><small>${esc(fw.reviewReason)}</small>` : '<span class="badge st-completed">Future work</span>'}</td>
        </tr>`).join('')}</tbody></table>` : ''}
    </section>`;
  }
  function playgroundResult(fw) {
    if (!fw) return '<div class="note-box">В заметке не найдено рекомендации на будущее.</div>';
    return `<div class="pg-result ${fw.needsReview ? 'review' : ''}">
      <div><span>service_type</span><b>${esc(fw.serviceType)}${fw.detail ? ' (' + esc(fw.detail) + ')' : ''}</b></div>
      <div><span>due_date</span><b>${fw.dueDate ? N.fmtDate(fw.dueDate) : '—'}</b></div>
      <div><span>due_interval</span><b>${esc(fw.dueInterval || '—')}</b></div>
      <div><span>confidence</span><b>${Math.round(fw.confidence * 100)}%</b></div>
      <div><span>статус</span><b>${fw.needsReview ? 'Needs review — ' + esc(fw.reviewReason) : 'Future work → Opportunity'}</b></div>
    </div>`;
  }

  // ---------- Dashboard владельца (US-08, US-10) ----------
  function dashboardView() {
    const m = N.computeMetrics(state);
    const maxF = Math.max(1, ...m.funnel.map(f => f[1]));
    const done = state.opportunities.filter(o => o.status === 'completed');
    const metric = (id, title, value, target, ok, sub) => `<div class="metric ${value === 'Нет данных' ? 'nodata' : ok ? 'ok' : 'below'}">
      <span class="mid">${id}</span><b>${value}</b><div>${title}</div><small>Цель пилота: ${target}${sub ? ' · ' + sub : ''}</small></div>`;
    return `<section class="hero small"><div><h1>Результаты пилота</h1><p>Метрики успеха из PRD считаются по журналу событий. При нулевом знаменателе — «Нет данных».</p></div></section>
    <section class="metrics">
      ${metric('G-1', 'Атрибутированная выручка / цена SaaS', m.g1 == null ? 'Нет данных' : m.g1.toFixed(1) + '×', '≥ 5×', m.g1 >= 5, `${eur(m.revenue)} / ${eur(m.saasPrice)} в мес.`)}
      ${metric('G-2', 'Opportunities одобрены менеджером', pct(m.g2), '≥ 70%', m.g2 >= 0.7, `${m.approved} из ${m.reviewed} решений`)}
      ${metric('G-3', 'Контакт → подтверждённая запись', pct(m.g3), '≥ 8%', m.g3 >= 0.08, `${m.booked} записей из ${m.contacted} контактов`)}
      ${metric('G-4', 'Нарушения guardrail', String(m.g4), '= 0', m.g4 === 0, `без approve: ${m.violations.withoutApprove} · opt-out: ${m.violations.optOut} · дубли: ${m.violations.duplicates} · cooldown: ${m.violations.cooldown}`)}
    </section>
    <section class="grid2">
      <div class="card">
        <h2>Воронка</h2>
        <div class="funnel">${m.funnel.map(([label, n]) => `<div class="fr"><span>${label}</span><div class="bar"><i style="width:${(n / maxF) * 100}%"></i></div><b>${n}</b></div>`).join('')}</div>
        ${m.needsReview ? `<p class="muted">Ещё ${m.needsReview} заметок ждут ручной проверки (Needs review).</p>` : ''}
      </div>
      <div class="card">
        <h2>Атрибутированная выручка</h2>
        ${done.length ? `<table class="tbl"><thead><tr><th>Клиент</th><th>Работа</th><th>Дата</th><th>Выручка</th></tr></thead><tbody>
          ${done.map(o => `<tr><td>${esc(state.customers[o.customerId].name)}</td><td>${esc(o.title)}</td><td>${N.fmtDate(o.booking.date)}</td><td>${eur(o.revenue)}</td></tr>`).join('')}
          <tr class="total"><td colspan="3">Итого</td><td>${eur(m.revenue)}</td></tr></tbody></table>` : '<p class="muted">Пока нет завершённых визитов. Проведите клиента по цепочке: Approve → Отправить → Запись → Completed.</p>'}
        <h3>Настройки пилота</h3>
        <div class="form-row">
          <label>Цена SaaS, €/мес<input type="number" min="1" id="set-price" value="${state.settings.saasPrice}"></label>
          <label>Cooldown, дн.<input type="number" min="0" id="set-cooldown" value="${state.settings.cooldownDays}"></label>
          <button class="btn" data-action="settings">Сохранить</button>
        </div>
      </div>
    </section>`;
  }

  // ---------- Журнал событий (NFR-04) и исходящие ----------
  function logView() {
    const ev = state.events.slice().reverse();
    return `<section class="grid2">
      <div class="card">
        <h2>Аналитический журнал</h2>
        <p class="muted">UTC-время, тип и ID — без текста клиентских сообщений. Из него считаются G-1…G-4.</p>
        <table class="tbl"><thead><tr><th>Время (UTC)</th><th>Событие</th><th>Объект</th></tr></thead><tbody>
          ${ev.map(e => `<tr><td><code>${e.at.slice(0, 19).replace('T', ' ')}</code></td><td>${esc(e.type)}</td><td>${esc([e.oppId, e.customerId, e.file, e.amount != null ? '€' + e.amount : ''].filter(Boolean).join(' · '))}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Пусто</td></tr>'}
        </tbody></table>
      </div>
      <div class="card">
        <h2>Исходящие сообщения</h2>
        <p class="muted">Демо-канал: сообщения не уходят наружу, а складываются сюда.</p>
        ${state.messages.slice().reverse().map(m => `<div class="out ${m.status}">
          <div><b>${esc(state.customers[m.customerId].name)}</b> · ${esc(state.customers[m.customerId].phone || '')}<span>${m.status === 'sent' ? 'Отправлено' : 'Ошибка'} · ${time(m.at)}</span></div>
          <p>${esc(m.text)}</p></div>`).join('') || '<p class="muted">Ещё ничего не отправлено.</p>'}
      </div>
    </section>`;
  }

  // ---------- Рендер ----------
  function render() {
    const focus = document.activeElement && document.activeElement.id;
    const sel = focus && document.activeElement.selectionStart;
    const scroll = document.querySelector('.drawer') ? document.querySelector('.drawer').scrollTop : 0;
    const views = { queue: queueView, import: importView, dashboard: dashboardView, log: logView };
    app.innerHTML = `${header()}<main>${views[ui.view]()}</main>
      <footer><span>NextSale MVP · данные хранятся локально в браузере</span><button class="link" data-action="reset">Сбросить данные</button></footer>
      ${drawer()}
      ${ui.toast ? `<div class="toast ${ui.toast.kind}">${esc(ui.toast.text)}</div>` : ''}`;
    document.body.classList.toggle('locked', !!ui.openId);
    const d = document.querySelector('.drawer');
    if (d) d.scrollTop = scroll;
    if (focus) {
      const el = document.getElementById(focus);
      if (el) { el.focus(); if (sel != null && el.setSelectionRange) try { el.setSelectionRange(sel, sel); } catch (e) { /* date input */ } }
    }
  }

  function doImport(text, name) {
    ui.lastImport = N.importCSV(state, text, name, today());
    save();
    ui.view = 'import';
    if (ui.lastImport.ok === false) toast(ui.lastImport.error, 'err');
    else toast(`Импортировано строк: ${ui.lastImport.imported}, новых opportunities: ${ui.lastImport.recompute.created}`);
    render();
  }

  // ---------- Действия ----------
  const actions = {
    nav: el => { ui.view = el.dataset.view; ui.openId = null; render(); window.scrollTo(0, 0); },
    filter: el => { ui.filter = el.dataset.filter; render(); },
    open: el => { ui.openId = el.dataset.id; N.markReviewed(state, ui.openId); save(); render(); },
    close: () => { ui.openId = null; render(); },
    demo: () => doImport(window.NEXTSALE_DEMO.history.text, window.NEXTSALE_DEMO.history.name),
    'demo-errors': () => doImport(window.NEXTSALE_DEMO.withErrors.text, window.NEXTSALE_DEMO.withErrors.name),
    template: () => {
      const blob = new Blob(['﻿' + N.CSV_COLUMNS.join(',') + '\nC001,Иван Петров,+7 900 000-00-00,V001,BMW 320i,84200,2025-10-05,Замена масла,Через 3 месяца проверить тормозные диски,150,\n'], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'nextsale-template.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    },
    parse: () => {
      const note = document.getElementById('pg-note').value;
      const date = document.getElementById('pg-date').value || today();
      ui.playground = { note, date, fw: N.extractFutureWork(note, date) };
      render();
    },
    regen: el => { const o = opp(el.dataset.id); o.draft = o.generated = N.generateMessage(state, o); result({ ok: true }, 'Черновик пересоздан'); },
    approve: el => result(N.approve(state, el.dataset.id, document.getElementById('msg-text').value), 'Сообщение подтверждено'),
    reject: el => result(N.reject(state, el.dataset.id, ''), 'Opportunity отклонена — отправки не будет'),
    send: el => {
      const r = N.send(state, el.dataset.id, { simulateFailure: ui.simulateFailure, today: today() });
      ui.simulateFailure = false;
      result(r, r.duplicate ? 'Уже отправлено — дубль не создан' : 'Сообщение отправлено, статус Contacted');
    },
    book: el => result(N.book(state, el.dataset.id, document.getElementById('bk-date').value, document.getElementById('bk-time').value, today()), 'Запись сохранена — статус Booked'),
    complete: el => {
      const r = N.complete(state, el.dataset.id, document.getElementById('rev').value);
      if (r.ok) N.recompute(state, today()); // следующий цикл обслуживания
      result(r, 'Визит завершён, выручка атрибутирована');
    },
    settings: () => {
      const price = Number(document.getElementById('set-price').value);
      const cd = Number(document.getElementById('set-cooldown').value);
      if (price > 0) state.settings.saasPrice = price;
      if (cd >= 0) state.settings.cooldownDays = cd;
      result({ ok: true }, 'Настройки сохранены');
    },
    reset: () => {
      if (!confirm('Удалить все загруженные данные и начать заново?')) return;
      state = N.createState(); Object.assign(ui, { openId: null, lastImport: null, view: 'queue' });
      save(); render();
    },
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
    const fn = actions[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.action === 'optout') result(N.setOptOut(state, el.dataset.customer, el.checked), el.checked ? 'Opt-out включён — отправка заблокирована' : 'Opt-out снят');
    if (el.dataset.action === 'simfail') ui.simulateFailure = el.checked;
    if (el.dataset.action === 'file' && el.files[0]) {
      const f = el.files[0];
      f.text().then(text => doImport(text, f.name));
    }
  });
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.action !== 'draft') return;
    const o = opp(el.dataset.id);
    const before = o.status;
    N.updateDraft(state, o.id, el.value);
    save();
    if (before !== o.status) render(); // подтверждение сброшено правкой
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.openId) { ui.openId = null; render(); } });
  document.addEventListener('dragover', e => { if (e.target.closest('#drop')) { e.preventDefault(); e.target.closest('#drop').classList.add('over'); } });
  document.addEventListener('drop', e => {
    const zone = e.target.closest('#drop');
    if (!zone) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) f.text().then(text => doImport(text, f.name));
  });

  N.recompute(state, today()); // обновить сроки и Expired на сегодняшнюю дату
  save();
  render();
})();
