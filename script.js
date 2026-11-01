// ---------- Mobil menü ----------
const menuToggle = document.getElementById('menu-toggle');
const menu = document.getElementById('menu');

menuToggle.addEventListener('click', () => {
  const open = menu.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});

menu.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    menu.classList.remove('open');
    menuToggle.setAttribute('aria-expanded', 'false');
  });
});

// ---------- Foglalás ----------
const form = document.getElementById('booking');
const dateInput = document.getElementById('date');
const timeSelect = document.getElementById('time');
const msg = document.getElementById('form-msg');

function toISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Nyitvatartás: hétköznap 7–22, hétvégén 8–22
function fillTimes() {
  const value = dateInput.value;
  const day = value ? new Date(value + 'T12:00').getDay() : new Date().getDay();
  const weekend = day === 0 || day === 6;
  const start = weekend ? 8 : 7;
  const previous = timeSelect.value;

  timeSelect.innerHTML = '';
  for (let h = start; h <= 20; h++) {
    for (const m of [0, 30]) {
      const label = `${h}:${m === 0 ? '00' : '30'}`;
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = label;
      timeSelect.appendChild(opt);
    }
  }
  timeSelect.value = [...timeSelect.options].some((o) => o.value === previous) ? previous : '18:00';
  if (!timeSelect.value) timeSelect.selectedIndex = 0;
}

const today = new Date();
dateInput.min = toISODate(today);
dateInput.value = toISODate(today);
fillTimes();
dateInput.addEventListener('change', fillTimes);

// "Ezt foglalom" linkek előre kiválasztják a pályát
document.querySelectorAll('[data-court]').forEach((link) => {
  link.addEventListener('click', () => {
    const radio = form.querySelector(`input[name="court"][value="${link.dataset.court}"]`);
    if (radio) radio.checked = true;
  });
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  msg.className = 'form-msg';

  const required = [...form.querySelectorAll('[required]')];
  let valid = true;
  required.forEach((el) => {
    const ok = el.value.trim() !== '';
    el.classList.toggle('invalid', !ok);
    if (!ok) valid = false;
  });

  if (!valid) {
    msg.textContent = 'Kérjük, tölts ki minden mezőt.';
    msg.classList.add('err');
    return;
  }

  const data = new FormData(form);
  const date = new Date(data.get('date') + 'T12:00').toLocaleDateString('hu-HU', {
    month: 'long', day: 'numeric', weekday: 'long',
  });
  const hours = Number(data.get('duration')) / 60;

  msg.textContent = `Köszönjük, ${data.get('name')}! Foglalási kérés: ${data.get('court')} pálya, ${date}, ${data.get('time')}-tól ${String(hours).replace('.', ',')} órára. (Ez egy bemutató oldal – a kérés nem kerül elküldésre.)`;
  msg.classList.add('ok');
  form.querySelector('input[name="name"]').value = '';
  form.querySelector('input[name="phone"]').value = '';
});

// ---------- Évszám ----------
document.getElementById('year').textContent = new Date().getFullYear();
