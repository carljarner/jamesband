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

// ---------- Repertoire search ----------
const search = document.querySelector('.repertoire__search');
const songItems = document.querySelectorAll('.repertoire__list li');

search?.addEventListener('input', () => {
  const query = search.value.trim().toLowerCase();
  songItems.forEach((item) => {
    item.hidden = !item.textContent.toLowerCase().includes(query);
  });
});

// ---------- Gallery lightbox ----------
const lightbox = document.querySelector('.lightbox');
const lightboxImg = lightbox?.querySelector('img');

document.querySelectorAll('.galleri__grid button').forEach((btn) => {
  btn.addEventListener('click', () => {
    lightboxImg.src = btn.querySelector('img').src;
    lightboxImg.alt = btn.querySelector('img').alt;
    lightbox.hidden = false;
  });
});

lightbox?.addEventListener('click', (e) => {
  if (e.target === lightbox || e.target.closest('.lightbox__close')) {
    lightbox.hidden = true;
    lightboxImg.src = '';
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightbox && !lightbox.hidden) {
    lightbox.hidden = true;
    lightboxImg.src = '';
  }
});
