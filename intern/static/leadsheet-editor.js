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
  // A row can hold up to 12 bars; past 9 the bars get narrower so the row
  // still fits within the page margins.
  const ROW_MAX_BARS = 12;
  const ROW_MAX_W = PAGE_W - 2 * PAGE_MARGIN;
  const BAR_H = 30; // calibrated against a hand-finished 8-bar row on a real sheet
  const REPEAT_MARK_W = 14;
  const VOLTA_H = 22, VOLTA_FONT_SIZE = 13;

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

  // Note staff glyphs: unlike the rhythm-only notation above, these are the
  // font's real individual SMuFL glyphs (clefs, accidentals, noteheads,
  // flags) at their standard codepoints -- verified directly against the
  // font's outlines, not just its cmap.
  const CLEF_CODES = { treble: '\uE050', bass: '\uE062' };
  const ACCIDENTAL_CODES = { sharp: '\uE262', flat: '\uE260', natural: '\uE261' };
  const FLAG_CODES = { '8th-up': '\uE240', '8th-down': '\uE241', '16th-up': '\uE242', '16th-down': '\uE243' };
  // Half of each notehead glyph's advance width in em (the glyphs have no
  // side bearing, so that's also their ink half-width), measured from
  // fonts/MuseJazz.otf. Where a stem has to sit to actually touch the head.
  const NOTEHEAD_HALF_W_EM = { black: 0.1645, half: 0.182, whole: 0.2275 };
  function noteheadHalfW(duration, size) {
    if (duration >= 32) return NOTEHEAD_HALF_W_EM.whole * size;
    if (duration >= 16) return NOTEHEAD_HALF_W_EM.half * size;
    return NOTEHEAD_HALF_W_EM.black * size;
  }
  // Kept in step with `.el-notegroup-stem { stroke-width }` in style.css.
  const NOTESTAFF_STEM_W = 1.5;
  function noteheadCode(duration) {
    if (duration === 32 || duration === 48) return '\uE0A2'; // noteheadWhole
    if (duration === 16 || duration === 24) return '\uE0A3'; // noteheadHalf
    return '\uE0A4'; // noteheadBlack
  }

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

  /* ---------- Articulations (staccato / accent / fermata) ---------- */
  // Stored per note cell as `articulations: ['staccato', 'accent', 'fermata']`
  // (any subset). Hand-drawn like the rhythm notes, so no font glyphs needed.
  const ARTICULATION_KINDS = [
    { value: 'fermata', label: 'Fermata' },
    { value: 'accent', label: 'Accent' },
    { value: 'staccato', label: 'Staccato' },
  ];
  function cellHasArticulation(cell, kind) {
    return !!(cell.articulations && cell.articulations.includes(kind));
  }
  function toggleCellArticulation(cell, kind) {
    const list = (cell.articulations || []).filter(k => k !== kind);
    if (list.length === (cell.articulations || []).length) list.push(kind);
    if (list.length) cell.articulations = list;
    else delete cell.articulations;
  }
  // Draws a note's articulations relative to its own ink. A fermata goes above
  // the note; staccato and accent go below it (staccato closest, accent under
  // that). `anchor` is `{ aboveX, aboveY, belowX, belowY }`: the x to center
  // the glyphs on above/below, and the highest / lowest ink of the note itself
  // (stem tip or beam, notehead, ...). `unit` is a size reference (roughly the
  // note's staff/bar height).
  function drawArticulations(container, anchor, articulations, unit) {
    if (!articulations || !articulations.length) return;
    const gap = unit * 0.08;
    const margin = unit * 0.1;
    const stroke = Math.max(1.1, unit * 0.045);

    let y = anchor.belowY + margin; // top edge of the next glyph below; moves downward
    if (articulations.includes('staccato')) {
      const r = Math.max(1.4, unit * 0.055);
      container.appendChild(svgCircle(anchor.belowX, y + r, r, { cls: 'el-artic-dot' }));
      y += 2 * r + gap;
    }
    if (articulations.includes('accent')) {
      const w = unit * 0.34, hh = unit * 0.12;
      const cy = y + hh;
      container.appendChild(svgPath(`M ${anchor.belowX - w / 2} ${cy - hh} L ${anchor.belowX + w / 2} ${cy} L ${anchor.belowX - w / 2} ${cy + hh}`,
        { cls: 'el-artic-line', 'stroke-width': stroke }));
    }
    if (articulations.includes('fermata')) { // an arc with a dot under its middle
      const cx = anchor.aboveX, base = anchor.aboveY - margin;
      const w = unit * 0.6, rise = unit * 0.3;
      container.appendChild(svgPath(
        `M ${cx - w / 2} ${base} C ${cx - w / 2} ${base - rise * 1.35}, ${cx + w / 2} ${base - rise * 1.35}, ${cx + w / 2} ${base}`,
        { cls: 'el-artic-line', 'stroke-width': stroke }));
      container.appendChild(svgCircle(cx, base - rise * 0.22, Math.max(1.3, unit * 0.05), { cls: 'el-artic-dot' }));
    }
  }

  /* ---------- Note staff (pitched notation) ---------- */
  // A staff position is a clef-independent integer step: 0 = bottom line, 1
  // = space above it, 2 = next line, ... 8 = top line (even = line, odd =
  // space); negative/>8 extend onto ledger lines. Changing an element's clef
  // never touches its notes' stored positions -- the same step sounding a
  // different pitch under a different clef is correct notation behavior,
  // not something to "fix."
  const STAFF_PITCH_MIN = -6, STAFF_PITCH_MAX = 14, STAFF_DEFAULT_PITCH = 4;
  const STAFF_LETTER_CYCLE = ['E', 'F', 'G', 'A', 'B', 'C', 'D'];
  const STAFF_CLEF_BASE_INDEX = { treble: 0, bass: 2 }; // each clef's bottom-line letter's cycle index
  function staffLetterForPosition(position, clef) {
    const idx = ((STAFF_CLEF_BASE_INDEX[clef] + position) % 7 + 7) % 7;
    return STAFF_LETTER_CYCLE[idx];
  }
  // Ledger positions needed to reach `position`: every even step strictly
  // between the staff and the note (inclusive of the note's own position if
  // it itself sits on a line), so a note in a ledger space gets the line(s)
  // below/above it but nothing drawn through its own notehead.
  function ledgerStepsFor(position) {
    const steps = [];
    if (position <= -2) {
      for (let s = -2; s >= Math.ceil(position / 2) * 2; s -= 2) steps.push(s);
    } else if (position >= 10) {
      for (let s = 10; s <= Math.floor(position / 2) * 2; s += 2) steps.push(s);
    }
    return steps;
  }

  // Key signature: a signed sharp/flat count, own to each note-staff bar
  // (independent of the sheet's free-text Key field). The circle-of-fifths
  // orders below double as both "which letters are altered" and, combined
  // with a fixed per-clef glyph-position table, "where the signature is
  // drawn" -- the latter is a fixed engraving convention, not derived from
  // the former.
  const KEYSIG_SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const KEYSIG_FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  function alteredLettersForKeySignature(k) {
    if (k > 0) return new Set(KEYSIG_SHARP_ORDER.slice(0, k));
    if (k < 0) return new Set(KEYSIG_FLAT_ORDER.slice(0, -k));
    return new Set();
  }
  function impliedAccidentalForPosition(position, clef, keySignature) {
    if (!keySignature) return null;
    if (!alteredLettersForKeySignature(keySignature).has(staffLetterForPosition(position, clef))) return null;
    return keySignature > 0 ? 'sharp' : 'flat';
  }
  const KEYSIG_GLYPH_POSITIONS = {
    treble: { sharp: [8, 5, 9, 6, 3, 7, 4], flat: [4, 7, 3, 6, 2, 5, 1] },
    bass: { sharp: [6, 3, 7, 4, 1, 5, 2], flat: [2, 5, 1, 4, 0, 3, -1] },
  };
  const KEYSIG_GLYPH_STEP_PX = 9;
  const NOTESTAFF_CLEF_W = 24;
  function notestaffKeySigWidth(keySignature) {
    return keySignature ? Math.abs(keySignature) * KEYSIG_GLYPH_STEP_PX + 6 : 0;
  }
  function notestaffLeadWidth(el) {
    return NOTESTAFF_CLEF_W + notestaffKeySigWidth(el.keySignature) + 10;
  }
  // Bottom line = step 0, top line = step 8, so the full 5-line staff spans
  // el.h; el.h/8 is one staff step in pixels.
  function pitchToY(position, el) {
    return el.y + el.h - position * (el.h / 8);
  }

  let model = JSON.parse(JSON.stringify(initialSheet));
  model.elements = model.elements || [];

  let dirty = false;
  let uidCounter = 0;
  function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Transient UI state (never saved): the elements picked up by the
  // marquee, and the marquee box itself while it's being drawn (SVG units).
  const selectedIds = new Set();
  let marquee = null;

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
  // General form: scale is that SVG's own CSS-pixel-per-user-unit ratio
  // (its rendered width over its own viewBox width, falling back to PAGE_W
  // for the main page SVG, which has no explicit viewBox width otherwise).
  // Needed because the page isn't the only SVG a drag can happen in -- the
  // note staff builder's small preview SVG has its own, different scale.
  function svgMetricsFor(svg) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox && svg.viewBox.baseVal;
    return { rect, scale: rect.width / (vb && vb.width ? vb.width : PAGE_W) };
  }
  function svgMetrics() { return svgMetricsFor(document.getElementById('sheet-svg')); }
  function clientToSvg(clientX, clientY) {
    const { rect, scale } = svgMetrics();
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }
  function svgRectToScreen(x, y, w, h) {
    const { rect, scale } = svgMetrics();
    return { left: rect.left + x * scale, top: rect.top + y * scale, width: w * scale, height: h * scale };
  }

  /* ---------- marquee selection ---------- */
  // Approximate on-page footprint of an element, used only to decide what a
  // marquee "touches" and to outline the selection -- so the padding on the
  // notation types (stems, beams, ledger lines) needn't be exact.
  function elementBounds(el) {
    switch (el.type) {
      case 'title': case 'chordText': case 'text': {
        const { w, h } = textBoxSize(el.text, el.fontSize);
        return { x: el.x, y: el.y, w, h };
      }
      case 'row': case 'repeat': case 'volta':
        return { x: el.x, y: el.y, w: el.w, h: el.h };
      case 'glyph': {
        const w = Math.max(20, measureTextWidth(el.code, el.fontSize, 'MuseJazz'));
        return { x: el.x, y: el.y - el.fontSize * 0.75, w, h: el.fontSize };
      }
      case 'arrow': {
        const { cx, cy } = arrowControlPoint(el);
        const x0 = Math.min(el.x1, el.x2, cx), x1 = Math.max(el.x1, el.x2, cx);
        const y0 = Math.min(el.y1, el.y2, cy), y1 = Math.max(el.y1, el.y2, cy);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      case 'rhythmbar': {
        const pad = el.h * 0.9;
        return { x: el.x, y: el.y - pad, w: el.w, h: el.h + pad };
      }
      case 'notestaff': {
        const pad = el.h * 0.4;
        const leadW = notestaffLeadWidth(el);
        return { x: el.x - 8, y: el.y - pad, w: leadW + el.w + 8, h: el.h + 2 * pad };
      }
      default:
        return { x: el.x || 0, y: el.y || 0, w: 0, h: 0 };
    }
  }

  function snapshotPos(el) {
    return el.type === 'arrow'
      ? { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 }
      : { x: el.x, y: el.y };
  }
  function applyOffset(el, snap, dx, dy) {
    if (el.type === 'arrow') {
      el.x1 = snap.x1 + dx; el.y1 = snap.y1 + dy; el.x2 = snap.x2 + dx; el.y2 = snap.y2 + dy;
    } else {
      el.x = snap.x + dx; el.y = snap.y + dy;
    }
  }

  // Drops the selection outline nodes straight from the DOM. Used when a
  // gesture on an unselected element starts: a full re-render inside
  // mousedown would detach the very node being pressed.
  function clearSelection() {
    if (!selectedIds.size) return;
    selectedIds.clear();
    document.querySelectorAll('#sheet-svg .el-selection').forEach(n => n.remove());
  }

  function drawSelectionOverlay(svg) {
    model.elements.forEach(el => {
      if (!selectedIds.has(el.id)) return;
      const b = elementBounds(el);
      svg.appendChild(svgRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6, { cls: 'el-selection', rx: 3 }));
    });
    if (marquee) {
      const x = Math.min(marquee.x1, marquee.x2), y = Math.min(marquee.y1, marquee.y2);
      svg.appendChild(svgRect(x, y, Math.abs(marquee.x2 - marquee.x1), Math.abs(marquee.y2 - marquee.y1), { cls: 'el-marquee' }));
    }
  }

  // Only empty page space ever lets a mousedown bubble up to the SVG (every
  // element's own handler stops propagation), so this is the "draw a box"
  // gesture; a press-and-release without dragging just deselects.
  function wireMarquee() {
    document.getElementById('sheet-svg').addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const start = clientToSvg(e.clientX, e.clientY);
      const startClientX = e.clientX, startClientY = e.clientY;
      let dragging = false;
      function onMove(ev) {
        if (!dragging) {
          if (Math.abs(ev.clientX - startClientX) < 3 && Math.abs(ev.clientY - startClientY) < 3) return;
          dragging = true;
        }
        const p = clientToSvg(ev.clientX, ev.clientY);
        marquee = { x1: start.x, y1: start.y, x2: p.x, y2: p.y };
        const bx0 = Math.min(marquee.x1, marquee.x2), bx1 = Math.max(marquee.x1, marquee.x2);
        const by0 = Math.min(marquee.y1, marquee.y2), by1 = Math.max(marquee.y1, marquee.y2);
        selectedIds.clear();
        model.elements.forEach(el => {
          const b = elementBounds(el);
          if (b.x <= bx1 && b.x + b.w >= bx0 && b.y <= by1 && b.y + b.h >= by0) selectedIds.add(el.id);
        });
        renderSvg();
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!dragging) { clearSelection(); return; }
        marquee = null;
        renderSvg();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  /* ---------- drag-vs-click ---------- */
  // `moveEl` is passed only by gestures that move a whole element (not
  // resize/bow/re-pitch handles): if it belongs to a multi-element selection,
  // the drag moves every selected element by the same offset instead of
  // calling `onDrag`; otherwise any existing selection is dropped.
  function wireDragAndClick(hitEl, onDrag, onClick, moveEl) {
    hitEl.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      let groupDrag = null;
      if (moveEl) {
        if (selectedIds.has(moveEl.id) && selectedIds.size > 1) {
          const snaps = model.elements
            .filter(el => selectedIds.has(el.id))
            .map(el => ({ el, snap: snapshotPos(el) }));
          groupDrag = (ddx, ddy) => {
            snaps.forEach(({ el, snap }) => applyOffset(el, snap, ddx, ddy));
            markDirty(); renderSvg();
          };
        } else {
          clearSelection();
        }
      }
      // Captured now, while hitEl is still attached -- onDrag re-renders the
      // whole SVG on every move (detaching hitEl itself), but the SVG
      // container it lived in is never recreated, so this stays valid for
      // the rest of the gesture.
      const ownerSvg = hitEl.ownerSVGElement || document.getElementById('sheet-svg');
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      function onMove(ev) {
        const { scale } = svgMetricsFor(ownerSvg);
        const ddx = (ev.clientX - startX) / scale;
        const ddy = (ev.clientY - startY) / scale;
        if (Math.abs(ddx) > 3 || Math.abs(ddy) > 3) moved = true;
        if (moved) {
          if (groupDrag) groupDrag(ddx, ddy);
          else if (onDrag) onDrag(ddx, ddy);
        }
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

  // Same shape as the resize handle, but moves the whole element instead of
  // scaling it -- used where the element's own body is already claimed by a
  // different drag gesture (a note staff's noteheads drag to re-pitch, so
  // the bar needs its own dedicated way to move).
  function addMoveHandle(g, x, y, onDrag, moveEl) {
    const handle = svgRect(x - 5, y - 5, 10, 10, { cls: 'el-move-handle' });
    wireDragAndClick(handle, onDrag, null, moveEl);
    g.appendChild(handle);
  }

  /* ---------- inline text-edit overlay ---------- */
  let activeOverlay = null;
  // Id of the element whose text is currently being typed into. Its own SVG
  // text is skipped in renderTextEl while the (transparent) overlay input is
  // showing the same text, so it isn't drawn twice.
  let editingId = null;
  function closeOverlay(commit) {
    if (!activeOverlay) return;
    const { input, onCommit, onCancel } = activeOverlay;
    const val = input.value;
    // Clear state before removing the input: removing a focused input fires
    // its blur handler synchronously, which would re-enter closeOverlay.
    activeOverlay = null;
    editingId = null;
    input.remove();
    if (commit) onCommit(val);
    else { if (onCancel) onCancel(); renderSvg(); }
  }
  document.addEventListener('mousedown', e => {
    if (activeOverlay && e.target !== activeOverlay.input) closeOverlay(true);
  }, true);

  // The input is transparent (see .text-edit-input), so it reads as typing
  // directly on the page. `getRect` is re-evaluated on every keystroke so the
  // field tracks the element's auto-fitting box as the text grows; `onInput`
  // lets the caller update the element live; `onCancel` undoes that on Escape.
  function openTextOverlay({ elementId, initialValue, getRect, fontSize, color, align, padX, onInput, onCommit, onCancel }) {
    closeOverlay(true);
    const wrap = document.getElementById('page-wrap');
    const { scale } = svgMetrics();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-edit-input';
    input.value = initialValue;
    input.style.fontSize = `${fontSize * scale}px`;
    input.style.color = color;
    input.style.caretColor = color;
    input.style.textAlign = align;
    input.style.paddingLeft = input.style.paddingRight = `${padX * scale}px`;
    const place = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const rect = getRect(input.value);
      input.style.left = `${rect.left - wrapRect.left}px`;
      input.style.top = `${rect.top - wrapRect.top}px`;
      input.style.width = `${rect.width}px`;
      input.style.height = `${rect.height}px`;
    };
    place();
    wrap.appendChild(input);
    editingId = elementId;
    activeOverlay = { input, onCommit, onCancel };
    input.addEventListener('input', () => {
      onInput(input.value);
      renderSvg();
      place();
    });
    input.focus();
    input.select();
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

  // A row of toggle buttons under a small heading, appended after the
  // duration grid. `items` are `{ glyph (string or node), label, isOn(), onClick() }`;
  // each click applies immediately and re-syncs the pressed states, and the
  // menu stays open so several can be set in one visit.
  function addMenuToggleSection(menu, title, cols, items) {
    const heading = document.createElement('div');
    heading.className = 'rhythm-menu-heading';
    heading.textContent = title;
    const row = document.createElement('div');
    row.className = 'rhythm-menu-row';
    row.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    const sync = () => items.forEach(it => it.btn.classList.toggle('rhythm-menu-item--on', it.isOn()));
    items.forEach(it => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rhythm-menu-item';
      const glyph = document.createElement('span');
      glyph.className = 'rhythm-menu-glyph';
      if (typeof it.glyph === 'string') glyph.textContent = it.glyph;
      else glyph.appendChild(it.glyph);
      const label = document.createElement('span');
      label.className = 'rhythm-menu-label';
      label.textContent = it.label;
      btn.appendChild(glyph);
      btn.appendChild(label);
      btn.addEventListener('click', () => { it.onClick(); sync(); });
      it.btn = btn;
      row.appendChild(btn);
    });
    sync();
    menu.appendChild(heading);
    menu.appendChild(row);
  }
  function articulationIcon(kind) {
    const svg = svgEl('svg', { width: 28, height: 16, viewBox: '0 0 28 16', class: 'rhythm-menu-icon' });
    drawArticulations(svg, { aboveX: 14, aboveY: 15, belowX: 14, belowY: 0 }, [kind], 34);
    return svg;
  }

  const ACCIDENTAL_MENU_OPTIONS = [
    { value: null, code: '', label: 'Key default' },
    { value: 'sharp', code: ACCIDENTAL_CODES.sharp, label: 'Sharp' },
    { value: 'flat', code: ACCIDENTAL_CODES.flat, label: 'Flat' },
    { value: 'natural', code: ACCIDENTAL_CODES.natural, label: 'Natural' },
  ];

  // `opts.onChange()` is called after an in-place change to the cell
  // (articulation / accidental) so the caller can mark dirty and re-render;
  // `opts.accidentals` adds the accidental section (note staff only). Both
  // sections apply to notes only -- a rest just gets the duration grid.
  function openRhythmMenu(clientX, clientY, cells, idx, onApply, opts = {}) {
    closeRhythmMenu();
    const menu = document.createElement('div');
    menu.className = 'rhythm-menu';
    const prior = cells[idx];
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
        const next = rebuildRhythmCells(cells, idx, opt);
        // Changing one note to another keeps its articulations; a rest has none.
        if (opt.type === 'note' && prior.type === 'note' && prior.articulations) {
          next[idx].articulations = [...prior.articulations];
        }
        onApply(next);
        closeRhythmMenu();
      });
      menu.appendChild(btn);
    });
    const changed = () => { if (opts.onChange) opts.onChange(); };
    if (prior.type === 'note') {
      addMenuToggleSection(menu, 'Articulation', 3, ARTICULATION_KINDS.map(k => ({
        glyph: articulationIcon(k.value),
        label: k.label,
        isOn: () => cellHasArticulation(prior, k.value),
        onClick: () => { toggleCellArticulation(prior, k.value); changed(); },
      })));
      if (opts.accidentals) {
        addMenuToggleSection(menu, 'Accidental', 4, ACCIDENTAL_MENU_OPTIONS.map(a => ({
          glyph: a.code,
          label: a.label,
          isOn: () => (prior.accidental || null) === a.value,
          onClick: () => { prior.accidental = a.value; changed(); },
        })));
      }
    }
    document.body.appendChild(menu);
    // Opens to the right of the click (flipping to the left near the window's
    // right edge) so the note being edited stays visible next to it.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const offset = 36;
    let left = clientX + offset;
    if (left + mw > window.innerWidth - 4) left = clientX - offset - mw;
    left = clamp(left, 4, window.innerWidth - mw - 4);
    const top = clamp(clientY - 24, 4, window.innerHeight - mh - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    activeRhythmMenu = menu;
  }

  // Wraps the rhythm menu so a note-staff cell picks up pitch/accidental the
  // same way the machinery already handles duration: a fresh placement (cell
  // had no pitch yet, i.e. it was a rest) defaults to the middle line with no
  // accidental; changing an existing note's duration keeps its pitch and
  // accidental (and, via openRhythmMenu, its articulations) as-is. Clicking or
  // right-clicking a placed note opens this (see renderStaffCells).
  function openStaffMenu(clientX, clientY, cells, idx, onApply, onChange) {
    const prior = cells[idx];
    openRhythmMenu(clientX, clientY, cells, idx, newCells => {
      // Read at pick time, not menu-open time: the accidental toggle in the
      // same menu edits `prior` in place before a duration is chosen.
      const priorPitch = prior.pitch, priorAccidental = prior.accidental;
      const nc = newCells[idx];
      if (nc.type === 'note') {
        nc.pitch = priorPitch != null ? priorPitch : STAFF_DEFAULT_PITCH;
        nc.accidental = priorPitch != null ? (priorAccidental != null ? priorAccidental : null) : null;
      }
      onApply(newCells);
    }, { onChange, accidentals: true });
  }

  function textBoxSize(text, fontSize) {
    const w = Math.max(50, measureTextWidth(text, fontSize) + 16);
    const h = fontSize + 14;
    return { w, h };
  }

  // The clickable/editable number area of a volta bracket, just inside its
  // left hook; grows with the text so longer labels like "1, 2." still fit.
  function voltaTextPad(el) { return el.fontSize * 0.6; }
  function voltaLabelBox(el, text) {
    return { x: el.x, y: el.y, w: Math.max(el.fontSize * 2.3, measureTextWidth(text, el.fontSize) + 2 * voltaTextPad(el)), h: el.h };
  }

  function startTextEdit(elementId) {
    const el = model.elements.find(e => e.id === elementId);
    if (!el) return;
    const fontSize = el.fontSize;
    const original = el.text || '';
    const boxed = el.type === 'title';
    const isVolta = el.type === 'volta';
    openTextOverlay({
      elementId: el.id,
      initialValue: original,
      getRect: val => {
        const { x, y, w, h } = isVolta ? voltaLabelBox(el, val) : { x: el.x, y: el.y, ...textBoxSize(val, fontSize) };
        return svgRectToScreen(x, y, w, h);
      },
      fontSize,
      color: el.type === 'text' ? '#55504a' : '#1a1815',
      align: boxed ? 'center' : 'left',
      padX: boxed ? 0 : (isVolta ? voltaTextPad(el) : 8), // renderTextEl starts unboxed text 8px in from the left edge
      onInput: val => { el.text = val; },
      onCommit: val => { el.text = val; markDirty(); renderSvg(); },
      onCancel: () => { el.text = original; },
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

  // Builds (but doesn't add) the element a palette/builder drag of `type`
  // creates, with its origin at (x, y) -- the point that lands under the
  // cursor on drop. `opts` is the drag payload (bar count, cells, ...).
  // Shared by addElement and by the drag preview, so what you see while
  // dragging is exactly what gets placed.
  function buildElement(type, x, y, opts = {}) {
    if (type === 'title') {
      return { id: uid('el'), type: 'title', x, y, text: 'Section', fontSize: 12 };
    } else if (type === 'row') {
      const n = clamp(parseInt(opts.barCount, 10) || 4, 1, ROW_MAX_BARS);
      const el = { id: uid('el'), type: 'row', x, y, w: Math.min(n * BAR_UNIT, ROW_MAX_W), h: BAR_H, barCount: n };
      if (opts.repeatStart) el.repeatStart = true;
      if (opts.repeatEnd) el.repeatEnd = true;
      return el;
    } else if (type === 'chordText') {
      return { id: uid('el'), type: 'chordText', x, y, text: 'Am', fontSize: 14 };
    } else if (type === 'text') {
      return { id: uid('el'), type: 'text', x, y, text: 'Note', fontSize: 12 };
    } else if (type === 'repeat-start') {
      return { id: uid('el'), type: 'repeat', x, y, w: REPEAT_MARK_W, h: BAR_H, kind: 'start' };
    } else if (type === 'repeat-end') {
      return { id: uid('el'), type: 'repeat', x, y, w: REPEAT_MARK_W, h: BAR_H, kind: 'end' };
    } else if (type === 'volta') {
      return { id: uid('el'), type: 'volta', x, y, w: BAR_UNIT * 2, h: VOLTA_H, text: '1.', fontSize: VOLTA_FONT_SIZE };
    } else if (type === 'arrow') {
      return { id: uid('el'), type: 'arrow', x1: x, y1: y, x2: x + 70, y2: y - 40, bow: { dx: 0, dy: 0 } };
    } else if (type === 'glyph') {
      return { id: uid('el'), type: 'glyph', x, y, code: opts.code || SIMILE_MARK, fontSize: 28 };
    } else if (type === 'rhythmbar') {
      const totalUnits = opts.cells.reduce((s, c) => s + c.duration, 0);
      return {
        id: uid('el'), type: 'rhythmbar', x, y,
        w: totalUnits * 10.5, h: 28, // 10.5px/unit matches the old 16-slot/336px default look
        numerator: opts.numerator || 4, denominator: opts.denominator || 4,
        cells: JSON.parse(JSON.stringify(opts.cells)),
      };
    } else if (type === 'notestaff') {
      const totalUnits = opts.cells.reduce((s, c) => s + c.duration, 0);
      return {
        id: uid('el'), type: 'notestaff', x, y,
        w: totalUnits * 10.5, h: 40,
        numerator: opts.numerator || 4, denominator: opts.denominator || 4,
        clef: opts.clef || 'treble', keySignature: opts.keySignature || 0,
        cells: JSON.parse(JSON.stringify(opts.cells)),
      };
    }
    return null;
  }

  function addElement(type, x, y, opts) {
    const el = buildElement(type, x, y, opts);
    if (!el) return;
    // A dropped row is kept within the page margins (a full-width row can
    // only sit at the left margin).
    if (el.type === 'row') el.x = clamp(el.x, PAGE_MARGIN, PAGE_W - PAGE_MARGIN - el.w);
    model.elements.push(el);
    markDirty();
    render();
    if (type === 'title' || type === 'chordText' || type === 'text') {
      setTimeout(() => startTextEdit(el.id), 0);
    }
  }

  // Copies everything currently marked, a little down and to the right of the
  // originals, and marks the copies instead -- so the next drag (or another
  // duplicate) acts on them and the originals stay put.
  const DUPLICATE_OFFSET = 20;
  function duplicateSelection() {
    const copies = model.elements.filter(el => selectedIds.has(el.id)).map(el => {
      const copy = JSON.parse(JSON.stringify(el));
      copy.id = uid('el');
      applyOffset(copy, snapshotPos(copy), DUPLICATE_OFFSET, DUPLICATE_OFFSET);
      return copy;
    });
    if (!copies.length) return;
    model.elements.push(...copies);
    selectedIds.clear();
    copies.forEach(c => selectedIds.add(c.id));
    markDirty(); render();
  }

  function removeElement(id) {
    model.elements = model.elements.filter(e => e.id !== id);
    selectedIds.delete(id);
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

    if (el.id !== editingId) {
      const textX = opts.boxed ? el.x + w / 2 : el.x + 8;
      g.appendChild(svgText(el.text || '', textX, el.y + h / 2 + fontSize * 0.35, {
        cls: opts.textCls, anchor: opts.boxed ? 'middle' : 'start', size: fontSize,
      }));
    }

    const startX = el.x, startY = el.y;
    wireDragAndClick(interactiveEl,
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      () => startTextEdit(el.id), el);

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
    wireDragAndClick(hit, (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); }, null, el);

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
      if (el.barCount < ROW_MAX_BARS) { el.barCount += 1; markDirty(); renderSvg(); }
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
      () => { el.kind = el.kind === 'start' ? 'end' : 'start'; markDirty(); renderSvg(); }, el);

    const startW = w, startH = h;
    addResizeHandle(g, el.x + w, el.y + h, (ddx, ddy) => {
      el.w = clamp(startW + ddx, 10, 60);
      el.h = clamp(startH + ddy, 16, 200);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, el.y, w);
    svg.appendChild(g);
  }

  // A volta ("1st/2nd ending") bracket: a line along the top with a hook down
  // at the left, open at the right, and an editable number tucked under the
  // line. Only the bracket line and the number are grabbable, so the empty
  // space inside stays clear for whatever sits beneath it.
  function renderVoltaEl(svg, el) {
    const { w, h } = el;
    const g = svgGroup({ cls: 'el-group' });
    const d = `M ${el.x} ${el.y + h} L ${el.x} ${el.y} L ${el.x + w} ${el.y}`;
    g.appendChild(svgPath(d, { cls: 'el-volta-line' }));

    const startX = el.x, startY = el.y;
    const moveTo = (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); };
    wireDragAndClick(g.appendChild(svgPath(d, { cls: 'el-arrow-hit' })), moveTo, null, el);

    const box = voltaLabelBox(el, el.text);
    const label = g.appendChild(svgRect(box.x, box.y, box.w, box.h, { cls: 'el-text-hit' }));
    wireDragAndClick(label, moveTo, () => startTextEdit(el.id), el);
    if (el.id !== editingId) {
      g.appendChild(svgText(el.text || '', el.x + voltaTextPad(el), el.y + h / 2 + el.fontSize * 0.35 + 1, {
        cls: 'el-volta-text', size: el.fontSize,
      }));
    }

    const startW = w, startH = h;
    addResizeHandle(g, el.x + w, el.y + h, (ddx, ddy) => {
      el.w = clamp(startW + ddx, 16, PAGE_W);
      el.h = clamp(startH + ddy, 10, 60);
      // The number scales with the bracket's height, so shrinking the corner
      // shrinks the whole volta rather than cramping a full-size number.
      el.fontSize = clamp(Math.round(el.h * VOLTA_FONT_SIZE / VOLTA_H), 6, 32);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, el.y - 6, w);
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
    }, null, el);

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
    wireDragAndClick(hit, (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); }, null, el);

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
    const wholeNote = cell.duration === 32 || cell.duration === 48;
    drawArticulations(container, {
      aboveX: wholeNote ? nx + headW / 2 : stemX,
      aboveY: wholeNote ? y - headW * 0.38 - h * 0.05 : y - stemLen,
      belowX: nx + headW / 2,
      belowY: y + headW * 0.38 + h * 0.05,
    }, cell.articulations, h * 1.2);
    if (wholeNote) return; // whole notes: no stem
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

  // Groups indices of `cells` into beam runs: consecutive beam-eligible
  // notes (per BEAM_ELIGIBLE_DURATIONS) that don't cross a beat boundary
  // (beatUnits 32nds, per the bar's time signature). Shared by the rhythm
  // tool's rhythm-only beaming and the note staff's pitched beaming.
  // Dotted-8th notes beam together with 8ths/16ths too -- the classic
  // "dotted-eighth + sixteenth" pattern is always beamed in standard
  // notation. Beams never cross from one beat into the next, even if the
  // notes on either side would otherwise be beam-eligible and adjacent -- so
  // a run also breaks at every beat boundary, not just at rests/long notes.
  function computeBeamRuns(cells, positions, beatUnits) {
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
    return { runs, runOf };
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
  function renderRhythmCells(container, cells, x, y, w, h, onCellClick, onCellDrag, beatUnits, moveEl) {
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
    // The 16th's partial second beam back toward a dotted-8th neighbor is
    // handled below (only plain 16ths count toward the secondary-beam
    // connections); which cells beam together at all comes from the shared
    // beat-boundary-aware grouping in computeBeamRuns.
    const { runOf } = computeBeamRuns(cells, positions, beatUnits);

    cells.forEach((cell, i) => {
      const cellX = x + positionsPx[i];
      const cellW = cellWidths[i];
      const hit = svgRect(cellX, beamY - beamThick - 4, cellW, (y - beamY) + beamThick + h * 0.9, { cls: 'el-rhythm-cell-hit' });
      container.appendChild(hit);
      if (onCellDrag) wireDragAndClick(hit, onCellDrag, (clientX, clientY) => onCellClick(i, clientX, clientY), moveEl);
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
            drawArticulations(container, {
              aboveX: stemX, aboveY: beamY - beamThick / 2,
              belowX: nx + headW / 2, belowY: noteY + headW * 0.38 + h * 0.05,
            }, cells[k].articulations, h * 1.2);
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
      }, { onChange: () => { markDirty(); renderSvg(); } }),
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      barBeatUnits(el.denominator || 4), el);

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

  /* ---------- note staff (pitched notation) rendering ---------- */
  function drawStaffLines(container, el) {
    const lineGap = el.h / 4;
    const fullW = notestaffLeadWidth(el) + el.w;
    for (let i = 0; i < 5; i++) {
      const ly = el.y + i * lineGap;
      container.appendChild(svgLine(el.x, ly, el.x + fullW, ly, { cls: 'el-staff-line' }));
    }
  }

  // 1 em == the staff's full height, but neither clef anchors on the bottom
  // line in this font: the treble clef's coil is designed to wrap the G
  // line (step 2, 2nd from bottom), and the bass clef's two dots straddle
  // the F line (step 6, 2nd from top) -- anchoring either on the bottom
  // line instead pulls the whole glyph down past where it belongs.
  // Verified empirically against the font's own glyph metrics, not just by
  // convention (this font's clefs don't follow the common bottom-line-anchor
  // convention other SMuFL fonts use).
  const CLEF_ANCHOR_POSITION = { treble: 2, bass: 6 };
  function drawClef(container, el) {
    container.appendChild(svgText(CLEF_CODES[el.clef], el.x + NOTESTAFF_CLEF_W / 2, pitchToY(CLEF_ANCHOR_POSITION[el.clef], el), {
      cls: 'el-notestaff-clef', anchor: 'middle', size: el.h,
    }));
  }

  function drawKeySignature(container, el) {
    const k = el.keySignature;
    if (!k) return;
    const kind = k > 0 ? 'sharp' : 'flat';
    const positions = KEYSIG_GLYPH_POSITIONS[el.clef][kind].slice(0, Math.abs(k));
    const startX = el.x + NOTESTAFF_CLEF_W;
    positions.forEach((pos, i) => {
      container.appendChild(svgText(ACCIDENTAL_CODES[kind], startX + i * KEYSIG_GLYPH_STEP_PX, pitchToY(pos, el), {
        cls: 'el-notestaff-keysig', anchor: 'middle', size: el.h * 0.65,
      }));
    });
  }

  function drawLedgerLines(container, el, cx, position, halfLen) {
    ledgerStepsFor(position).forEach(s => {
      container.appendChild(svgLine(cx - halfLen, pitchToY(s, el), cx + halfLen, pitchToY(s, el), { cls: 'el-ledger-line' }));
    });
  }

  // Sibling of renderRhythmCells: real pitched noteheads (the font's actual
  // notehead/clef/accidental glyphs, not the rhythm tool's hand-drawn slash)
  // positioned per-cell by pitch (staff step) rather than one fixed
  // baseline. Cell x-layout/width/duration mechanics (allocateCellWidths,
  // beat-boundary beam runs) are identical to the rhythm tool -- only what's
  // drawn at each cell, and its vertical position, differ.
  //
  // Like the rhythm tool, a note is anchored at the start of its cell, not
  // centered in it, so it never shifts when its own or a neighbor's duration
  // changes: it sits at the centre of a 16th-sized slot, which is exactly
  // where a 16th rest in that cell is drawn. (Rests are picked fresh from the
  // menu, never resized in place, so they stay centered in their span.)
  //
  // Only a note's head is grabbable (not its whole column), and the staff
  // itself is grabbable anywhere else -- lines, clef, rests -- to move it.
  // `callbacks` is `{ onCellMenu(idx,clientX,clientY),
  // onNoteDrag(idx, ddy, startPitch), onMove(ddx, ddy) }` -- onMove is
  // optional (the sidebar builder preview has nothing to move). A rest fires
  // onCellMenu on a plain click and moves the staff on a drag; a note fires
  // onCellMenu on a plain click or right-click (duration, accidental and
  // articulation, preserving pitch -- see openStaffMenu) and onNoteDrag while
  // dragging (re-pitch, snapped to the staff-step grid).
  function renderStaffCells(container, cells, x, y, w, el, callbacks) {
    const totalUnits = cells.reduce((s, c) => s + c.duration, 0);
    const cellWidths = allocateCellWidths(cells, w);
    let cursorPx = 0;
    const positionsPx = cellWidths.map(cw => { const p = cursorPx; cursorPx += cw; return p; });
    let cursor = 0;
    const positions = cells.map(c => { const p = cursor; cursor += c.duration; return p; });
    const { runOf } = computeBeamRuns(cells, positions, barBeatUnits(el.denominator || 4));

    const noteSize = el.h * 0.65;
    const stemLen = el.h * 0.68;
    const beamThick = el.h * 0.12;
    const beamGap = el.h * 0.16;
    const midlineY = pitchToY(4, el);
    const stemHalf = NOTESTAFF_STEM_W / 2;

    const slotW = 2 * w / totalUnits;
    const noteCx = k => x + positionsPx[k] + Math.min(cellWidths[k], slotW) / 2;
    const restCx = k => x + positionsPx[k] + cellWidths[k] / 2;
    const pitchOf = k => (cells[k].pitch != null ? cells[k].pitch : STAFF_DEFAULT_PITCH);
    const halfWOf = k => noteheadHalfW(cells[k].duration, noteSize);
    // The stem sits on the head's right edge going up, left edge going down
    // (pulled in by half its own width so it overlaps the head instead of
    // leaving a hairline gap), and starts slightly off-center like a real
    // engraved stem does.
    const stemXOf = (k, up) => noteCx(k) + (up ? 1 : -1) * (halfWOf(k) - stemHalf);
    const stemStartYOf = (k, up) => pitchToY(pitchOf(k), el) + (up ? -1 : 1) * noteSize * 0.04;

    if (callbacks.onMove) {
      const body = svgRect(el.x, el.y - el.h * 0.35, x + w - el.x, el.h * 1.7, { cls: 'el-row-hit' });
      container.appendChild(body);
      wireDragAndClick(body, callbacks.onMove, null, el);
    }

    cells.forEach((cell, i) => {
      if (cell.type === 'rest') {
        const hit = svgRect(x + positionsPx[i], el.y - el.h * 0.25, cellWidths[i], el.h * 1.5, { cls: 'el-rhythm-cell-hit' });
        container.appendChild(hit);
        const pick = (clientX, clientY) => callbacks.onCellMenu(i, clientX, clientY);
        if (callbacks.onMove) wireDragAndClick(hit, callbacks.onMove, pick, el);
        else hit.addEventListener('click', e => pick(e.clientX, e.clientY));
        return;
      }
      const hitW = Math.max(halfWOf(i) * 2 * 1.6, 12), hitH = el.h * 0.35;
      const hit = svgRect(noteCx(i) - hitW / 2, pitchToY(pitchOf(i), el) - hitH / 2, hitW, hitH, { cls: 'el-note-hit' });
      container.appendChild(hit);
      hit.addEventListener('contextmenu', e => { e.preventDefault(); callbacks.onCellMenu(i, e.clientX, e.clientY); });
      // Captured once per render (i.e. once per gesture -- a drag's own
      // mousemove/mouseup listeners outlive the re-renders it triggers, so
      // this closure, not any later one, is what actually keeps firing).
      // onNoteDrag must apply ddy against this fixed value, never against
      // the cell's current (already-mutated-mid-drag) pitch, or each tick
      // would compound on top of the last instead of tracking the cursor.
      const dragStartPitch = pitchOf(i);
      wireDragAndClick(hit,
        (ddx, ddy) => callbacks.onNoteDrag(i, ddy, dragStartPitch),
        (clientX, clientY) => callbacks.onCellMenu(i, clientX, clientY));
    });

    const handledRunStarts = new Set();
    // Where each note's articulations go (see drawArticulations): its highest
    // and lowest ink -- the stem tip / beam on whichever side the stem points,
    // else the notehead -- and the x to center on at each end.
    const articulationAnchor = new Map();
    const headTopY = k => pitchToY(pitchOf(k), el) - el.h / 8;
    const headBottomY = k => pitchToY(pitchOf(k), el) + el.h / 8;
    cells.forEach((cell, i) => {
      if (cell.type === 'rest') {
        container.appendChild(svgText(rhythmCellGlyph(cell), restCx(i), midlineY, { cls: 'el-glyph-text', anchor: 'middle', size: el.h * 0.75 }));
        return;
      }
      const cx = noteCx(i), halfW = halfWOf(i);
      const pitch = pitchOf(i);
      const noteY = pitchToY(pitch, el);
      drawLedgerLines(container, el, cx, pitch, halfW + noteSize * 0.1);

      if (cell.accidental) {
        container.appendChild(svgText(ACCIDENTAL_CODES[cell.accidental], cx - halfW - noteSize * 0.14, noteY, {
          cls: 'el-notestaff-accidental', anchor: 'end', size: noteSize,
        }));
      }
      container.appendChild(svgText(noteheadCode(cell.duration), cx, noteY, {
        cls: `el-notehead-oval ${cell.duration >= 16 ? 'el-notehead-oval-open' : 'el-notehead-oval-filled'}`,
        anchor: 'middle', size: noteSize,
      }));
      if (cell.duration === 6 || cell.duration === 12 || cell.duration === 24 || cell.duration === 48) {
        // A note on a line gets its dot in the space above, like engraved
        // music, not struck through by the line.
        const dotY = pitch % 2 === 0 ? noteY - el.h / 8 : noteY;
        container.appendChild(svgText(AUG_DOT, cx + halfW + noteSize * 0.1, dotY, { cls: 'el-glyph-text', size: noteSize }));
      }
      if (cell.duration === 32 || cell.duration === 48) { // whole notes: no stem
        articulationAnchor.set(i, { aboveX: cx, aboveY: headTopY(i), belowX: cx, belowY: headBottomY(i) });
        return;
      }

      const run = runOf.get(i);
      if (run && run.end > run.start) {
        if (handledRunStarts.has(run.start)) return;
        handledRunStarts.add(run.start);
        const runCells = cells.slice(run.start, run.end + 1);
        const avgPitch = runCells.reduce((s, c, k) => s + pitchOf(run.start + k), 0) / runCells.length;
        const stemUp = avgPitch < 4;
        const extremePitch = stemUp
          ? Math.max(...runCells.map((c, k) => pitchOf(run.start + k)))
          : Math.min(...runCells.map((c, k) => pitchOf(run.start + k)));
        const beamY = pitchToY(extremePitch, el) + (stemUp ? -stemLen : stemLen);
        const stemXs = [];
        for (let k = run.start; k <= run.end; k++) {
          const stemX = stemXOf(k, stemUp);
          stemXs.push(stemX);
          container.appendChild(svgLine(stemX, stemStartYOf(k, stemUp), stemX, beamY, { cls: 'el-notegroup-stem' }));
          articulationAnchor.set(k, stemUp
            ? { aboveX: stemX, aboveY: beamY - beamThick / 2, belowX: noteCx(k), belowY: headBottomY(k) }
            : { aboveX: noteCx(k), aboveY: headTopY(k), belowX: stemX, belowY: beamY + beamThick / 2 });
        }
        // Beams run out to the stems' outer edges so they cover the stem ends.
        const primary = svgLine(stemXs[0] - stemHalf, beamY, stemXs[stemXs.length - 1] + stemHalf, beamY, { cls: 'el-notegroup-beam' });
        primary.setAttribute('stroke-width', beamThick);
        container.appendChild(primary);

        const beam2Y = beamY + (stemUp ? beamGap : -beamGap);
        const stubLen = (cellWidths[run.start] || 8) * 0.6;
        let sStart = null;
        const stretches = [];
        for (let k = 0; k <= runCells.length; k++) {
          const is16 = k < runCells.length && runCells[k].duration === 2;
          if (is16) { if (sStart === null) sStart = k; }
          else if (sStart !== null) { stretches.push({ start: sStart, end: k - 1 }); sStart = null; }
        }
        stretches.forEach(sr => {
          if (sr.end > sr.start) {
            const seg = svgLine(stemXs[sr.start] - stemHalf, beam2Y, stemXs[sr.end] + stemHalf, beam2Y, { cls: 'el-notegroup-beam' });
            seg.setAttribute('stroke-width', beamThick);
            container.appendChild(seg);
          } else {
            const dir = sr.start < runCells.length - 1 ? 1 : -1;
            const stub = svgLine(stemXs[sr.start] - dir * stemHalf, beam2Y, stemXs[sr.start] + dir * stubLen, beam2Y, { cls: 'el-notegroup-beam' });
            stub.setAttribute('stroke-width', beamThick);
            container.appendChild(stub);
          }
        });
      } else {
        const stemUp = pitch < 4;
        const stemX = stemXOf(i, stemUp);
        const stemTipY = stemUp ? noteY - stemLen : noteY + stemLen;
        container.appendChild(svgLine(stemX, stemStartYOf(i, stemUp), stemX, stemTipY, { cls: 'el-notegroup-stem' }));
        articulationAnchor.set(i, stemUp
          ? { aboveX: stemX, aboveY: stemTipY, belowX: cx, belowY: headBottomY(i) }
          : { aboveX: cx, aboveY: headTopY(i), belowX: stemX, belowY: stemTipY });
        if (cell.duration === 2 || cell.duration === 4 || cell.duration === 6) {
          const flagCode = cell.duration === 2
            ? (stemUp ? FLAG_CODES['16th-up'] : FLAG_CODES['16th-down'])
            : (stemUp ? FLAG_CODES['8th-up'] : FLAG_CODES['8th-down']);
          container.appendChild(svgText(flagCode, stemX - stemHalf, stemTipY, { cls: 'el-notestaff-flag', anchor: 'start', size: noteSize }));
        }
      }
    });

    articulationAnchor.forEach((a, i) => {
      drawArticulations(container, a, cells[i].articulations, el.h * 0.85);
    });

    return {
      topY: pitchToY(STAFF_PITCH_MAX, el) - el.h * 0.3,
      bottomY: pitchToY(STAFF_PITCH_MIN, el) + el.h * 0.3,
    };
  }

  function renderNoteStaffEl(svg, el) {
    const g = svgGroup({ cls: 'el-group' });
    const startX = el.x, startY = el.y;
    const startW = el.w, startH = el.h;
    const leadW = notestaffLeadWidth(el);
    const moveTo = (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); };

    drawStaffLines(g, el);
    drawClef(g, el);
    drawKeySignature(g, el);

    const { topY, bottomY } = renderStaffCells(g, el.cells, el.x + leadW, el.y, el.w, el, {
      onCellMenu: (idx, clientX, clientY) => {
        openStaffMenu(clientX, clientY, el.cells, idx,
          newCells => { el.cells = newCells; markDirty(); renderSvg(); },
          () => { markDirty(); renderSvg(); });
      },
      onNoteDrag: (idx, ddy, startPitch) => {
        const deltaSteps = Math.round(-ddy / (el.h / 8));
        el.cells[idx].pitch = clamp(startPitch + deltaSteps, STAFF_PITCH_MIN, STAFF_PITCH_MAX);
        markDirty(); renderSvg();
      },
      onMove: moveTo,
    });

    addMoveHandle(g, el.x - 8, el.y + el.h / 2, moveTo, el);

    // Width and height are independent, same as the rhythm bar's resize
    // handle -- width re-spaces cells, height rescales note/staff size.
    addResizeHandle(g, el.x + leadW + el.w, bottomY, (ddx, ddy) => {
      el.w = clamp(startW + ddx, rhythmBarMinWidth(el.cells), PAGE_W - leadW);
      el.h = clamp(startH + ddy, 24, 160);
      markDirty(); renderSvg();
    });

    addDeleteButton(g, el, el.x, topY, leadW + el.w);
    svg.appendChild(g);
  }

  function renderElement(svg, el) {
    if (el.type === 'title') renderTextEl(svg, el, { boxed: true, textCls: 'el-title-text' });
    else if (el.type === 'chordText') renderTextEl(svg, el, { boxed: false, textCls: 'el-chord-text' });
    else if (el.type === 'text') renderTextEl(svg, el, { boxed: false, textCls: 'el-text-text' });
    else if (el.type === 'row') renderRowEl(svg, el);
    else if (el.type === 'repeat') renderRepeatEl(svg, el);
    else if (el.type === 'volta') renderVoltaEl(svg, el);
    else if (el.type === 'arrow') renderArrowEl(svg, el);
    else if (el.type === 'glyph') renderGlyphEl(svg, el);
    else if (el.type === 'rhythmbar') renderRhythmBarEl(svg, el);
    else if (el.type === 'notestaff') renderNoteStaffEl(svg, el);
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
    drawSelectionOverlay(svg);
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
  // Starts a drag of `payload` (what the page's drop handler reads). The drag
  // image is the element rendered exactly as it will look once placed -- same
  // renderer, same on-screen size as on the page -- with the cursor on the
  // point that becomes its origin, so it's easy to line up before dropping.
  function startPlacementDrag(e, payload) {
    e.dataTransfer.setData('text/plain', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
    const el = buildElement(payload.type, 0, 0, payload);
    if (!el) return;
    const { scale } = svgMetrics();
    const svg = svgEl('svg', { xmlns: SVG_NS, width: 1, height: 1 });
    svg.style.cssText = 'position:fixed;left:-10000px;top:0;overflow:visible;pointer-events:none';
    const root = svgGroup();
    svg.appendChild(root);
    renderElement(root, el);
    document.body.appendChild(svg);
    try {
      const bb = root.getBBox();
      const pad = 3;
      const vx = bb.x - pad, vy = bb.y - pad, vw = bb.width + 2 * pad, vh = bb.height + 2 * pad;
      svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
      svg.setAttribute('width', vw * scale);
      svg.setAttribute('height', vh * scale);
      e.dataTransfer.setDragImage(svg, -vx * scale, -vy * scale);
    } finally {
      setTimeout(() => svg.remove(), 0);
    }
  }

  function wirePaletteDrag(tile) {
    tile.addEventListener('dragstart', e => {
      startPlacementDrag(e, { type: tile.dataset.type, code: tile.dataset.code || null });
    });
  }
  document.querySelectorAll('.palette-tile').forEach(wirePaletteDrag);

  wireMarquee();
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && selectedIds.size) { selectedIds.clear(); renderSvg(); }
    // Cmd/Ctrl+D duplicates the marked elements (and keeps the browser from
    // bookmarking the page). Left alone while typing in any field.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && selectedIds.size) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      e.preventDefault();
      duplicateSelection();
    }
  });

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
    if (payload.type === 'repeat-start' || payload.type === 'repeat-end') {
      const row = findRowAt(x, y);
      if (row) {
        if (payload.type === 'repeat-start') row.repeatStart = true;
        else row.repeatEnd = true;
        markDirty(); render();
        return;
      }
    }
    addElement(payload.type, x, y, payload);
  });

  /* ---------- bars builder ---------- */
  // Type a bar count (and optionally tick repeat start/end), then drag the
  // preview onto the page as a row of that many bars with those repeat marks
  // already attached. The count is read again at drag time, so a value typed
  // but not yet committed (blur/Enter) still counts.
  const barsCountInput = document.getElementById('bars-count');
  const barsRepeatStart = document.getElementById('bars-repeat-start');
  const barsRepeatEnd = document.getElementById('bars-repeat-end');
  const BARS_PREVIEW_W = 240, BARS_PREVIEW_H = 44;
  function barsBuilderCount() {
    return clamp(parseInt(barsCountInput.value, 10) || 4, 1, ROW_MAX_BARS);
  }
  function renderBarsBuilderSvg() {
    const svg = document.getElementById('bars-builder-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const n = barsBuilderCount();
    const padX = 8, top = 8, h = BARS_PREVIEW_H - 16;
    const barW = (BARS_PREVIEW_W - 2 * padX) / n;
    for (let i = 0; i <= n; i++) {
      if (i === 0 && barsRepeatStart.checked) continue; // repeat mark replaces the plain barline, as on the page
      if (i === n && barsRepeatEnd.checked) continue;
      svg.appendChild(svgHandDrawnBarline(padX + i * barW, top, h, seedFromString(`bars-preview-${i}`), 'el-row-divider'));
    }
    if (barsRepeatStart.checked) drawRepeatMark(svg, padX, top, REPEAT_MARK_W, h, 'start', 'bars-preview-repeatStart');
    if (barsRepeatEnd.checked) drawRepeatMark(svg, BARS_PREVIEW_W - padX - REPEAT_MARK_W, top, REPEAT_MARK_W, h, 'end', 'bars-preview-repeatEnd');
    svg.setAttribute('viewBox', `0 0 ${BARS_PREVIEW_W} ${BARS_PREVIEW_H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }
  renderBarsBuilderSvg();
  barsCountInput.addEventListener('input', renderBarsBuilderSvg);
  barsCountInput.addEventListener('change', () => {
    barsCountInput.value = barsBuilderCount();
    renderBarsBuilderSvg();
  });
  barsRepeatStart.addEventListener('change', renderBarsBuilderSvg);
  barsRepeatEnd.addEventListener('change', renderBarsBuilderSvg);
  document.getElementById('bars-builder-drag').addEventListener('dragstart', e => {
    startPlacementDrag(e, {
      type: 'row', barCount: barsBuilderCount(),
      repeatStart: barsRepeatStart.checked, repeatEnd: barsRepeatEnd.checked,
    });
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
      }, { onChange: renderBuilderSvg }),
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
    startPlacementDrag(e, {
      type: 'rhythmbar', cells: builderCells, numerator: builderNumerator, denominator: builderDenominator,
    });
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

  /* ---------- note staff builder ---------- */
  // Same idea as the rhythm bar builder above, plus clef and key-signature
  // controls. Unlike the rhythm builder (click-only, since a rhythm cell has
  // no drag of its own), this preview is fully interactive -- dragging a
  // note re-pitches it and clicking one opens the accidental menu, exactly
  // like the on-page version -- since there's no reason to restrict that
  // here.
  let staffBuilderNumerator = 4, staffBuilderDenominator = 4;
  let staffBuilderClef = 'treble';
  let staffBuilderKeySignature = 0;
  let staffBuilderCells = defaultRhythmCells(barTotalUnits(staffBuilderNumerator, staffBuilderDenominator));
  const STAFF_BUILDER_H = 40;
  const STAFF_BUILDER_UNIT_PX = 7.5;

  function renderStaffBuilderSvg() {
    const svg = document.getElementById('notestaff-builder-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const builderW = barTotalUnits(staffBuilderNumerator, staffBuilderDenominator) * STAFF_BUILDER_UNIT_PX;
    const builderEl = {
      x: 10, y: 40, h: STAFF_BUILDER_H, w: builderW,
      clef: staffBuilderClef, keySignature: staffBuilderKeySignature, denominator: staffBuilderDenominator,
    };
    const leadW = notestaffLeadWidth(builderEl);

    drawStaffLines(svg, builderEl);
    drawClef(svg, builderEl);
    drawKeySignature(svg, builderEl);
    renderStaffCells(svg, staffBuilderCells, builderEl.x + leadW, builderEl.y, builderW, builderEl, {
      onCellMenu: (idx, clientX, clientY) => {
        openStaffMenu(clientX, clientY, staffBuilderCells, idx,
          newCells => { staffBuilderCells = newCells; renderStaffBuilderSvg(); },
          renderStaffBuilderSvg);
      },
      onNoteDrag: (idx, ddy, startPitch) => {
        const deltaSteps = Math.round(-ddy / (STAFF_BUILDER_H / 8));
        staffBuilderCells[idx].pitch = clamp(startPitch + deltaSteps, STAFF_PITCH_MIN, STAFF_PITCH_MAX);
        renderStaffBuilderSvg();
      },
    });

    const vbW = leadW + builderW + 14;
    svg.setAttribute('viewBox', `0 0 ${vbW} 120`);
    svg.setAttribute('width', vbW);
    svg.setAttribute('height', 120);
    svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  }
  renderStaffBuilderSvg();

  document.getElementById('staff-builder-drag').addEventListener('dragstart', e => {
    startPlacementDrag(e, {
      type: 'notestaff', cells: staffBuilderCells, numerator: staffBuilderNumerator, denominator: staffBuilderDenominator,
      clef: staffBuilderClef, keySignature: staffBuilderKeySignature,
    });
  });
  document.getElementById('staff-builder-reset').addEventListener('click', () => {
    staffBuilderCells = defaultRhythmCells(barTotalUnits(staffBuilderNumerator, staffBuilderDenominator));
    renderStaffBuilderSvg();
  });
  function wireStaffTimeSigInput(id, apply) {
    document.getElementById(id).addEventListener('change', e => {
      const v = clamp(parseInt(e.target.value, 10) || 4, 1, 32);
      e.target.value = v;
      apply(v);
      staffBuilderCells = defaultRhythmCells(barTotalUnits(staffBuilderNumerator, staffBuilderDenominator));
      renderStaffBuilderSvg();
    });
  }
  wireStaffTimeSigInput('staff-time-num', v => { staffBuilderNumerator = v; });
  wireStaffTimeSigInput('staff-time-den', v => { staffBuilderDenominator = v; });
  document.getElementById('staff-clef').addEventListener('change', e => {
    staffBuilderClef = e.target.value;
    renderStaffBuilderSvg();
  });
  document.getElementById('staff-keysig').addEventListener('change', e => {
    staffBuilderKeySignature = parseInt(e.target.value, 10) || 0;
    renderStaffBuilderSvg();
  });

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
