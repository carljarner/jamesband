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
      .map((s) => `<li>${s.title} – ${s.artist}</li>`)
      .join('');

    const songItems = repertoireList.querySelectorAll('li');
    search?.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      songItems.forEach((item) => {
        item.hidden = !item.textContent.toLowerCase().includes(query);
      });
    });
  });

// ---------- Gallery: fetch + lightbox ----------
const galleryGrid = document.getElementById('galleri-grid');
const lightbox = document.querySelector('.lightbox');
const lightboxImg = lightbox?.querySelector('img');

function openLightbox(src, alt) {
  lightboxImg.src = src;
  lightboxImg.alt = alt;
  lightbox.hidden = false;
}

fetch('gallery/gallery.json')
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => [])
  .then((items) => {
    if (!galleryGrid || !Array.isArray(items)) return;
    items.forEach((item) => {
      const src = `gallery/${item.filename}`;
      if (item.kind === 'video') {
        const video = document.createElement('video');
        video.src = src;
        video.controls = true;
        video.muted = true;
        galleryGrid.appendChild(video);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'James Band billede';
        img.loading = 'lazy';
        btn.appendChild(img);
        btn.addEventListener('click', () => openLightbox(src, img.alt));
        galleryGrid.appendChild(btn);
      }
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
