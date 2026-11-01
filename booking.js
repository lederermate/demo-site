// =====================================================================
// Play Padel – foglaltsági naptár és foglalás
// Élő mód: Supabase (config.js), egyébként demó mód (böngészőben tárolva).
// =====================================================================
(() => {
  const COURTS = [
    { id: 'piros', label: 'Piros' },
    { id: 'zold', label: 'Zöld' },
    { id: 'lila', label: 'Lila' },
  ];
  const SLOT = 30;          // perc
  const CLOSE = 22 * 60;    // zárás percben
  const DAYS_AHEAD = 14;    // ennyi nap látszik a naptárban

  const cfg = window.PLAY_PADEL_CONFIG || {};
  const LIVE = Boolean(cfg.supabaseUrl && cfg.supabaseKey);

  // ---------- segédfüggvények ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmt = (m) => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  const parseTime = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const dateOf = (iso) => new Date(iso + 'T12:00');
  const isWeekend = (iso) => [0, 6].includes(dateOf(iso).getDay());
  const openFor = (iso) => (isWeekend(iso) ? 8 * 60 : 7 * 60);
  const courtLabel = (id) => COURTS.find((c) => c.id === id).label;
  const overlaps = (list, court, start, end) => list.some((b) => b.court === court && b.start < end && start < b.end);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const huf = (n) => n.toLocaleString('hu-HU') + ' Ft';

  // Óradíj az árak szekció szerint (félórás bontásban számolva)
  function priceFor(iso, start, minutes) {
    let total = 0;
    for (let t = start; t < start + minutes; t += SLOT) {
      const hourly = isWeekend(iso) ? 10000 : t >= 16 * 60 ? 12000 : 8000;
      total += hourly / 2;
    }
    return total;
  }

  class BookingError extends Error {
    constructor(message, conflict = false) { super(message); this.conflict = conflict; }
  }

  // ---------- adatréteg: Supabase ----------
  const supabaseApi = {
    async rpc(fn, body) {
      const headers = { 'Content-Type': 'application/json', apikey: cfg.supabaseKey };
      if (cfg.supabaseKey.startsWith('eyJ')) headers.Authorization = `Bearer ${cfg.supabaseKey}`;
      let res;
      try {
        res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
      } catch {
        throw new BookingError('Nem sikerült elérni a foglalási rendszert. Ellenőrizd az internetkapcsolatot.');
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new BookingError((data && data.message) || 'Hiba történt, kérjük, próbáld újra.', res.status === 409);
      }
      return data;
    },
    async busy(date) {
      const rows = await this.rpc('get_busy_slots', { p_date: date });
      return rows.map((r) => ({ court: r.court, start: parseTime(r.start_time), end: parseTime(r.end_time) }));
    },
    async create(b) {
      await this.rpc('create_booking', {
        p_court: b.court, p_date: b.date, p_start: fmt(b.start) + ':00',
        p_minutes: b.minutes, p_name: b.name, p_phone: b.phone,
      });
    },
  };

  // ---------- adatréteg: demó (minta foglaltság + localStorage) ----------
  const DEMO_KEY = 'playpadel-demo-bookings';
  const demoApi = {
    load() { try { return JSON.parse(localStorage.getItem(DEMO_KEY)) || []; } catch { return []; } },
    save(list) { try { localStorage.setItem(DEMO_KEY, JSON.stringify(list)); } catch { /* privát mód */ } },
    // Dátumonként mindig ugyanaz a "kitalált" foglaltság, hogy élethű legyen a naptár
    seeded(date) {
      let h = 2166136261;
      for (const ch of date) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
      const rnd = () => (h = (Math.imul(h, 1103515245) + 12345) >>> 0) / 4294967296;
      const busyRate = isWeekend(date) ? 0.65 : 0.5;
      const out = [];
      for (const c of COURTS) {
        let t = openFor(date) + Math.floor(rnd() * 3) * SLOT;
        while (t + 60 <= CLOSE) {
          const len = [60, 90, 120][Math.floor(rnd() * 3)];
          if (t + len > CLOSE) break;
          const evening = t >= 17 * 60 ? 0.25 : 0;
          if (rnd() < busyRate + evening) out.push({ court: c.id, start: t, end: t + len });
          t += len + Math.floor(rnd() * 3) * SLOT;
        }
      }
      return out;
    },
    async busy(date) {
      await delay(200);
      const own = this.load().filter((b) => b.date === date);
      return [...this.seeded(date), ...own];
    },
    async create(b) {
      await delay(300);
      const busy = await this.busy(b.date);
      if (overlaps(busy, b.court, b.start, b.start + b.minutes)) {
        throw new BookingError('Ez az időpont időközben már foglalt lett.', true);
      }
      const list = this.load();
      list.push({ date: b.date, court: b.court, start: b.start, end: b.start + b.minutes });
      this.save(list);
    },
  };

  const api = LIVE ? supabaseApi : demoApi;

  // ---------- DOM ----------
  const strip = document.getElementById('date-strip');
  const grid = document.getElementById('slot-grid');
  const form = document.getElementById('booking');
  const summary = document.getElementById('summary');
  const submitBtn = document.getElementById('submit-btn');
  const msg = document.getElementById('form-msg');
  const badge = document.getElementById('mode-badge');
  if (!strip || !grid || !form) return;

  if (!LIVE) {
    badge.hidden = false;
    badge.textContent = 'Demó mód: a foglaltság minta adat, az új foglalások csak ebben a böngészőben tárolódnak.';
  }

  const state = {
    date: toISO(new Date()),
    busy: [],
    court: null,
    start: null,
    minutes: 90,
    loading: false,
    focusCourt: null,
  };

  function setMsg(text, kind = '') {
    msg.textContent = text;
    msg.className = 'form-msg' + (kind ? ' ' + kind : '');
  }

  // ---------- dátumsáv ----------
  function renderStrip() {
    strip.innerHTML = '';
    const today = new Date();
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const iso = toISO(d);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'day' + (iso === state.date ? ' active' : '') + (isWeekend(iso) ? ' weekend' : '');
      btn.setAttribute('aria-pressed', String(iso === state.date));
      const wd = i === 0 ? 'Ma' : i === 1 ? 'Holnap' : d.toLocaleDateString('hu-HU', { weekday: 'short' });
      btn.innerHTML = `<span class="day-name">${wd}</span><span class="day-num">${d.getDate()}</span><span class="day-month">${d.toLocaleDateString('hu-HU', { month: 'short' })}</span>`;
      btn.addEventListener('click', () => selectDate(iso));
      strip.appendChild(btn);
    }
  }

  async function selectDate(iso) {
    state.date = iso;
    clearSelection();
    renderStrip();
    await loadBusy();
  }

  async function loadBusy() {
    state.loading = true;
    grid.classList.add('loading');
    try {
      state.busy = await api.busy(state.date);
    } catch (e) {
      state.busy = [];
      setMsg(e.message, 'err');
    } finally {
      state.loading = false;
      grid.classList.remove('loading');
      renderGrid();
    }
  }

  // ---------- idősáv-rács ----------
  function nowMinutes() {
    const now = new Date();
    return toISO(now) === state.date ? now.getHours() * 60 + now.getMinutes() : -1;
  }

  function renderGrid() {
    const open = openFor(state.date);
    const nowMin = nowMinutes();
    const frag = document.createDocumentFragment();

    const corner = document.createElement('div');
    corner.className = 'cell head corner';
    frag.appendChild(corner);
    for (const c of COURTS) {
      const h = document.createElement('div');
      h.className = `cell head court-${c.id}` + (state.focusCourt === c.id ? ' focus' : '');
      h.innerHTML = `<i></i>${c.label}`;
      frag.appendChild(h);
    }

    for (let t = open; t < CLOSE; t += SLOT) {
      const label = document.createElement('div');
      label.className = 'cell time' + (t % 60 === 0 ? ' full-hour' : '');
      label.textContent = fmt(t);
      frag.appendChild(label);

      for (const c of COURTS) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `cell slot court-${c.id}` + (t % 60 === 0 ? ' full-hour' : '');
        const booking = state.busy.find((b) => b.court === c.id && b.start <= t && t < b.end);
        const selected = state.court === c.id && state.start !== null && t >= state.start && t < state.start + state.minutes;

        if (booking) {
          cell.classList.add('busy');
          cell.disabled = true;
          if (booking.start === t || t === open) cell.textContent = 'Foglalt';
          cell.setAttribute('aria-label', `${c.label} pálya, ${fmt(t)}: foglalt`);
        } else if (t <= nowMin) {
          cell.classList.add('past');
          cell.disabled = true;
          cell.setAttribute('aria-label', `${c.label} pálya, ${fmt(t)}: elmúlt`);
        } else {
          cell.classList.add('free');
          cell.setAttribute('aria-label', `${c.label} pálya, ${fmt(t)}: szabad`);
          cell.addEventListener('click', () => pickSlot(c.id, t));
        }
        if (selected) {
          cell.classList.add('sel');
          if (t === state.start) cell.textContent = `${fmt(state.start)}–${fmt(state.start + state.minutes)}`;
        }
        frag.appendChild(cell);
      }
    }
    grid.replaceChildren(frag);
  }

  function slotProblem(court, start, minutes) {
    if (start + minutes > CLOSE) return `Innen már nincs ${minutes / 60 === 1 ? '1' : String(minutes / 60).replace('.', ',')} óra zárásig (22:00).`;
    if (overlaps(state.busy, court, start, start + minutes)) return 'Ehhez az időtartamhoz nincs elég szabad idő – válassz rövidebb időtartamot vagy másik kezdést.';
    return '';
  }

  function pickSlot(court, start) {
    const problem = slotProblem(court, start, state.minutes);
    if (problem) {
      setMsg(problem, 'err');
      return;
    }
    state.court = court;
    state.start = start;
    setMsg('');
    renderGrid();
    updateSummary();
  }

  function clearSelection() {
    state.court = null;
    state.start = null;
    updateSummary();
  }

  function updateSummary() {
    if (state.court === null) {
      summary.innerHTML = '<span class="muted-light">Válassz egy szabad időpontot a naptárban.</span>';
      submitBtn.disabled = true;
      return;
    }
    const d = dateOf(state.date).toLocaleDateString('hu-HU', { month: 'long', day: 'numeric', weekday: 'long' });
    summary.innerHTML = `
      <div class="sum-court court-${state.court}"><i></i>${courtLabel(state.court)} pálya</div>
      <div class="sum-when">${d}<br><strong>${fmt(state.start)} – ${fmt(state.start + state.minutes)}</strong></div>
      <div class="sum-price">Várható ár: <strong>${huf(priceFor(state.date, state.start, state.minutes))}</strong></div>`;
    submitBtn.disabled = false;
  }

  // ---------- időtartam ----------
  form.querySelectorAll('input[name="duration"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.minutes = Number(r.value);
      if (state.court !== null) {
        const problem = slotProblem(state.court, state.start, state.minutes);
        if (problem) {
          clearSelection();
          setMsg(problem + ' A kijelölést töröltük.', 'err');
        } else {
          setMsg('');
        }
      }
      renderGrid();
      updateSummary();
    });
  });

  // ---------- "Ezt foglalom" linkek a pályakártyákon ----------
  document.querySelectorAll('[data-court]').forEach((link) => {
    link.addEventListener('click', () => {
      state.focusCourt = link.dataset.court;
      renderGrid();
      setTimeout(() => { state.focusCourt = null; renderGrid(); }, 2500);
    });
  });

  // ---------- beküldés ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.court === null) return;

    const nameEl = form.elements.name;
    const phoneEl = form.elements.phone;
    const name = nameEl.value.trim();
    const phone = phoneEl.value.trim();
    const nameOk = name.length >= 2;
    const phoneOk = /^\+?[0-9 ()/-]{7,20}$/.test(phone);
    nameEl.classList.toggle('invalid', !nameOk);
    phoneEl.classList.toggle('invalid', !phoneOk);
    if (!nameOk || !phoneOk) {
      setMsg(!nameOk ? 'Kérjük, add meg a neved.' : 'Kérjük, adj meg érvényes telefonszámot.', 'err');
      return;
    }

    const booking = { court: state.court, date: state.date, start: state.start, minutes: state.minutes, name, phone };
    submitBtn.disabled = true;
    submitBtn.textContent = 'Küldés…';
    try {
      await api.create(booking);
      const d = dateOf(booking.date).toLocaleDateString('hu-HU', { month: 'long', day: 'numeric' });
      setMsg(`Köszönjük, ${name}! Lefoglaltuk: ${courtLabel(booking.court)} pálya, ${d}, ${fmt(booking.start)}–${fmt(booking.start + booking.minutes)}.`
        + (LIVE ? '' : ' (Demó mód – csak ebben a böngészőben látszik.)'), 'ok');
      nameEl.value = '';
      phoneEl.value = '';
      clearSelection();
      await loadBusy();
    } catch (err) {
      setMsg(err.message, 'err');
      if (err.conflict) { clearSelection(); await loadBusy(); }
    } finally {
      submitBtn.textContent = 'Foglalás elküldése';
      updateSummary();
    }
  });

  // Ha a látogató visszatér a fülre, frissítjük a foglaltságot
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.loading) loadBusy();
  });

  renderStrip();
  updateSummary();
  loadBusy();
})();
