/* Lead sheet builder: a fixed A4 page of freely-positioned elements (title
 * boxes, bar lines, chord/plain text, repeat marks, arrows, notation
 * glyphs), driven entirely by `model.elements`. Every change triggers a
 * full immediate-mode re-render of the SVG -- simple, and cheap at the
 * size of a lead sheet (a few dozen elements at most).
 */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAGE_W = 794, PAGE_H = 1123; // A4 portrait @ 96dpi
  const PAGE_MARGIN = 28;
  const BAR_UNIT = (PAGE_W - 2 * PAGE_MARGIN) / 9; // 9 bars exactly fill the page width (=82)
  const BAR_H = 30; // calibrated against a hand-finished 8-bar row on a real sheet
  const REPEAT_MARK_W = 14;

  // Codepoints verified directly against fonts/MuseJazz.otf's cmap (this
  // font implements SMuFL's Rests range at the standard codepoints, but not
  // the "Individual notes" range -- notes instead use its Metronome Marks
  // glyphs, which are the same complete notehead+stem+flag shapes).
  const NOTE_CODES = {
    whole: '\uECA2', half: '\uECA3', quarter: '\uECA5', '8th': '\uECA7', '16th': '\uECA9',
  };
  const AUG_DOT = '\uECB7';
  const SIMILE_MARK = '\uE500';
  const REST_CODES = {
    whole: '\uE4E3', half: '\uE4E4', quarter: '\uE4E5', '8th': '\uE4E6', '16th': '\uE4E7',
  };

  // Rhythm bar: one bar, internally gridded at 32nd-note resolution -- even
  // though the finest user-selectable value is a 16th (2 units), the extra
  // headroom keeps dotted values (which are always an even number of
  // 32nds: 3 sixteenths, 6 eighths, ...) landing on whole-unit boundaries.
  // A plain 16th rest is the default fill. The bar's actual total length and
  // beat grouping come from its time signature (numerator/denominator),
  // stored per-bar rather than assumed fixed at 4/4.
  function barTotalUnits(numerator, denominator) { return numerator * (32 / denominator); }
  function barBeatUnits(denominator) { return 32 / denominator; }
  function defaultRhythmCells(totalUnits) {
    return Array.from({ length: totalUnits / 2 }, () => ({ type: 'rest', duration: 2 }));
  }
  // Notes flagged short enough to beam (16th, 8th, dotted 8th).
  const BEAM_ELIGIBLE_DURATIONS = new Set([2, 4, 6]);

  // The picker menu opened by clicking a cell: every note duration plus its
  // dotted form, and a plain rest of each duration (durations in 32nd-note
  // units). Whichever don't fit the room left in the bar are filtered out
  // at menu-open time (see rhythmMenuOptionsFor).
  const RHYTHM_MENU_OPTIONS = [
    { type: 'note', duration: 2, label: '16th' },
    { type: 'note', duration: 4, label: '8th' },
    { type: 'note', duration: 6, label: 'Dotted 8th' },
    { type: 'note', duration: 8, label: 'Quarter' },
    { type: 'note', duration: 12, label: 'Dotted quarter' },
    { type: 'note', duration: 16, label: 'Half' },
    { type: 'note', duration: 24, label: 'Dotted half' },
    { type: 'note', duration: 32, label: 'Whole' },
    { type: 'note', duration: 48, label: 'Dotted whole' },
    { type: 'rest', duration: 2, label: '16th rest' },
    { type: 'rest', duration: 4, label: '8th rest' },
    { type: 'rest', duration: 8, label: 'Quarter rest' },
    { type: 'rest', duration: 16, label: 'Half rest' },
    { type: 'rest', duration: 32, label: 'Whole rest' },
  ];
  function rhythmMenuOptionsFor(cells, idx) {
    const totalUnits = cells.reduce((s, c) => s + c.duration, 0);
    const pos = cells.slice(0, idx).reduce((s, c) => s + c.duration, 0);
    const roomToEnd = totalUnits - pos;
    return RHYTHM_MENU_OPTIONS.filter(o => o.duration <= roomToEnd);
  }
  // How narrow a bar can be squeezed is just every cell at its floor width
  // (see allocateCellWidths below) -- below that, cells would have to
  // overlap their neighbors to fit.
  const RHYTHM_MIN_CELL_PX = 8;
  function rhythmBarMinWidth(cells) {
    return cells.length * RHYTHM_MIN_CELL_PX;
  }

  // Splits a bar's total pixel width `w` across its cells. While there's
  // enough room, each cell gets a share proportional to its duration (a
  // half note's slot is twice a quarter's), same as a plain uniform scale.
  // Once the bar is squeezed too narrow for that -- some cell's share
  // would dip below the minimum width a glyph needs to not overlap its
  // neighbor -- the squeeze no longer lands evenly. Every cell keeps its
  // floor width no matter what; the actual reduction comes out of
  // whichever cells still have slack above the floor, biggest-duration
  // (biggest gap) cells first, since a whole note or a half rest has far
  // more empty space in its slot than a 16th note does and so has far
  // more room to give up before it, too, is pulled down to the floor.
  // Standard "water-filling" allocation.
  function allocateCellWidths(cells, w) {
    const n = cells.length;
    const floor = RHYTHM_MIN_CELL_PX;
    const weights = cells.map(c => c.duration);
    const totalWeight = weights.reduce((s, d) => s + d, 0);

    const proportional = weights.map(wt => (wt / totalWeight) * w);
    if (proportional.every(pw => pw >= floor - 1e-6)) return proportional;

    const result = new Array(n).fill(0);
    const active = new Set(cells.map((_, i) => i));
    let remaining = w;
    let remainingWeight = totalWeight;
    let changed = true;
    while (changed && active.size > 0) {
      changed = false;
      for (const i of Array.from(active)) {
        const share = (weights[i] / remainingWeight) * remaining;
        if (share <= floor) {
          result[i] = floor;
          remaining -= floor;
          remainingWeight -= weights[i];
          active.delete(i);
          changed = true;
        }
      }
    }
    for (const i of active) result[i] = (weights[i] / remainingWeight) * remaining;
    return result;
  }
  // Replaces cells[idx] with newCell, then reconciles everything after it:
  // cells fully or partially overtaken by the new (larger) duration are
  // dropped, any leftover gap (when shrinking, or when growth doesn't land
  // exactly on an old boundary) is filled with fresh 16th rests, and
  // whatever remains untouched after that is kept as-is.
  function rebuildRhythmCells(cells, idx, newCell) {
    const pos = cells.slice(0, idx).reduce((s, c) => s + c.duration, 0);
    const newEnd = pos + newCell.duration;
    let cursor = pos + cells[idx].duration;
    let i = idx + 1;
    while (i < cells.length && cursor < newEnd) {
      cursor += cells[i].duration;
      i++;
    }
    const filler = [];
    for (let rem = cursor - newEnd; rem > 0; rem -= 2) filler.push({ type: 'rest', duration: 2 });
    return [...cells.slice(0, idx), { ...newCell }, ...filler, ...cells.slice(i)];
  }
  function rhythmCellGlyph(cell) {
    if (cell.type === 'rest') {
      switch (cell.duration) {
        case 2: return REST_CODES['16th'];
        case 4: return REST_CODES['8th'];
        case 8: return REST_CODES.quarter;
        case 16: return REST_CODES.half;
        case 32: return REST_CODES.whole;
        default: return REST_CODES['16th'];
      }
    }
    switch (cell.duration) {
      case 2: return NOTE_CODES['16th'];
      case 4: return NOTE_CODES['8th'];
      case 6: return NOTE_CODES['8th'] + AUG_DOT;
      case 8: return NOTE_CODES.quarter;
      case 12: return NOTE_CODES.quarter + AUG_DOT;
      case 16: return NOTE_CODES.half;
      case 24: return NOTE_CODES.half + AUG_DOT;
      case 32: return NOTE_CODES.whole;
      case 48: return NOTE_CODES.whole + AUG_DOT;
      default: return REST_CODES['16th'];
    }
  }

  let model = JSON.parse(JSON.stringify(initialSheet));
  model.elements = model.elements || [];

  let dirty = false;
  let uidCounter = 0;
  function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* ---------- small SVG helpers ---------- */
  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'cls') el.setAttribute('class', v);
      else el.setAttribute(k, v);
    }
    return el;
  }
  function svgRect(x, y, w, h, opts = {}) { return svgEl('rect', { x, y, width: w, height: h, ...opts }); }
  function svgLine(x1, y1, x2, y2, opts = {}) { return svgEl('line', { x1, y1, x2, y2, ...opts }); }
  function svgCircle(cx, cy, r, opts = {}) { return svgEl('circle', { cx, cy, r, ...opts }); }
  function svgGroup(opts = {}) { return svgEl('g', opts); }
  function svgPath(d, opts = {}) { return svgEl('path', { d, fill: 'none', ...opts }); }
  function svgText(text, x, y, opts = {}) {
    const el = svgEl('text', { x, y, 'text-anchor': opts.anchor || 'start', 'font-size': opts.size || 13, ...opts });
    el.textContent = text;
    return el;
  }

  const _measureCanvas = document.createElement('canvas');
  const _measureCtx = _measureCanvas.getContext('2d');
  function measureTextWidth(text, size, font) {
    _measureCtx.font = `${size}px ${font || 'MuseJazzText, cursive'}`;
    return _measureCtx.measureText(text || '').width;
  }

  // Barlines get a slight hand-drawn wobble instead of a perfectly straight
  // vector line: a gentle bow through a random-ish midpoint, seeded from the
  // element's own id so the wiggle is fixed (stable across re-renders, not
  // re-randomized on every drag) rather than a plain straight `<line>`.
  function seedFromString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h;
  }
  function seededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }
  function svgHandDrawnBarline(x, yTop, height, seed, cls) {
    const r1 = (seededRandom(seed) - 0.5) * 2;
    const r2 = (seededRandom(seed + 1) - 0.5) * 2;
    const topX = x + r1 * 1.1;
    const bottomX = x - r1 * 0.7;
    const midX = x + r2 * 1.4;
    const midY = yTop + height / 2;
    const d = `M ${topX} ${yTop} Q ${midX} ${midY} ${bottomX} ${yTop + height}`;
    return svgPath(d, { cls });
  }

  // Same idea as the barline wobble, extended to a closed rectangle: each
  // corner gets a small stable jitter and each edge a slight bow, so a
  // title box reads as a hand-drawn rectangle instead of a CAD-perfect one.
  // A hand-drawn box, like the boxed section labels in the reference chart:
  // a plain white fill underneath, with the 4 sides drawn as independent
  // strokes that slightly overshoot past each corner instead of meeting
  // exactly -- the way a pen-drawn rectangle's corners rarely line up
  // perfectly. Returns { group, hitTarget }: append `group`, wire drag/click
  // to `hitTarget` (the closed fill shape, the only one usable as a hit area).
  function svgHandDrawnRect(x, y, w, h, seed) {
    const jitter = 1, bow = 1.3, overshoot = 2.2;
    const rand = tag => (seededRandom(seedFromString(`${seed}-${tag}`)) - 0.5) * 2;

    const TL = { x: x + rand('tlx') * jitter, y: y + rand('tly') * jitter };
    const TR = { x: x + w + rand('trx') * jitter, y: y + rand('try') * jitter };
    const BR = { x: x + w + rand('brx') * jitter, y: y + h + rand('bry') * jitter };
    const BL = { x: x + rand('blx') * jitter, y: y + h + rand('bly') * jitter };

    function fillEdge(p0, p1, tag) {
      const mx = (p0.x + p1.x) / 2 + rand(`${tag}fx`) * (bow * 0.6);
      const my = (p0.y + p1.y) / 2 + rand(`${tag}fy`) * (bow * 0.6);
      return `Q ${mx} ${my} ${p1.x} ${p1.y}`;
    }
    const fillD = [
      `M ${TL.x} ${TL.y}`, fillEdge(TL, TR, 'e0'), fillEdge(TR, BR, 'e1'),
      fillEdge(BR, BL, 'e2'), fillEdge(BL, TL, 'e3'), 'Z',
    ].join(' ');
    const fillPath = svgPath(fillD, { cls: 'el-title-box-fill' });

    function strokeSide(p0, p1, tag) {
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const o0 = overshoot * (0.35 + 0.65 * Math.abs(rand(`${tag}o0`)));
      const o1 = overshoot * (0.35 + 0.65 * Math.abs(rand(`${tag}o1`)));
      const sx = p0.x - ux * o0, sy = p0.y - uy * o0;
      const ex = p1.x + ux * o1, ey = p1.y + uy * o1;
      const mx = (sx + ex) / 2 + rand(`${tag}mx`) * bow;
      const my = (sy + ey) / 2 + rand(`${tag}my`) * bow;
      return svgPath(`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`, { cls: 'el-title-box-stroke' });
    }

    const group = svgGroup();
    group.appendChild(fillPath);
    group.appendChild(strokeSide(TL, TR, 'top'));
    group.appendChild(strokeSide(TR, BR, 'right'));
    group.appendChild(strokeSide(BR, BL, 'bottom'));
    group.appendChild(strokeSide(BL, TL, 'left'));
    return { group, hitTarget: fillPath };
  }

  function ensureDefs(svg) {
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arrowhead', markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: 'auto' });
    marker.appendChild(svgEl('path', { d: 'M0,0 L6,3 L0,6 Z', cls: 'el-arrowhead-fill' }));
    defs.appendChild(marker);
    svg.appendChild(defs);
  }

  /* ---------- coordinate conversion ---------- */
  function svgMetrics() {
    const svg = document.getElementById('sheet-svg');
    const rect = svg.getBoundingClientRect();
    return { rect, scale: rect.width / PAGE_W };
  }
  function clientToSvg(clientX, clientY) {
    const { rect, scale } = svgMetrics();
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }
  function svgRectToScreen(x, y, w, h) {
    const { rect, scale } = svgMetrics();
    return { left: rect.left + x * scale, top: rect.top + y * scale, width: w * scale, height: h * scale };
  }

  /* ---------- drag-vs-click ---------- */
  function wireDragAndClick(hitEl, onDrag, onClick) {
    hitEl.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      function onMove(ev) {
        const { scale } = svgMetrics();
        const ddx = (ev.clientX - startX) / scale;
        const ddy = (ev.clientY - startY) / scale;
        if (Math.abs(ddx) > 3 || Math.abs(ddy) > 3) moved = true;
        if (moved && onDrag) onDrag(ddx, ddy);
      }
      function onUp(ev) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!moved && onClick) onClick(ev.clientX, ev.clientY);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Bottom-right corner resize handle, shared by every element type.
  function addResizeHandle(g, x, y, onDrag) {
    const handle = svgRect(x - 5, y - 5, 10, 10, { cls: 'el-resize-handle' });
    wireDragAndClick(handle, onDrag, null);
    g.appendChild(handle);
  }

  /* ---------- inline text-edit overlay ---------- */
  let activeOverlay = null;
  function closeOverlay(commit) {
    if (!activeOverlay) return;
    const { input, onCommit } = activeOverlay;
    const val = input.value;
    input.remove();
    activeOverlay = null;
    if (commit) onCommit(val);
    else renderSvg();
  }
  document.addEventListener('mousedown', e => {
    if (activeOverlay && e.target !== activeOverlay.input) closeOverlay(true);
  }, true);

  function openTextOverlay({ initialValue, rect, fontSize, onCommit }) {
    closeOverlay(true);
    const wrap = document.getElementById('page-wrap');
    const wrapRect = wrap.getBoundingClientRect();
    const { scale } = svgMetrics();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-edit-input';
    input.value = initialValue;
    input.style.left = `${rect.left - wrapRect.left}px`;
    input.style.top = `${rect.top - wrapRect.top}px`;
    input.style.width = `${rect.width}px`;
    input.style.height = `${rect.height}px`;
    input.style.fontSize = `${fontSize * scale}px`;
    wrap.appendChild(input);
    input.focus();
    input.select();
    activeOverlay = { input, onCommit };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); closeOverlay(true); }
      else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(false); }
    });
    input.addEventListener('blur', () => closeOverlay(true));
  }

  /* ---------- rhythm-cell picker menu ---------- */
  // Clicking a rhythm cell (on-page or in the sidebar builder) opens this
  // instead of cycling through a fixed sequence, since there are now too
  // many note/rest choices (10 notes + 5 rests) for a click-to-cycle to be
  // usable. Positioned at the click point (fixed to the viewport), not
  // computed from SVG coordinates, so it works the same for either SVG.
  let activeRhythmMenu = null;
  function closeRhythmMenu() {
    if (!activeRhythmMenu) return;
    activeRhythmMenu.remove();
    activeRhythmMenu = null;
  }
  document.addEventListener('mousedown', e => {
    if (activeRhythmMenu && !activeRhythmMenu.contains(e.target)) closeRhythmMenu();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activeRhythmMenu) closeRhythmMenu();
  });

  function openRhythmMenu(clientX, clientY, cells, idx, onApply) {
    closeRhythmMenu();
    const menu = document.createElement('div');
    menu.className = 'rhythm-menu';
    rhythmMenuOptionsFor(cells, idx).forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rhythm-menu-item';
      const glyph = document.createElement('span');
      glyph.className = 'rhythm-menu-glyph';
      glyph.textContent = rhythmCellGlyph(opt);
      const label = document.createElement('span');
      label.className = 'rhythm-menu-label';
      label.textContent = opt.label;
      btn.appendChild(glyph);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        onApply(rebuildRhythmCells(cells, idx, opt));
        closeRhythmMenu();
      });
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = clamp(clientX, 4, window.innerWidth - mw - 4);
    const top = clamp(clientY, 4, window.innerHeight - mh - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    activeRhythmMenu = menu;
  }

  function textBoxSize(text, fontSize) {
    const w = Math.max(50, measureTextWidth(text, fontSize) + 16);
    const h = fontSize + 14;
    return { w, h };
  }

  function startTextEdit(elementId) {
    const el = model.elements.find(e => e.id === elementId);
    if (!el) return;
    const fontSize = el.fontSize;
    const { w, h } = textBoxSize(el.text, fontSize);
    openTextOverlay({
      initialValue: el.text || '',
      rect: svgRectToScreen(el.x, el.y, w, h),
      fontSize,
      onCommit: val => { el.text = val; markDirty(); renderSvg(); },
    });
  }

  /* ---------- model mutation ---------- */
  // Finds a row under (x,y) so a dropped repeat mark can attach to it
  // instead of becoming its own free-floating element. Checked in reverse
  // so a row drawn on top (added later) wins over one underneath it. A
  // small margin lets a drop just outside the strict box still count.
  function findRowAt(x, y) {
    for (let i = model.elements.length - 1; i >= 0; i--) {
      const el = model.elements[i];
      if (el.type !== 'row') continue;
      if (x >= el.x - 10 && x <= el.x + el.w + 10 && y >= el.y - 10 && y <= el.y + el.h + 10) return el;
    }
    return null;
  }

  function addElement(type, x, y) {
    let el;
    if (type === 'title') {
      el = { id: uid('el'), type: 'title', x, y, text: 'Section', fontSize: 12 };
    } else if (type === 'row') {
      const n = clamp(parseInt(prompt('How many bars?', '4'), 10) || 4, 1, 9);
      el = { id: uid('el'), type: 'row', x, y, w: n * BAR_UNIT, h: BAR_H, barCount: n };
    } else if (type === 'chordText') {
      el = { id: uid('el'), type: 'chordText', x, y, text: 'Am', fontSize: 14 };
    } else if (type === 'text') {
      el = { id: uid('el'), type: 'text', x, y, text: 'Note', fontSize: 12 };
    } else if (type === 'repeat-start') {
      el = { id: uid('el'), type: 'repeat', x, y, w: REPEAT_MARK_W, h: BAR_H, kind: 'start' };
    } else if (type === 'repeat-end') {
      el = { id: uid('el'), type: 'repeat', x, y, w: REPEAT_MARK_W, h: BAR_H, kind: 'end' };
    } else if (type === 'arrow') {
      el = { id: uid('el'), type: 'arrow', x1: x, y1: y, x2: x + 70, y2: y - 40, bow: { dx: 0, dy: 0 } };
    } else if (type === 'glyph') {
      return addGlyph(x, y);
    } else {
      return;
    }
    model.elements.push(el);
    markDirty();
    render();
    if (type === 'title' || type === 'chordText' || type === 'text') {
      setTimeout(() => startTextEdit(el.id), 0);
    }
  }

  function addGlyph(x, y, code) {
    const el = { id: uid('el'), type: 'glyph', x, y, code: code || SIMILE_MARK, fontSize: 28 };
    model.elements.push(el);
    markDirty();
    render();
  }

  function addRhythmBar(x, y, cells, numerator, denominator) {
    const totalUnits = cells.reduce((s, c) => s + c.duration, 0);
    const el = {
      id: uid('el'), type: 'rhythmbar', x, y,
      w: totalUnits * 10.5, h: 28, // 10.5px/unit matches the old 16-slot/336px default look
      numerator: numerator || 4, denominator: denominator || 4,
      cells: JSON.parse(JSON.stringify(cells)),
    };
    model.elements.push(el);
    markDirty();
    render();
  }

  function removeElement(id) {
    model.elements = model.elements.filter(e => e.id !== id);
    markDirty(); render();
  }

  /* ---------- rendering ---------- */
  function addDeleteButton(g, el, x, y, w) {
    const del = svgText('×', x + w + 6, y + 11, { cls: 'el-delete' });
    del.addEventListener('mousedown', e => e.stopPropagation());
    del.addEventListener('click', e => { e.stopPropagation(); removeElement(el.id); });
    g.appendChild(del);
  }

  // Title/chordText/text all share this: an optional visible box, text
  // inside it, drag-to-move, click-to-edit, and a corner handle that scales
  // fontSize (which drives the box's own auto-fit size on the next render).
  function renderTextEl(svg, el, opts) {
    const fontSize = el.fontSize;
    const { w, h } = textBoxSize(el.text, fontSize);
    const g = svgGroup({ cls: 'el-group' });

    let interactiveEl;
    if (opts.boxed) {
      const { group, hitTarget } = svgHandDrawnRect(el.x, el.y, w, h, el.id);
      g.appendChild(group);
      interactiveEl = hitTarget;
    } else {
      interactiveEl = svgRect(el.x, el.y, w, h, { cls: 'el-text-hit' });
      g.appendChild(interactiveEl);
    }

    const textX = opts.boxed ? el.x + w / 2 : el.x + 8;
    g.appendChild(svgText(el.text || '', textX, el.y + h / 2 + fontSize * 0.35, {
      cls: opts.textCls, anchor: opts.boxed ? 'middle' : 'start', size: fontSize,
    }));

    const startX = el.x, startY = el.y;
    wireDragAndClick(interactiveEl,
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      () => startTextEdit(el.id));

    const startSize = fontSize;
    addResizeHandle(g, el.x + w, el.y + h, (ddx) => {
      el.fontSize = clamp(Math.round(startSize + ddx * 0.4), 8, 64);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, el.y, w);
    svg.appendChild(g);
  }

  function renderRowEl(svg, el) {
    const n = el.barCount, w = el.w, h = el.h;
    const barW = w / n;
    const g = svgGroup({ cls: 'el-group' });

    const hit = svgRect(el.x, el.y, w, h, { cls: 'el-row-hit' });
    g.appendChild(hit);
    const startX = el.x, startY = el.y;
    wireDragAndClick(hit, (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); }, null);

    for (let i = 0; i <= n; i++) {
      if (i === 0 && el.repeatStart) continue; // a repeat mark replaces the plain barline at that edge
      if (i === n && el.repeatEnd) continue;
      const lx = el.x + i * barW;
      g.appendChild(svgHandDrawnBarline(lx, el.y, h, seedFromString(`${el.id}-${i}`), 'el-row-divider'));
    }

    if (el.repeatStart) {
      drawRepeatMark(g, el.x, el.y, REPEAT_MARK_W, h, 'start', `${el.id}-repeatStart`);
      const del = svgText('×', el.x + REPEAT_MARK_W + 2, el.y + 11, { cls: 'el-delete' });
      del.addEventListener('mousedown', e => e.stopPropagation());
      del.addEventListener('click', e => { e.stopPropagation(); el.repeatStart = false; markDirty(); renderSvg(); });
      g.appendChild(del);
    }
    if (el.repeatEnd) {
      const rx = el.x + w - REPEAT_MARK_W;
      drawRepeatMark(g, rx, el.y, REPEAT_MARK_W, h, 'end', `${el.id}-repeatEnd`);
      const del = svgText('×', rx - 14, el.y + 11, { cls: 'el-delete' });
      del.addEventListener('mousedown', e => e.stopPropagation());
      del.addEventListener('click', e => { e.stopPropagation(); el.repeatEnd = false; markDirty(); renderSvg(); });
      g.appendChild(del);
    }

    const removeBtn = svgText('−', el.x - 10, el.y + h / 2 + 4, { cls: 'el-row-removebar', anchor: 'middle' });
    removeBtn.addEventListener('mousedown', e => e.stopPropagation());
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (el.barCount > 1) { el.barCount -= 1; markDirty(); renderSvg(); }
    });
    g.appendChild(removeBtn);

    const addBtn = svgText('+', el.x + w + 12, el.y + h / 2 + 4, { cls: 'el-row-addbar', anchor: 'middle' });
    addBtn.addEventListener('mousedown', e => e.stopPropagation());
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (el.barCount < 9) { el.barCount += 1; markDirty(); renderSvg(); }
    });
    g.appendChild(addBtn);

    const startW = w, startH = h;
    addResizeHandle(g, el.x + w, el.y + h, (ddx, ddy) => {
      el.w = clamp(startW + ddx, 30, PAGE_W);
      el.h = clamp(startH + ddy, 16, 300);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, el.y, w + 24);
    svg.appendChild(g);
  }

  // Shared by the standalone repeat element and repeat marks attached to a
  // row's edge -- both draw the same thick/thin/dots glyph, now with the
  // same hand-drawn wobble as plain barlines. `seedBase` must be a stable
  // id (not x/y), so the wobble doesn't re-randomize as the element moves.
  function drawRepeatMark(g, x, y, w, h, kind, seedBase) {
    if (kind === 'start') {
      g.appendChild(svgHandDrawnBarline(x + w * (2 / 18), y, h, seedFromString(`${seedBase}-thick`), 'el-repeat-thick'));
      g.appendChild(svgHandDrawnBarline(x + w * (6 / 18), y, h, seedFromString(`${seedBase}-thin`), 'el-repeat-thin'));
      g.appendChild(svgCircle(x + w * (11 / 18), y + h * 0.35, 2, { cls: 'el-repeat-dot' }));
      g.appendChild(svgCircle(x + w * (11 / 18), y + h * 0.65, 2, { cls: 'el-repeat-dot' }));
    } else {
      g.appendChild(svgCircle(x + w * (3 / 18), y + h * 0.35, 2, { cls: 'el-repeat-dot' }));
      g.appendChild(svgCircle(x + w * (3 / 18), y + h * 0.65, 2, { cls: 'el-repeat-dot' }));
      g.appendChild(svgHandDrawnBarline(x + w * (8 / 18), y, h, seedFromString(`${seedBase}-thin`), 'el-repeat-thin'));
      g.appendChild(svgHandDrawnBarline(x + w * (12 / 18), y, h, seedFromString(`${seedBase}-thick`), 'el-repeat-thick'));
    }
  }

  function renderRepeatEl(svg, el) {
    const w = el.w, h = el.h;
    const g = svgGroup({ cls: 'el-group' });
    const hit = svgRect(el.x, el.y, w, h, { cls: 'el-repeat-hit' });
    g.appendChild(hit);
    drawRepeatMark(g, el.x, el.y, w, h, el.kind, el.id);
    const startX = el.x, startY = el.y;
    wireDragAndClick(hit,
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      () => { el.kind = el.kind === 'start' ? 'end' : 'start'; markDirty(); renderSvg(); });

    const startW = w, startH = h;
    addResizeHandle(g, el.x + w, el.y + h, (ddx, ddy) => {
      el.w = clamp(startW + ddx, 10, 60);
      el.h = clamp(startH + ddy, 16, 200);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, el.y, w);
    svg.appendChild(g);
  }

  function arrowControlPoint(el) {
    const mx = (el.x1 + el.x2) / 2, my = (el.y1 + el.y2) / 2;
    const bow = el.bow || { dx: 0, dy: 0 };
    return { cx: mx + bow.dx, cy: my + bow.dy };
  }

  function renderArrowEl(svg, el) {
    if (!el.bow) el.bow = { dx: 0, dy: 0 };
    const { cx, cy } = arrowControlPoint(el);
    const d = `M ${el.x1} ${el.y1} Q ${cx} ${cy} ${el.x2} ${el.y2}`;
    const g = svgGroup({ cls: 'el-group' });

    const path = svgPath(d, { cls: 'el-arrow-path' });
    path.setAttribute('marker-end', 'url(#arrowhead)');
    g.appendChild(path);
    const bodyHit = svgPath(d, { cls: 'el-arrow-hit' });
    g.appendChild(bodyHit);

    const sx1 = el.x1, sy1 = el.y1, sx2 = el.x2, sy2 = el.y2;
    wireDragAndClick(bodyHit, (ddx, ddy) => {
      el.x1 = sx1 + ddx; el.y1 = sy1 + ddy; el.x2 = sx2 + ddx; el.y2 = sy2 + ddy;
      markDirty(); renderSvg();
    }, null);

    const h1 = svgCircle(el.x1, el.y1, 5, { cls: 'el-arrow-handle' });
    wireDragAndClick(h1, (ddx, ddy) => { el.x1 = sx1 + ddx; el.y1 = sy1 + ddy; markDirty(); renderSvg(); }, null);
    g.appendChild(h1);

    const h2 = svgCircle(el.x2, el.y2, 5, { cls: 'el-arrow-handle' });
    wireDragAndClick(h2, (ddx, ddy) => { el.x2 = sx2 + ddx; el.y2 = sy2 + ddy; markDirty(); renderSvg(); }, null);
    g.appendChild(h2);

    // Bow handle: drag away from the straight-line midpoint to curve the
    // arrow. At (dx,dy)=(0,0) the quadratic control point sits exactly on
    // the line between the endpoints, so the path renders perfectly straight.
    const startBowDx = el.bow.dx, startBowDy = el.bow.dy;
    const hb = svgCircle(cx, cy, 4, { cls: 'el-arrow-bow-handle' });
    wireDragAndClick(hb, (ddx, ddy) => {
      el.bow.dx = startBowDx + ddx; el.bow.dy = startBowDy + ddy;
      markDirty(); renderSvg();
    }, null);
    g.appendChild(hb);

    addDeleteButton(g, el, Math.max(el.x1, el.x2), Math.min(el.y1, el.y2) - 20, 0);
    svg.appendChild(g);
  }

  function renderGlyphEl(svg, el) {
    const size = el.fontSize;
    const w = Math.max(20, measureTextWidth(el.code, size, 'MuseJazz'));
    const h = size;
    const g = svgGroup({ cls: 'el-group' });
    const hit = svgRect(el.x, el.y - h * 0.75, w, h, { cls: 'el-glyph-hit' });
    g.appendChild(hit);
    g.appendChild(svgText(el.code, el.x, el.y, { cls: 'el-glyph-text', size }));
    const startX = el.x, startY = el.y;
    wireDragAndClick(hit, (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); }, null);

    const startSize = size;
    addResizeHandle(g, el.x + w, el.y + h * 0.25, (ddx) => {
      el.fontSize = clamp(Math.round(startSize + ddx * 0.4), 12, 100);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, el.y - h * 0.75, w);
    svg.appendChild(g);
  }

  // Notes are drawn entirely by hand (no font note glyphs) with a slash
  // notehead instead of a filled oval -- the "rhythm notation" convention
  // used on real charts where a note's pitch doesn't matter, only its
  // rhythm, so the head is a tick rather than a dot. `nx` is the note's
  // left-anchored rhythmic position (see the beam-run loop below for why
  // that anchor matters); the notehead's own footprint is still `headW`
  // (so note spacing/beam alignment don't shift), but only a shorter
  // stroke is actually drawn, anchored at the stem-attachment end so the
  // stem still meets it with no gap. Hands back the point its stem
  // should start from.
  function drawNoteheadSlash(container, nx, y, headW, h) {
    const x2 = nx + headW, y2 = y - headW * 0.38;
    const fullX1 = nx, fullY1 = y + headW * 0.38;
    const drawnFraction = 0.7;
    const x1 = x2 - (x2 - fullX1) * drawnFraction;
    const y1 = y2 - (y2 - fullY1) * drawnFraction;
    const line = svgLine(x1, y1, x2, y2, { cls: 'el-notehead-slash' });
    line.setAttribute('stroke-width', h * 0.1);
    container.appendChild(line);
    return { stemX: x2, stemY: y2 };
  }

  // A standalone note (not part of a beamed run): slash notehead, a stem
  // (except whole notes, which conventionally have none), and hand-drawn
  // flags for any duration short enough to need them (a beamed run gets
  // its flags as a shared beam instead -- see the run-drawing loop below).
  function drawSingleNote(container, nx, y, cell, h, headW, stemLen) {
    y += h * 0.05; // nudged down slightly relative to rests, for visual balance
    const { stemX, stemY } = drawNoteheadSlash(container, nx, y, headW, h);
    if (cell.duration === 6 || cell.duration === 12 || cell.duration === 24 || cell.duration === 48) {
      container.appendChild(svgText(AUG_DOT, stemX + h * 0.08, y, { cls: 'el-glyph-text', size: h }));
    }
    if (cell.duration === 32 || cell.duration === 48) return; // whole notes: no stem
    const stemTopY = y - stemLen;
    container.appendChild(svgLine(stemX, stemY, stemX, stemTopY, { cls: 'el-notegroup-stem' }));
    if (cell.duration === 2 || cell.duration === 4 || cell.duration === 6) {
      const flagCount = cell.duration === 2 ? 2 : 1;
      const flagGap = h * 0.22, flagLen = h * 0.26;
      for (let f = 0; f < flagCount; f++) {
        const fy = stemTopY + f * flagGap;
        const flag = svgLine(stemX, fy, stemX + flagLen, fy + flagLen, { cls: 'el-notegroup-beam' });
        flag.setAttribute('stroke-width', h * 0.1);
        container.appendChild(flag);
      }
    }
  }

  // Draws a whole rhythm bar's worth of cells into `container` (either the
  // on-page element's <g>, or the sidebar builder's own small <svg>), used
  // by both so they render identically. Rests get their font glyph; every
  // note is hand-drawn (see drawSingleNote/drawNoteheadSlash above), with
  // runs of 2+ consecutive 8th/16th notes beamed together instead of each
  // getting its own flags. `onCellDrag` is null for the sidebar builder
  // (click-only, nothing to drag), and moves the whole element for the
  // on-page version. `w` is the bar's total width, split across cells by
  // allocateCellWidths (duration-proportional until the bar gets too
  // narrow for that -- see its own comment); `h`
  // drives every vertical/glyph measurement (stem length, beam spacing,
  // note size) -- the two are independent so an on-page bar can be
  // stretched wider without its notes getting bigger, or taller without
  // spacing the units out.
  function renderRhythmCells(container, cells, x, y, w, h, onCellClick, onCellDrag, beatUnits) {
    const totalUnits = cells.reduce((s, c) => s + c.duration, 0);
    const avgUnitW = w / totalUnits;
    const cellWidths = allocateCellWidths(cells, w);
    let cursorPx = 0;
    const positionsPx = cellWidths.map(cw => { const p = cursorPx; cursorPx += cw; return p; });
    const headW = h * 0.33;
    // 0.68em matches this font's own combined note glyphs (e.g. metNoteQuarterUp
    // spans 0.811em total, notehead alone 0.27em -> ~0.68em of stem above it),
    // so a hand-built beamed note lines up visually with a plain single note.
    const stemLen = h * 0.68;
    const beamThick = h * 0.16;
    const beamGap = h * 0.22;
    const beamY = y - stemLen;

    let cursor = 0;
    const positions = cells.map(c => { const p = cursor; cursor += c.duration; return p; });

    // Dotted-8th notes beam together with 8ths/16ths too -- the classic
    // "dotted-eighth + sixteenth" pattern is always beamed in standard
    // notation, with the 16th getting a partial second beam back toward
    // the dotted note (handled below, since only plain 16ths count toward
    // the secondary-beam connections). Beams never cross from one beat
    // into the next (one beat = beatUnits 32nds, per the bar's time
    // signature), even if the notes on either side would otherwise be
    // beam-eligible and adjacent -- so a run also breaks at every beat
    // boundary, not just at rests/long notes.
    const runs = [];
    let runStart = null;
    for (let i = 0; i < cells.length; i++) {
      const eligible = cells[i].type === 'note' && BEAM_ELIGIBLE_DURATIONS.has(cells[i].duration);
      const crossedBeat = runStart !== null && Math.floor(positions[i] / beatUnits) !== Math.floor(positions[i - 1] / beatUnits);
      if (runStart !== null && (!eligible || crossedBeat)) {
        runs.push({ start: runStart, end: i - 1 });
        runStart = null;
      }
      if (eligible && runStart === null) runStart = i;
    }
    if (runStart !== null) runs.push({ start: runStart, end: cells.length - 1 });
    const runOf = new Map();
    runs.forEach(r => { for (let i = r.start; i <= r.end; i++) runOf.set(i, r); });

    cells.forEach((cell, i) => {
      const cellX = x + positionsPx[i];
      const cellW = cellWidths[i];
      const hit = svgRect(cellX, beamY - beamThick - 4, cellW, (y - beamY) + beamThick + h * 0.9, { cls: 'el-rhythm-cell-hit' });
      container.appendChild(hit);
      if (onCellDrag) wireDragAndClick(hit, onCellDrag, (clientX, clientY) => onCellClick(i, clientX, clientY));
      else hit.addEventListener('click', e => onCellClick(i, e.clientX, e.clientY));

      const run = runOf.get(i);
      if (run && run.end > run.start) {
        if (i === run.start) {
          const runCells = cells.slice(run.start, run.end + 1);
          const stemXs = [];
          for (let k = run.start; k <= run.end; k++) {
            // Anchored at the note's own starting position (not centered in
            // its span) so a note never visually shifts when its own or a
            // neighbor's duration changes -- only its neighbors' positions
            // (which is the actual timing) move.
            const nx = x + positionsPx[k];
            const noteY = y + h * 0.05; // nudged down slightly relative to rests, for visual balance
            const { stemX, stemY } = drawNoteheadSlash(container, nx, noteY, headW, h);
            if (cells[k].duration === 6) {
              container.appendChild(svgText(AUG_DOT, stemX + h * 0.08, noteY, { cls: 'el-glyph-text', size: h }));
            }
            stemXs.push(stemX);
            container.appendChild(svgLine(stemX, stemY, stemX, beamY, { cls: 'el-notegroup-stem' }));
          }
          // Primary beam always spans the whole run. A secondary beam only
          // applies where 16th notes need it: a full second stroke between
          // two adjacent 16ths, or a short "broken" stub on a 16th that has
          // no 16th neighbor to connect to (8ths and dotted-8ths in the run
          // get no second beam of their own, matching standard engraving).
          const primary = svgLine(stemXs[0], beamY, stemXs[stemXs.length - 1], beamY, { cls: 'el-notegroup-beam' });
          primary.setAttribute('stroke-width', beamThick);
          container.appendChild(primary);

          // Group the run's 16th notes into their own maximal contiguous
          // stretches: a stretch of 2+ gets one continuous secondary beam
          // spanning it (not one segment per adjacent pair); a lone 16th
          // with no 16th neighbor gets a short broken-beam stub instead,
          // pointing toward whichever side still has notes left in the run.
          const beam2Y = beamY + beamGap;
          const stubLen = avgUnitW * 0.8;
          const sixteenthStretches = [];
          let sStart = null;
          for (let k = 0; k <= runCells.length; k++) {
            const is16 = k < runCells.length && runCells[k].duration === 2;
            if (is16) {
              if (sStart === null) sStart = k;
            } else if (sStart !== null) {
              sixteenthStretches.push({ start: sStart, end: k - 1 });
              sStart = null;
            }
          }
          sixteenthStretches.forEach(sr => {
            if (sr.end > sr.start) {
              const seg = svgLine(stemXs[sr.start], beam2Y, stemXs[sr.end], beam2Y, { cls: 'el-notegroup-beam' });
              seg.setAttribute('stroke-width', beamThick);
              container.appendChild(seg);
            } else {
              const dir = sr.start < runCells.length - 1 ? 1 : -1;
              const stub = svgLine(stemXs[sr.start], beam2Y, stemXs[sr.start] + dir * stubLen, beam2Y, { cls: 'el-notegroup-beam' });
              stub.setAttribute('stroke-width', beamThick);
              container.appendChild(stub);
            }
          });
        }
        return;
      }

      // A rest is picked fresh from the menu each time (never grown/shrunk
      // in place the way a note's own duration can cycle), so centering it
      // in its own span is always stable; only notes need the
      // left-anchored/"don't move" treatment above.
      if (cell.type === 'rest') {
        const cx = x + positionsPx[i] + cellWidths[i] / 2;
        const restY = y - h * 0.05; // nudged up slightly relative to notes, for visual balance
        container.appendChild(svgText(rhythmCellGlyph(cell), cx, restY, { cls: 'el-glyph-text', anchor: 'middle', size: h }));
      } else {
        const nx = x + positionsPx[i];
        drawSingleNote(container, nx, y, cell, h, headW, stemLen);
      }
    });

    return { topY: beamY - beamThick - 4, bottomY: y + h * 0.4 };
  }

  function renderRhythmBarEl(svg, el) {
    const g = svgGroup({ cls: 'el-group' });
    const startX = el.x, startY = el.y;
    const { topY, bottomY } = renderRhythmCells(g, el.cells, el.x, el.y, el.w, el.h,
      (idx, clientX, clientY) => openRhythmMenu(clientX, clientY, el.cells, idx, newCells => {
        el.cells = newCells; markDirty(); renderSvg();
      }),
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      barBeatUnits(el.denominator || 4));

    // Width and height are independent -- dragging sideways spaces the 16
    // units out without changing note size; dragging up/down scales the
    // notes/stems without changing the bar's overall width.
    const startW = el.w, startH = el.h;
    addResizeHandle(g, el.x + el.w, bottomY, (ddx, ddy) => {
      el.w = clamp(startW + ddx, rhythmBarMinWidth(el.cells), PAGE_W);
      el.h = clamp(startH + ddy, 12, 100);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, topY, el.w);
    svg.appendChild(g);
  }

  function renderElement(svg, el) {
    if (el.type === 'title') renderTextEl(svg, el, { boxed: true, textCls: 'el-title-text' });
    else if (el.type === 'chordText') renderTextEl(svg, el, { boxed: false, textCls: 'el-chord-text' });
    else if (el.type === 'text') renderTextEl(svg, el, { boxed: false, textCls: 'el-text-text' });
    else if (el.type === 'row') renderRowEl(svg, el);
    else if (el.type === 'repeat') renderRepeatEl(svg, el);
    else if (el.type === 'arrow') renderArrowEl(svg, el);
    else if (el.type === 'glyph') renderGlyphEl(svg, el);
    else if (el.type === 'rhythmbar') renderRhythmBarEl(svg, el);
  }

  function renderSvg() {
    const svg = document.getElementById('sheet-svg');
    svg.setAttribute('viewBox', `0 0 ${PAGE_W} ${PAGE_H}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    ensureDefs(svg);

    svg.appendChild(svgRect(0, 0, PAGE_W, PAGE_H, { cls: 'page-bg' }));

    const titleStr = model.title || 'Untitled';
    svg.appendChild(svgText(titleStr, PAGE_W / 2, PAGE_MARGIN, { cls: 'page-title-text', anchor: 'middle', size: 22 }));
    if (model.key) {
      svg.appendChild(svgText(`(${model.key})`, PAGE_W / 2, PAGE_MARGIN + 22, { cls: 'page-key-text', anchor: 'middle', size: 13 }));
    }

    model.elements.forEach(el => renderElement(svg, el));
  }

  function render() {
    document.getElementById('sheet-title').value = model.title;
    document.getElementById('sheet-key').value = model.key;
    renderSvg();
  }

  /* ---------- save status ---------- */
  function markDirty() { dirty = true; updateSaveStatus(); }
  function updateSaveStatus() {
    const el = document.getElementById('save-status');
    el.textContent = dirty ? 'Unsaved' : 'Saved';
    el.classList.toggle('unsaved', dirty);
  }

  /* ---------- palette ---------- */
  function wirePaletteDrag(tile) {
    tile.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: tile.dataset.type, code: tile.dataset.code || null }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  document.querySelectorAll('.palette-tile').forEach(wirePaletteDrag);

  const pageWrap = document.getElementById('page-wrap');
  pageWrap.addEventListener('dragover', e => { e.preventDefault(); pageWrap.classList.add('drag-over'); });
  pageWrap.addEventListener('dragleave', () => pageWrap.classList.remove('drag-over'));
  pageWrap.addEventListener('drop', e => {
    e.preventDefault();
    pageWrap.classList.remove('drag-over');
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
    if (!payload || !payload.type) return;
    const { x, y } = clientToSvg(e.clientX, e.clientY);
    if (payload.type === 'glyph') { addGlyph(x, y, payload.code); return; }
    if (payload.type === 'rhythmbar') { addRhythmBar(x, y, payload.cells, payload.numerator, payload.denominator); return; }
    if (payload.type === 'repeat-start' || payload.type === 'repeat-end') {
      const row = findRowAt(x, y);
      if (row) {
        if (payload.type === 'repeat-start') row.repeatStart = true;
        else row.repeatEnd = true;
        markDirty(); render();
        return;
      }
    }
    addElement(payload.type, x, y);
  });

  /* ---------- rhythm bar builder ---------- */
  // A live, persistent bar in the sidebar: click a cell to open a menu of
  // note/rest durations, then drag the whole thing onto the page once it
  // looks right. It keeps its state after a drag (rather than resetting) so
  // you can drop a few similar bars in a row; use Reset to clear it back to
  // all rests. The time signature fields control the bar's total length and
  // beat grouping (for beaming); changing either resets the builder.
  let builderNumerator = 4, builderDenominator = 4;
  let builderCells = defaultRhythmCells(barTotalUnits(builderNumerator, builderDenominator));
  const BUILDER_H = 20;
  const BUILDER_UNIT_PX = 7.5; // matches the old fixed 16-slot/240px builder width at 4/4

  function renderBuilderSvg() {
    const svg = document.getElementById('rhythm-builder-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const builderW = barTotalUnits(builderNumerator, builderDenominator) * BUILDER_UNIT_PX;
    renderRhythmCells(svg, builderCells, 6, 40, builderW, BUILDER_H,
      (idx, clientX, clientY) => openRhythmMenu(clientX, clientY, builderCells, idx, newCells => {
        builderCells = newCells; renderBuilderSvg();
      }),
      null, barBeatUnits(builderDenominator));
    const vbW = builderW + 12;
    svg.setAttribute('viewBox', `0 0 ${vbW} 68`);
    svg.setAttribute('width', vbW);
    svg.setAttribute('height', 68);
    // Box height is fixed by CSS; when the viewBox is narrower than the
    // box, anchor content to the left/vertical-center rather than the
    // default centering, so it doesn't jump around as beats are added
    // or removed.
    svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  }
  renderBuilderSvg();

  document.getElementById('rhythm-builder-drag').addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', JSON.stringify({
      type: 'rhythmbar', cells: builderCells, numerator: builderNumerator, denominator: builderDenominator,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  });
  document.getElementById('rhythm-builder-reset').addEventListener('click', () => {
    builderCells = defaultRhythmCells(barTotalUnits(builderNumerator, builderDenominator));
    renderBuilderSvg();
  });
  function wireTimeSigInput(id, apply) {
    document.getElementById(id).addEventListener('change', e => {
      const v = clamp(parseInt(e.target.value, 10) || 4, 1, 32);
      e.target.value = v;
      apply(v);
      builderCells = defaultRhythmCells(barTotalUnits(builderNumerator, builderDenominator));
      renderBuilderSvg();
    });
  }
  wireTimeSigInput('rhythm-time-num', v => { builderNumerator = v; });
  wireTimeSigInput('rhythm-time-den', v => { builderDenominator = v; });

  /* ---------- toolbar wiring ---------- */
  document.getElementById('sheet-title').addEventListener('input', e => { model.title = e.target.value; markDirty(); renderSvg(); });
  document.getElementById('sheet-key').addEventListener('input', e => { model.key = e.target.value; markDirty(); renderSvg(); });

  document.getElementById('save-btn').addEventListener('click', async () => {
    const status = document.getElementById('save-status');
    status.textContent = 'Saving…';
    status.classList.remove('save-status--error');
    try {
      const resp = await fetch(`/leadsheets/${leadsheetId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      });
      if (!resp.ok) {
        status.textContent = (await resp.text()) || 'Failed to save.';
        status.classList.add('save-status--error');
        return;
      }
      dirty = false;
      updateSaveStatus();
    } catch (err) {
      status.textContent = 'Failed to save.';
      status.classList.add('save-status--error');
    }
  });

  window.addEventListener('beforeunload', e => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(model.title || 'leadsheet').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('print-btn').addEventListener('click', () => window.print());

  const confirmModal = document.getElementById('confirm-modal');
  document.getElementById('delete-btn').addEventListener('click', () => { confirmModal.hidden = false; });
  confirmModal.addEventListener('click', e => { if (e.target === confirmModal) confirmModal.hidden = true; });
  document.getElementById('confirm-cancel').addEventListener('click', () => { confirmModal.hidden = true; });
  document.getElementById('confirm-ok').addEventListener('click', async () => {
    confirmModal.hidden = true;
    const resp = await fetch(`/leadsheets/${leadsheetId}/delete`, { method: 'POST' });
    if (resp.ok) { dirty = false; location.href = '/leadsheets'; }
    else alert('Failed to delete: ' + await resp.text());
  });

  render();
})();
