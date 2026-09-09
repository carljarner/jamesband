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

const COLLAPSE_LIMIT = 30;
const singleColumnQuery = window.matchMedia('(max-width: 640px)');

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

    const songItems = Array.from(repertoireList.querySelectorAll('li'));
    let expanded = false;

    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'repertoire__more';
    moreBtn.textContent = 'Vis alle';
    repertoireList.insertAdjacentElement('afterend', moreBtn);

    const lessBtn = document.createElement('button');
    lessBtn.type = 'button';
    lessBtn.className = 'repertoire__more';
    lessBtn.textContent = 'Vis færre';
    moreBtn.insertAdjacentElement('afterend', lessBtn);

    const updateVisibility = () => {
      const query = search?.value.trim().toLowerCase() ?? '';
      const searching = query.length > 0;
      const canCollapse = !searching && singleColumnQuery.matches && songItems.length > COLLAPSE_LIMIT;
      const shouldCollapse = canCollapse && !expanded;

      songItems.forEach((item, i) => {
        item.hidden = searching
          ? !item.textContent.toLowerCase().includes(query)
          : shouldCollapse && i >= COLLAPSE_LIMIT;
      });

      moreBtn.hidden = !shouldCollapse;
      lessBtn.hidden = !(canCollapse && expanded);
    };

    moreBtn.addEventListener('click', () => {
      expanded = true;
      updateVisibility();
    });

    lessBtn.addEventListener('click', () => {
      expanded = false;
      updateVisibility();
    });

    search?.addEventListener('input', updateVisibility);
    singleColumnQuery.addEventListener('change', updateVisibility);

    updateVisibility();
  });
