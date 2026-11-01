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

// ---------- Galéria nagyítás ----------
const lightbox = document.getElementById('lightbox');
if (lightbox && typeof lightbox.showModal === 'function') {
  const lbImg = lightbox.querySelector('img');
  document.querySelectorAll('.gallery [data-full]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const img = btn.querySelector('img');
      lbImg.src = btn.dataset.full;
      lbImg.alt = img.alt;
      lightbox.showModal();
    });
  });
  lightbox.querySelector('.lightbox-close').addEventListener('click', () => lightbox.close());
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
}

// ---------- Évszám ----------
document.getElementById('year').textContent = new Date().getFullYear();
