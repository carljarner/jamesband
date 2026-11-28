/* The lyrics editor: an A4 page in two columns, written like the band's old
 * Google Doc. Only a few things are possible on purpose: plain lines,
 * section headings ("Vers 1", "Omkvæd", ... typed, not picked) and a blue
 * or red highlight. The text is a native contenteditable, so undo/redo and
 * the usual keys just work: sections are <h3>, lines <div>, highlights
 * spans with a background colour.
 *
 * What's saved is never HTML but blocks (see lyrics.py):
 *   [{type: 'section' | 'line', runs: [{text, hl: 'blue' | 'red' | null}]}]
 * read back from the page by serialize() and drawn by renderBlocks().
 */
(function () {
  const HL_COLORS = { blue: 'rgb(201, 226, 255)', red: 'rgb(255, 205, 205)' };
  const SAVE_DELAY = 800;
  const RETRY_DELAY = 5000;
  const BLOCK_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
  const SECTION_RE = /^\s*\[(.+?)\]\s*$/;

  const doc = initialDoc;
  const sheet = document.getElementById('lyrics-sheet');
  const body = document.getElementById('lyrics-body');
  const titleEl = document.getElementById('lyrics-title');
  const artistEl = document.getElementById('lyrics-artist');
  const keyLabel = document.getElementById('lyrics-key');
  const statusEl = document.getElementById('lyrics-status');
  const longNote = document.getElementById('lyrics-long-note');
  const songSelect = document.getElementById('lyrics-song');
  const songHint = document.getElementById('lyrics-song-hint');
  const deleteBtn = document.getElementById('lyrics-delete');
  const deleteModal = document.getElementById('delete-modal');
  const deleteForm = document.getElementById('delete-form');

  const keySelect = Keys.makeKeySelect(doc.key || '');
  keySelect.classList.add('lyrics-key-select');
  keySelect.options[0].textContent = '–';
  document.getElementById('lyrics-key-slot').appendChild(keySelect);

  /* ---------- Colours ---------- */

  // A CSS colour as 'blue', 'red' or null (none, white, grey, or a colour
  // that's neither -- e.g. a yellow highlight pasted from elsewhere).
  function classifyColor(css) {
    if (!css) return null;
    // The canvas turns any CSS colour into #rrggbb or rgba(); anything it
    // can't read leaves the black set first, which counts as no colour.
    const ctx = classifyColor.ctx || (classifyColor.ctx = document.createElement('canvas').getContext('2d'));
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    let r, g, b, a = 1;
    const hex = ctx.fillStyle;
    let m;
    if ((m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex))) {
      [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16));
    } else if ((m = /rgba?\(([^)]+)\)/.exec(hex))) {
      [r, g, b, a = 1] = m[1].split(',').map(Number);
    } else return null;
    if (a < 0.1) return null;
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    const light = (max + min) / 2;
    const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
    if (sat < 0.15 || light > 0.97 || light < 0.1) return null;
    let hue;
    const R = r / 255, G = g / 255, B = b / 255, d = max - min;
    if (max === R) hue = 60 * (((G - B) / d) % 6);
    else if (max === G) hue = 60 * ((B - R) / d + 2);
    else hue = 60 * ((R - G) / d + 4);
    if (hue < 0) hue += 360;
    if (hue >= 150 && hue <= 290) return 'blue';
    if (hue <= 40 || hue >= 300) return 'red';
    return null;
  }

  // The highlight an element itself sets: 'blue', 'red', null for "none
  // here" (an explicit transparent/other background), undefined to inherit.
  function ownHighlight(el) {
    const bg = el.style && (el.style.backgroundColor || el.style.background);
    if (bg) return classifyColor(bg);
    if (el.tagName === 'MARK') return classifyColor(el.getAttribute('data-hl') || '') || 'blue';
    return undefined;
  }

  /* ---------- Blocks <-> page ---------- */

  // Reads the blocks out of a container (the editor, or pasted HTML).
  function serialize(root) {
    const blocks = [];
    let cur = null;
    function start(type) {
      // A block that opened and got nothing yet (say, a <div> wrapping
      // other blocks) is taken over rather than left as a blank line.
      if (cur && !cur.closed && !cur.runs.length) { cur.type = type; return; }
      cur = { type, runs: [] };
      blocks.push(cur);
    }
    function addText(text, hl, type) {
      text = text.replace(/[\r\n\t]+/g, ' ').replace(/\u00a0/g, ' ');
      if (!text) return;
      if (!cur || cur.closed) start(type);
      const last = cur.runs[cur.runs.length - 1];
      if (last && last.hl === hl) last.text += text;
      else cur.runs.push({ text, hl });
    }
    function walk(node, hl, type) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          addText(child.data, hl, type);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName;
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TITLE' || tag === 'META') continue;
        if (tag === 'BR') {
          // A <br> ends the line; one at the end of a block is only there to
          // keep an empty line open, which the block's own end does too.
          if (!cur || cur.closed) start(type);
          cur.closed = true;
          continue;
        }
        const own = ownHighlight(child);
        const childHl = own === undefined ? hl : own;
        if (BLOCK_TAGS.has(tag)) {
          const childType = /^H[1-6]$/.test(tag) ? 'section' : type;
          if (tag !== 'UL' && tag !== 'OL' && tag !== 'TABLE' && tag !== 'TR') start(childType);
          walk(child, childHl, childType);
          if (cur) cur.closed = true;
        } else {
          walk(child, childHl, type);
        }
      }
    }
    walk(root, null, 'line');
    const clean = blocks.map(b => ({ type: b.type, runs: b.runs }));
    while (clean.length && !clean[clean.length - 1].runs.some(r => r.text.trim())) clean.pop();
    return clean;
  }

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

  function renderBlocks(blocks) {
    body.textContent = '';
    for (const block of blocks) body.appendChild(blockElement(block));
    if (!body.firstChild) body.appendChild(blockElement({ type: 'line', runs: [] }));
  }

  // The same blocks as HTML, for execCommand('insertHTML') when pasting.
  function blocksHtml(blocks) {
    const holder = document.createElement('div');
    if (blocks.length === 1 && blocks[0].type === 'line') {
      // A single line goes into the current line rather than a new one.
      holder.append(...blockElement(blocks[0]).childNodes);
    } else {
      blocks.forEach(b => holder.appendChild(blockElement(b)));
    }
    return holder.innerHTML;
  }

  // Lines written as "[Omkvæd]" become sections, without the brackets.
  function bracketsToSections(blocks) {
    return blocks.map(block => {
      const text = block.runs.map(r => r.text).join('');
      const m = block.type === 'line' && SECTION_RE.exec(text);
      return m ? { type: 'section', runs: [{ text: m[1].trim(), hl: block.runs[0].hl }] } : block;
    });
  }

  /* ---------- Selection helpers ---------- */

  function selectionInBody() {
    const sel = getSelection();
    return sel.rangeCount && body.contains(sel.anchorNode) ? sel : null;
  }

  // The editor's top-level block holding the caret.
  function currentBlock() {
    const sel = selectionInBody();
    if (!sel) return null;
    let node = sel.anchorNode;
    while (node && node.parentNode !== body) node = node.parentNode;
    return node && node.nodeType === Node.ELEMENT_NODE ? node : null;
  }

  function caretToEnd(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function textNodesInSelection(range) {
    const nodes = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.data.trim() && range.intersectsNode(n)) nodes.push(n);
    }
    return nodes;
  }

  function highlightOf(node) {
    for (let el = node.parentElement; el && el !== body; el = el.parentElement) {
      const own = ownHighlight(el);
      if (own !== undefined) return own;
    }
    return null;
  }

  /* ---------- Formatting ---------- */

  function setBlockType(type) {
    if (!selectionInBody()) body.focus();
    document.execCommand('formatBlock', false, type === 'section' ? '<h3>' : '<div>');
    changed();
  }

  // Blue or red on the selection; the same colour again (all of it already
  // that colour) or no colour removes it.
  function highlight(color) {
    const sel = selectionInBody();
    if (!sel || sel.isCollapsed) return;
    const nodes = textNodesInSelection(sel.getRangeAt(0));
    const already = color && nodes.length && nodes.every(n => highlightOf(n) === color);
    const value = !color || already ? 'transparent' : HL_COLORS[color];
    document.execCommand('styleWithCSS', false, true);
    if (!document.execCommand('hiliteColor', false, value)) document.execCommand('backColor', false, value);
    changed();
  }

  document.querySelectorAll('.lyrics-tool[data-block], .lyrics-tool[data-hl]').forEach(btn => {
    // Keep the text selection when a toolbar button is pressed.
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => {
      if (btn.dataset.block) setBlockType(btn.dataset.block);
      else highlight(btn.dataset.hl || null);
    });
  });

  const blockButtons = [...document.querySelectorAll('.lyrics-tool[data-block]')];
  function syncToolbar() {
    const block = currentBlock();
    const type = block && /^H[1-6]$/.test(block.tagName) ? 'section' : 'line';
    blockButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.block === type)));
  }
  document.addEventListener('selectionchange', syncToolbar);

  body.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    // Few features on purpose: no bold, italic or underline.
    if (mod && !e.altKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    // Like Google Docs: ⌘⌥1 / Ctrl+Alt+1 heading, ⌘⌥0 / Ctrl+Alt+0 text.
    if (mod && e.altKey && (e.code === 'Digit1' || e.code === 'Digit0')) {
      e.preventDefault();
      setBlockType(e.code === 'Digit1' ? 'section' : 'line');
      return;
    }
    // "[Omkvæd]" + Enter at the end of a line makes it a section.
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      const block = currentBlock();
      const sel = selectionInBody();
      if (!block || !sel || !sel.isCollapsed || /^H[1-6]$/.test(block.tagName)) return;
      const m = SECTION_RE.exec(block.textContent);
      if (!m) return;
      const after = document.createRange();
      after.setStart(sel.anchorNode, sel.anchorOffset);
      after.setEnd(block, block.childNodes.length);
      if (after.toString().trim()) return;
      e.preventDefault();
      block.textContent = m[1].trim();
      caretToEnd(block);
      document.execCommand('formatBlock', false, '<h3>');
      const heading = currentBlock();
      if (heading) caretToEnd(heading);
      document.execCommand('insertParagraph');
      // Some browsers carry the heading over to the new line.
      const next = currentBlock();
      if (next && /^H[1-6]$/.test(next.tagName)) document.execCommand('formatBlock', false, '<div>');
      changed();
    }
  });

  // Paste keeps only text, sections and highlights.
  body.addEventListener('paste', e => {
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const html = data.getData('text/html');
    let blocks;
    if (html) {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      blocks = serialize(parsed.body);
    } else {
      blocks = data.getData('text/plain').split(/\r\n|\r|\n/).map(line => ({
        type: 'line', runs: line ? [{ text: line, hl: null }] : [],
      }));
      while (blocks.length && !blocks[blocks.length - 1].runs.length) blocks.pop();
    }
    if (!blocks.length) return;
    document.execCommand('insertHTML', false, blocksHtml(bracketsToSections(blocks)));
    flattenBlocks();
    changed();
  });

  // Keeps every line and section a direct child of the editor: pasting can
  // leave blocks nested in the line they went into, and loose text at the
  // top level gets a line of its own. The caret stays where it was.
  function flattenBlocks() {
    const sel = selectionInBody();
    const caret = sel && sel.isCollapsed ? [sel.anchorNode, sel.anchorOffset] : null;
    let moved = true;
    while (moved) {
      moved = false;
      let looseLine = null;
      for (const child of [...body.childNodes]) {
        const isBlock = child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(child.tagName);
        if (!isBlock) {
          // Loose text or inline elements next to each other share a line.
          const joins = looseLine && child.previousSibling === looseLine;
          if (child.nodeType !== Node.ELEMENT_NODE && !child.data.trim() && !joins) continue;
          if (!joins) {
            looseLine = document.createElement('div');
            body.insertBefore(looseLine, child);
          }
          looseLine.appendChild(child);
          moved = true;
          continue;
        }
        if (![...child.children].some(c => BLOCK_TAGS.has(c.tagName))) continue;
        // A block holding blocks: lift them out, with any text between
        // them in lines of their own.
        const outerTag = /^H[1-6]$/.test(child.tagName) ? 'h3' : 'div';
        let pending = null;
        for (const node of [...child.childNodes]) {
          if (node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(node.tagName)) {
            body.insertBefore(node, child);
            pending = null;
          } else if (node.nodeType === Node.ELEMENT_NODE || node.data.trim() || pending) {
            if (!pending) {
              pending = document.createElement(outerTag);
              body.insertBefore(pending, child);
            }
            pending.appendChild(node);
          }
        }
        child.remove();
        moved = true;
      }
    }
    if (caret && body.contains(caret[0])) {
      const range = document.createRange();
      range.setStart(caret[0], Math.min(caret[1], caret[0].length ?? caret[0].childNodes.length));
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  }

  // Text dropped in from elsewhere comes in as plain text.
  body.addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('text/html')) return;
    const text = e.dataTransfer.getData('text/plain');
    e.preventDefault();
    if (text) document.execCommand('insertText', false, text);
  });

  body.addEventListener('input', () => {
    // Deleting everything can leave the editor without a line to type in.
    if (!body.firstElementChild) {
      renderBlocks([]);
      caretToEnd(body.firstChild);
    }
    changed();
  });

  /* ---------- Title, artist, key ---------- */

  function fieldText(el) { return el.textContent.replace(/\s+/g, ' ').trim(); }

  function singleLineField(el, next) {
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      next();
    });
    el.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData.getData('text/plain') || '').replace(/\s+/g, ' ');
      document.execCommand('insertText', false, text);
    });
    el.addEventListener('input', () => {
      // An emptied field may keep a stray <br>; drop it so the placeholder shows.
      if (!el.textContent) el.textContent = '';
      changed();
    });
  }
  singleLineField(titleEl, () => artistEl.focus());
  singleLineField(artistEl, () => { body.focus(); caretToEnd(body.firstElementChild || body); });
  keySelect.addEventListener('change', () => { syncKeyLabel(); changed(); });

  function syncKeyLabel() { keyLabel.classList.toggle('is-empty', !keySelect.value); }

  function updateTitle() {
    document.title = `${fieldText(titleEl) || 'New lyrics'} · Lyrics · James Band`;
  }

  /* ---------- One page or more ---------- */

  // The page shows exactly what one printed A4 page holds, the left column
  // filling first. Lyrics too long for that grow the page instead, in
  // balanced columns, and say they'll run onto a second printed page.
  let layoutFrame = 0;
  function layoutPages() {
    sheet.classList.remove('is-long');
    const over = body.scrollWidth > body.clientWidth + 2;
    sheet.classList.toggle('is-long', over);
    longNote.hidden = !over;
    body.classList.toggle('is-empty', !body.textContent.trim() && body.querySelectorAll('div, h3').length <= 1);
  }
  function queueLayout() {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(layoutPages);
  }
  addEventListener('resize', queueLayout);
  addEventListener('beforeprint', layoutPages);
  if (document.fonts) document.fonts.ready.then(queueLayout);

  /* ---------- Saving ---------- */

  let dirty = false;
  let saving = false;
  let saveTimer = null;

  function setStatus(text, error = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', error);
  }

  function changed() {
    dirty = true;
    updateTitle();
    queueLayout();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
    if (!saving) setStatus('');
  }

  function payload() {
    return {
      title: fieldText(titleEl),
      artist: fieldText(artistEl),
      key: keySelect.value,
      blocks: serialize(body),
    };
  }

  async function save() {
    clearTimeout(saveTimer);
    if (saving) { saveTimer = setTimeout(save, SAVE_DELAY); return; }
    if (!dirty) return;
    const data = payload();
    if (!data.title) { setStatus('Add a title to save', true); return; }
    saving = true;
    dirty = false;
    setStatus('Saving…');
    try {
      let resp;
      if (doc.id) {
        resp = await fetch(`/lyrics/${encodeURIComponent(doc.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
      } else {
        data.repertoire_id = doc.repertoire_id || null;
        data.new_song = doc.new_song || null;
        resp = await fetch('/lyrics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        });
      }
      if (!resp.ok) {
        const message = await resp.text();
        const error = new Error(message || 'Couldn’t save');
        error.permanent = resp.status === 400;
        throw error;
      }
      if (!doc.id) {
        const created = await resp.json();
        doc.id = created.id;
        history.replaceState(null, '', `/lyrics/${encodeURIComponent(doc.id)}`);
        deleteBtn.hidden = false;
        deleteForm.action = `/lyrics/${encodeURIComponent(doc.id)}/delete`;
        refreshSongChoices();
      }
      setStatus(dirty ? '' : 'Saved');
    } catch (err) {
      dirty = true;
      setStatus(err.permanent ? err.message : 'Couldn’t save – trying again…', true);
      if (!err.permanent) saveTimer = setTimeout(save, RETRY_DELAY);
    } finally {
      saving = false;
    }
  }

  addEventListener('beforeunload', e => {
    if (dirty || saving) {
      save();
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ---------- Song ---------- */

  const songsByValue = new Map();
  function refreshSongChoices() {
    songSelect.textContent = '';
    songsByValue.clear();
    songSelect.appendChild(new Option('— Not connected —', ''));
    const groups = [['New songs', songChoicesData.new_songs], ['Repertoire', songChoicesData.repertoire]];
    for (const [label, songs] of groups) {
      if (!songs.length) continue;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const song of songs) {
        const value = label === 'Repertoire' ? `rep:${song.id}` : `new:${song.title}`;
        const taken = song.sheet_id && song.sheet_id !== doc.id;
        const text = song.artist ? `${song.title} – ${song.artist}` : song.title;
        const option = new Option(taken ? `${text} (has lyrics)` : text, value);
        option.disabled = Boolean(taken);
        group.appendChild(option);
        songsByValue.set(value, song);
      }
      songSelect.appendChild(group);
    }
    songSelect.value = currentSongValue();
    songHint.hidden = Boolean(songSelect.value);
  }

  function currentSongValue() {
    if (doc.repertoire_id) return `rep:${doc.repertoire_id}`;
    if (doc.new_song) {
      const match = songChoicesData.new_songs.find(s => s.title.trim().toLowerCase() === doc.new_song.trim().toLowerCase());
      return match ? `new:${match.title}` : '';
    }
    return '';
  }

  songSelect.addEventListener('change', async () => {
    const value = songSelect.value;
    const song = songsByValue.get(value);
    const link = !value ? {} : value.startsWith('rep:') ? { repertoire_id: value.slice(4) } : { new_song: value.slice(4) };
    if (doc.id) {
      const resp = await fetch(`/lyrics/${encodeURIComponent(doc.id)}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(link),
      });
      if (!resp.ok) {
        setStatus(await resp.text() || 'Couldn’t connect the song', true);
        songSelect.value = currentSongValue();
        return;
      }
    }
    doc.repertoire_id = link.repertoire_id || null;
    doc.new_song = link.new_song || null;
    // Mark the song as taken by these lyrics (and free the one before).
    for (const s of [...songChoicesData.new_songs, ...songChoicesData.repertoire]) {
      if (s.sheet_id === doc.id && doc.id) s.sheet_id = null;
    }
    if (song && doc.id) song.sheet_id = doc.id;
    songHint.hidden = Boolean(value);
    // An empty title, artist or key is filled in from the song.
    let filled = false;
    if (song && !fieldText(titleEl)) { titleEl.textContent = song.title; filled = true; }
    if (song && !fieldText(artistEl) && song.artist) { artistEl.textContent = song.artist; filled = true; }
    if (song && !keySelect.value && song.key && Keys.KEYS.includes(song.key)) {
      keySelect.value = song.key; syncKeyLabel(); filled = true;
    }
    if (filled || !doc.id) changed();
  });

  /* ---------- Print and delete ---------- */

  document.getElementById('lyrics-print').addEventListener('click', () => {
    layoutPages();
    print();
  });

  deleteBtn.addEventListener('click', () => { deleteModal.hidden = false; });
  document.getElementById('delete-cancel').addEventListener('click', () => { deleteModal.hidden = true; });
  deleteModal.addEventListener('click', e => { if (e.target === deleteModal) deleteModal.hidden = true; });
  deleteForm.addEventListener('submit', () => { dirty = false; clearTimeout(saveTimer); });

  /* ---------- Start ---------- */

  document.execCommand('defaultParagraphSeparator', false, 'div');
  titleEl.textContent = doc.title || '';
  artistEl.textContent = doc.artist || '';
  syncKeyLabel();
  renderBlocks(doc.blocks || []);
  refreshSongChoices();
  if (doc.id) {
    deleteBtn.hidden = false;
    deleteForm.action = `/lyrics/${encodeURIComponent(doc.id)}/delete`;
  }
  updateTitle();
  layoutPages();
  if (!doc.title) titleEl.focus();
})();
