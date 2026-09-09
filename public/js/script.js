'use strict';

// ---------- Nav background on scroll ----------
const nav = document.querySelector('.nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 40);
});

// ---------- Mobile menu toggle ----------
const navToggle = document.querySelector('.nav__toggle');
navToggle.addEventListener('click', () => nav.classList.toggle('menu-open'));
document.querySelectorAll('.nav__links a').forEach((link) =>
  link.addEventListener('click', () => nav.classList.remove('menu-open'))
);

// ---------- Active nav link via scroll position ----------
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav__links a');

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      navLinks.forEach((link) => {
        link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`);
      });
    });
  },
  { rootMargin: '-45% 0px -45% 0px' }
);

sections.forEach((section) => observer.observe(section));

// ---------- Repertoire: fetch + search ----------
const repertoireList = document.getElementById('repertoire-list');
const search = document.querySelector('.repertoire__search');

fetch('repertoire.json')
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => [])
  .then((songs) => {
    if (!repertoireList || !Array.isArray(songs)) return;
    repertoireList.innerHTML = songs
      .map((s) => {
        const art = s.cover
          ? `<img class="repertoire__art" src="${s.cover}" alt="" loading="lazy" />`
          : `<span class="repertoire__art repertoire__art--placeholder">&#9834;</span>`;
        return `<li>${art}<span class="repertoire__text"><span class="repertoire__title">${s.title}</span><span class="repertoire__artist">${s.artist}</span></span></li>`;
      })
      .join('');

    const songItems = repertoireList.querySelectorAll('li');
    search?.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      songItems.forEach((item) => {
        item.hidden = !item.textContent.toLowerCase().includes(query);
      });
    });
  });
