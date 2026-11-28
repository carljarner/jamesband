// The search box on the Lead Sheets and Lyrics pages: hides the cards
// (and sections, and gig subsections) that don't match every word typed.
(function () {
  const search = document.getElementById('library-search');
  if (!search) return;
  const sections = [...document.querySelectorAll('.leadsheet-section')];
  const empty = document.getElementById('library-search-empty');
  search.addEventListener('input', () => {
    const terms = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shownTotal = 0;
    for (const section of sections) {
      const cards = [...section.querySelectorAll('.leadsheet-card')];
      let shown = 0;
      for (const card of cards) {
        const match = terms.every(t => card.dataset.search.includes(t));
        card.hidden = !match;
        if (match) shown++;
      }
      shownTotal += shown;
      // While searching, a section (or gig subsection) with nothing matching is hidden.
      section.hidden = terms.length > 0 && shown === 0;
      for (const sub of section.querySelectorAll('.leadsheet-subsection')) {
        sub.hidden = terms.length > 0 && !sub.querySelector('.leadsheet-card:not([hidden])');
      }
    }
    if (empty) empty.hidden = !terms.length || shownTotal > 0;
  });
})();
