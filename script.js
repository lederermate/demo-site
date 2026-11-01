// Téma váltás (világos / sötét), megjegyezve a böngészőben
const root = document.documentElement;
const toggle = document.getElementById('theme-toggle');

function applyTheme(theme) {
  root.dataset.theme = theme;
  toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

let saved = null;
try { saved = localStorage.getItem('theme'); } catch (e) {}
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
applyTheme(saved || (prefersDark ? 'dark' : 'light'));

toggle.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch (e) {}
});

// Számláló
let count = 0;
const countEl = document.getElementById('count');
document.getElementById('plus').addEventListener('click', () => { countEl.textContent = ++count; });
document.getElementById('minus').addEventListener('click', () => { countEl.textContent = --count; });

// Óra
const clock = document.getElementById('clock');
function tick() {
  clock.textContent = 'Pontos idő: ' + new Date().toLocaleTimeString('hu-HU');
}
tick();
setInterval(tick, 1000);

// Évszám a láblécben
document.getElementById('year').textContent = new Date().getFullYear();
