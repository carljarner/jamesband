/* Draws lyrics (the blocks lyrics.py stores) as the A4 page the editor
 * shows: used by the editor itself (static/lyrics-editor.js) and, read
 * only, by the gig's live mode.
 *
 *   blocks: [{type: 'section' | 'line', runs: [{text, hl: 'blue' | 'red' | null}]}]
 */
(function () {
  const HL_COLORS = { blue: 'rgb(201, 226, 255)', red: 'rgb(255, 205, 205)' };

  // One block as the editor holds it: sections are <h3>, lines <div>,
  // highlights spans with a background colour.
  function blockElement(block) {
    const el = document.createElement(block.type === 'section' ? 'h3' : 'div');
    for (const run of block.runs) {
      if (run.hl && HL_COLORS[run.hl]) {
        const span = document.createElement('span');
        span.style.backgroundColor = HL_COLORS[run.hl];
        span.textContent = run.text;
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(run.text));
      }
    }
    if (!block.runs.length) el.appendChild(document.createElement('br'));
    return el;
  }

  function div(className, text) {
    const el = document.createElement('div');
    el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  // A read-only page: the same header and two-column body as the editor's.
  function sheet(doc) {
    const article = document.createElement('article');
    article.className = 'lyrics-sheet';
    const head = document.createElement('header');
    head.className = 'lyrics-head';
    const center = div('lyrics-head__center');
    center.append(div('lyrics-field lyrics-title', doc.title || ''), div('lyrics-field lyrics-artist', doc.artist || ''));
    const key = div('lyrics-key' + (doc.key ? '' : ' is-empty'), doc.key ? `Key: ${doc.key}` : '');
    head.append(center, key);
    const body = div('lyrics-body');
    for (const block of doc.blocks || []) body.appendChild(blockElement(block));
    article.append(head, body);
    return article;
  }

  // A page shows exactly what one printed A4 page holds, the left column
  // filling first. Lyrics too long for that grow the page instead, in
  // balanced columns ("is-long"). The sheet must be in the document.
  // Returns whether it's long.
  function fit(sheetEl) {
    const body = sheetEl.querySelector('.lyrics-body');
    sheetEl.classList.remove('is-long');
    const over = body.scrollWidth > body.clientWidth + 2;
    sheetEl.classList.toggle('is-long', over);
    return over;
  }

  window.LyricsRender = { HL_COLORS, blockElement, sheet, fit };
})();
