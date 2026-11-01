// =====================================================================
// Play Padel – AI asszisztens chat widget (bal alsó sarok)
// A válaszokat a Supabase "chatbot" Edge Function adja (Claude API).
// A beszélgetés csak ebben a böngészőfülben tárolódik (sessionStorage).
// =====================================================================
(() => {
  const cfg = window.PLAY_PADEL_CONFIG || {};
  if (!cfg.supabaseUrl) return; // demó módban (nincs háttér) nincs chat

  const ENDPOINT = cfg.chatUrl || `${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1/chatbot`;
  const STORE_KEY = 'playpadel-chat-v1';
  const MAX_CHARS = 1000;
  const COURT_LABELS = { piros: 'Piros', zold: 'Zöld', lila: 'Lila' };
  const SUGGESTIONS = [
    'Van szabad pálya szombat délután?',
    'Mik a padel alapszabályai?',
    'Hogyan juthatok el hozzátok?',
    'Mennyibe kerül egy óra?',
  ];

  // ---------- állapot ----------
  let state = { api: [], view: [], open: false };
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.api) && Array.isArray(saved.view)) state = { ...state, ...saved };
  } catch { /* nincs mentett állapot */ }
  const save = () => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* privát mód */ } };
  let busy = false;

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.className = 'chat-root';
  root.innerHTML = `
    <button type="button" class="chat-launcher" aria-expanded="false" aria-controls="chat-panel">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16H6.5"/><circle cx="8.5" cy="9.5" r="1.1"/><circle cx="12" cy="9.5" r="1.1"/><circle cx="15.5" cy="9.5" r="1.1"/></svg>
      <span>Kérdezz!</span>
    </button>
    <section class="chat-panel" id="chat-panel" role="dialog" aria-label="Play Padel asszisztens" hidden>
      <header class="chat-head">
        <div class="chat-avatar" aria-hidden="true">
          <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44"/><path d="M14 38c22 8 50 8 72 0M14 62c22-8 50-8 72 0"/></svg>
        </div>
        <div class="chat-title">
          <strong>Play Padel asszisztens</strong>
          <span>MI-alapú segítő · tesztüzem</span>
        </div>
        <button type="button" class="chat-icon-btn" data-action="reset" title="Új beszélgetés" aria-label="Új beszélgetés">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg>
        </button>
        <button type="button" class="chat-icon-btn" data-action="close" title="Bezárás" aria-label="Bezárás">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-chips"></div>
      <form class="chat-input">
        <textarea rows="1" maxlength="${MAX_CHARS}" placeholder="Írd ide a kérdésed…" aria-label="Üzenet"></textarea>
        <button type="submit" aria-label="Küldés">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>
        </button>
      </form>
      <p class="chat-foot">A válaszokat mesterséges intelligencia generálja, tévedhet. Ne írj be személyes adatot. <a href="adatvedelem.html#chat" target="_blank" rel="noopener">Adatkezelés</a></p>
    </section>`;
  document.body.appendChild(root);

  const launcher = root.querySelector('.chat-launcher');
  const panel = root.querySelector('.chat-panel');
  const log = root.querySelector('.chat-log');
  const chips = root.querySelector('.chat-chips');
  const form = root.querySelector('.chat-input');
  const input = form.querySelector('textarea');
  const sendBtn = form.querySelector('button');

  // ---------- megjelenítés ----------
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Egyszerű, biztonságos formázás: **félkövér**, "- " listák, sortörések
  function rich(text) {
    const lines = esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split('\n');
    let html = '';
    let inList = false;
    for (const line of lines) {
      const m = /^\s*[-•*]\s+(.*)$/.exec(line);
      if (m) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${m[1]}</li>`;
        continue;
      }
      if (inList) { html += '</ul>'; inList = false; }
      html += line.trim() === '' ? '<br>' : `<p>${line}</p>`;
    }
    if (inList) html += '</ul>';
    return html.replace(/(<br>)+$/, '');
  }

  function bubble(item) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${item.role}`;
    if (item.role === 'bot') el.innerHTML = rich(item.text);
    else el.textContent = item.text;
    if (item.role === 'note' && item.jump) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chat-jump';
      b.textContent = 'Ugrás az űrlapra';
      b.addEventListener('click', () => {
        if (window.matchMedia('(max-width: 560px)').matches) setOpen(false);
        document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => document.querySelector('#booking input[name="name"]')?.focus({ preventScroll: true }), 500);
      });
      el.appendChild(b);
    }
    return el;
  }

  function render() {
    log.replaceChildren(
      bubble({ role: 'bot', text: 'Szia! 👋 A Play Padel asszisztense vagyok.\nSegítek szabad pályát találni és kijelölni a foglaláshoz, és válaszolok a padel szabályairól, a nyitvatartásról, az árakról vagy arról, hogyan juthatsz el hozzánk.' }),
      ...state.view.map(bubble),
    );
    if (busy) {
      const t = document.createElement('div');
      t.className = 'chat-msg chat-bot chat-typing';
      t.setAttribute('aria-label', 'Az asszisztens ír');
      t.innerHTML = '<span></span><span></span><span></span>';
      log.appendChild(t);
    }
    chips.hidden = state.view.length > 0 || busy;
    log.scrollTop = log.scrollHeight;
    input.disabled = busy;
    sendBtn.disabled = busy;
  }

  chips.append(...SUGGESTIONS.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s;
    b.addEventListener('click', () => send(s));
    return b;
  }));

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-open', open);
    save();
    if (open) {
      render();
      setTimeout(() => input.focus(), 50);
    }
  }

  // ---------- küldés ----------
  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

    const apiBefore = state.api;
    state.view.push({ role: 'user', text });
    state.api = [...state.api, { role: 'user', content: text }];
    busy = true;
    input.value = '';
    autosize();
    render();

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: state.api }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(data.messages)) {
        throw new Error(data.error || 'Hiba történt, próbáld újra.');
      }
      state.api = data.messages;
      state.view.push({ role: 'bot', text: data.reply || '…' });
      for (const action of data.actions || []) await applyAction(action);
    } catch (e) {
      // Az előzményt visszaállítjuk, hogy az üzenet újraküldhető legyen
      state.api = apiBefore;
      state.view.push({ role: 'error', text: e instanceof TypeError ? 'Nem sikerült elérni az asszisztenst. Ellenőrizd az internetkapcsolatot.' : e.message });
      input.value = text;
      autosize();
    } finally {
      busy = false;
      save();
      render();
      if (state.open) input.focus();
    }
  }

  async function applyAction(a) {
    if (a.type !== 'prefill' || !window.PlayPadelBooking) return;
    const result = await window.PlayPadelBooking.prefill(a);
    if (result.ok) {
      const [h, m] = a.start.split(':').map(Number);
      const end = h * 60 + m + a.minutes;
      const day = new Date(a.date + 'T12:00').toLocaleDateString('hu-HU', { month: 'long', day: 'numeric', weekday: 'short' });
      state.view.push({
        role: 'note',
        jump: true,
        text: `📅 Kijelöltem a naptárban: ${COURT_LABELS[a.court]} pálya, ${day}, ${a.start}–${Math.floor(end / 60)}:${String(end % 60).padStart(2, '0')}. A foglaláshoz add meg az adataidat az űrlapon.`,
      });
    } else {
      state.view.push({ role: 'error', text: `Nem sikerült kijelölni az időpontot: ${result.message}` });
    }
  }

  // ---------- események ----------
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  launcher.addEventListener('click', () => setOpen(!state.open));
  root.querySelector('[data-action="close"]').addEventListener('click', () => { setOpen(false); launcher.focus(); });
  root.querySelector('[data-action="reset"]').addEventListener('click', () => {
    if (busy) return;
    state.api = [];
    state.view = [];
    save();
    render();
    input.focus();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setOpen(false); launcher.focus(); }
  });

  render();
  if (state.open) setOpen(true);
})();
