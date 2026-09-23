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
  const ROW_MAX_CHORDS = 8; // chord slots per bar
  const ROW_MAX_W = PAGE_W - 2 * PAGE_MARGIN;
  const BAR_H = 27; // average bar-row height across the hand-finished test sheet
  const REPEAT_MARK_W = 14;
  const REST_SIZE = 0.6; // a "-" rest's glyph size as a fraction of the row height; full size dwarfs the chords
  const SLOT_CHORD_PAD = 5; // gap between a slot's left edge and the chord in it, in bars with several slots
  const SLOT_CHORD_OVERHANG = 4; // how far the last chord of a crowded bar may run past its barline
  const VOLTA_W = 50, VOLTA_H = 14, VOLTA_FONT_SIZE = 8;
  // Starting font sizes for new text boxes: the averages from the test sheet.
  const TITLE_FONT_SIZE = 17, CHORD_FONT_SIZE = 14, TEXT_FONT_SIZE = 12;

  // Codepoints verified directly against fonts/MuseJazz.otf's cmap (this
  // font implements SMuFL's Rests range at the standard codepoints, but not
  // the "Individual notes" range -- notes instead use its Metronome Marks
  // glyphs, which are the same complete notehead+stem+flag shapes).
  const NOTE_CODES = {
    whole: '\uECA2', half: '\uECA3', quarter: '\uECA5', '8th': '\uECA7', '16th': '\uECA9',
  };
  const AUG_DOT = '\uECB7';
  const SIMILE_MARK = '\uE500';
  // A free-floating glyph (currently just the fermata tile) is drawn a bit
  // wider and shorter than its font glyph, so it reads better sitting over a
  // chord than the font's own proportions do.
  const GLYPH_SCALE_X = 1.15, GLYPH_SCALE_Y = 0.8;
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
  // A triplet (or any "N in the time of N-1" tuplet -- only N=3 is offered
  // today): a single cell in the flat `cells` array, so every place that
  // already treats a cell as an opaque `{ duration }` -- bar-total math,
  // allocateCellWidths' weighting, rebuildRhythmCells' splicing/padding,
  // splitStaffBars -- keeps working unchanged. `unit` is the notated shape
  // of each sub-note (4 = eighth, 8 = quarter -- the same duration values a
  // plain note of that shape already uses, so the existing glyph code needs
  // no new cases for them); `duration` (= unit * 2) is what the group's
  // *own* slot is worth in the bar, i.e. what two plain notes of that shape
  // would normally take. Starts filled with rests, same as a fresh bar.
  function makeTupletCell(unit, count = 3) {
    return {
      type: 'tuplet', unit, count, duration: unit * 2,
      cells: Array.from({ length: count }, () => ({ type: 'rest', duration: unit })),
    };
  }
  // A note staff holds up to STAFF_MAX_BARS bars sharing one time signature;
  // its flat `cells` list runs bar after bar and no cell crosses a barline.
  // A fresh rhythm bar or staff is filled with one rest per beat (not 16ths):
  // 16 sixteenth rests need more width (RHYTHM_MIN_CELL_PX each) than the
  // standard bar size, or the builder preview, has.
  const STAFF_MAX_BARS = 4;
  const NOTESTAFF_DEFAULT_H = 30;
  const NOTESTAFF_DEFAULT_BAR_W = 100; // W of one 4/4 bar, so a 4-bar staff is 400 (the edit box's W, clef and key not counted)
  const RHYTHMBAR_DEFAULT_H = 20, RHYTHMBAR_DEFAULT_W = 70; // a placed rhythm bar, W for 4/4
  function staffBarCount(el) { return clamp(Math.round(el.bars) || 1, 1, STAFF_MAX_BARS); }
  function staffBarUnits(el) { return barTotalUnits(el.numerator || 4, el.denominator || 4); }
  function defaultBeatCells(numerator, denominator, bars) {
    const beat = barBeatUnits(denominator);
    // Only the beats that have a rest glyph (whole down to 16th); anything else
    // falls back to 16th rests.
    if (![2, 4, 8, 16, 32].includes(beat)) return defaultRhythmCells(barTotalUnits(numerator, denominator) * bars);
    return Array.from({ length: numerator * bars }, () => ({ type: 'rest', duration: beat }));
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
    { type: 'rest', duration: 6, label: 'Dotted 8th rest' },
    { type: 'rest', duration: 8, label: 'Quarter rest' },
    { type: 'rest', duration: 12, label: 'Dotted quarter rest' },
    { type: 'rest', duration: 16, label: 'Half rest' },
    { type: 'rest', duration: 32, label: 'Whole rest' },
    { type: 'triplet', unit: 4, duration: 8, label: 'Eighth-note triplet' },
    { type: 'triplet', unit: 8, duration: 16, label: 'Quarter-note triplet' },
  ];
  function rhythmMenuOptionsFor(cells, idx) {
    const totalUnits = cells.reduce((s, c) => s + c.duration, 0);
    const pos = cells.slice(0, idx).reduce((s, c) => s + c.duration, 0);
    return RHYTHM_MENU_OPTIONS.filter(o => o.duration <= totalUnits - pos);
  }
  // How narrow a bar can be squeezed is just every cell at its floor width
  // (see allocateCellWidths below) -- below that, cells would have to
  // overlap their neighbors to fit. A tuplet cell is one array entry but
  // draws `count` noteheads side by side, so it needs `count` floors' worth
  // of room, not one.
  const RHYTHM_MIN_CELL_PX = 8;
  function cellFloorSlots(cell) { return cell.type === 'tuplet' ? cell.cells.length : 1; }
  function rhythmBarMinWidth(cells) {
    return cells.reduce((s, c) => s + cellFloorSlots(c), 0) * RHYTHM_MIN_CELL_PX;
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
    // A tuplet cell needs `count` floors' worth of room (see cellFloorSlots),
    // everything else just one.
    const floors = cells.map(c => cellFloorSlots(c) * RHYTHM_MIN_CELL_PX);
    const weights = cells.map(c => c.duration);
    const totalWeight = weights.reduce((s, d) => s + d, 0);

    const proportional = weights.map(wt => (wt / totalWeight) * w);
    if (proportional.every((pw, i) => pw >= floors[i] - 1e-6)) return proportional;

    const result = new Array(n).fill(0);
    const active = new Set(cells.map((_, i) => i));
    let remaining = w;
    let remainingWeight = totalWeight;
    let changed = true;
    while (changed && active.size > 0) {
      changed = false;
      for (const i of Array.from(active)) {
        const share = (weights[i] / remainingWeight) * remaining;
        if (share <= floors[i]) {
          result[i] = floors[i];
          remaining -= floors[i];
          remainingWeight -= weights[i];
          active.delete(i);
          changed = true;
        }
      }
    }
    for (const i of active) result[i] = (weights[i] / remainingWeight) * remaining;
    return result;
  }
  // The fewest rests that fill `len` 32nds starting `start` 32nds into a bar:
  // each rest as long as fits and starts on a multiple of its own length, so
  // a half rest only sits on beat 1 or 3 of 4/4, the way it's engraved.
  const REST_FILL_DURATIONS = [32, 16, 8, 4, 2];
  function restsForGap(start, len) {
    const out = [];
    for (let pos = start, end = start + len; pos < end;) {
      const d = REST_FILL_DURATIONS.find(r => pos % r === 0 && pos + r <= end) || 2;
      out.push({ type: 'rest', duration: d });
      pos += d;
    }
    return out;
  }
  // Replaces cells[idx] with newCell, then reconciles everything after it:
  // cells fully or partially overtaken by the new (larger) duration are
  // dropped, any leftover gap (when shrinking, or when growth doesn't land
  // exactly on an old boundary) is filled with rests (see restsForGap), and
  // whatever remains untouched after that is kept as-is. `barUnits` (a
  // multi-bar note staff) lines the filler up on the bar it's in.
  function rebuildRhythmCells(cells, idx, newCell, barUnits) {
    const pos = cells.slice(0, idx).reduce((s, c) => s + c.duration, 0);
    const newEnd = pos + newCell.duration;
    let cursor = pos + cells[idx].duration;
    let i = idx + 1;
    while (i < cells.length && cursor < newEnd) {
      cursor += cells[i].duration;
      i++;
    }
    const filler = restsForGap(barUnits ? newEnd % barUnits : newEnd, cursor - newEnd);
    const out = [...cells.slice(0, idx), { ...newCell }, ...filler, ...cells.slice(i)];
    // A tie needs a note on both ends: one whose next cell became a rest goes.
    out.forEach((c, k) => { if (c.tie && !canTieCell(out, k)) delete c.tie; });
    return out;
  }
  // rebuildRhythmCells for a picked duration: a note changed to another note
  // keeps its articulations and tie (a rest has none). On a note staff
  // (`staffEl`) it keeps its pitch and accidental too, and a rest turned into
  // a note lands on the middle line as drawn (see storedStaffNote).
  function replaceCellKeeping(cells, idx, newCell, staffEl) {
    const prior = cells[idx];
    const next = rebuildRhythmCells(cells, idx, newCell, staffEl ? staffBarUnits(staffEl) : null);
    const nc = next[idx];
    if (nc.type !== 'note') return next;
    if (prior.type === 'note') {
      if (prior.articulations) nc.articulations = [...prior.articulations];
      if (prior.tie && canTieCell(next, idx)) nc.tie = true;
    }
    if (staffEl && nc.pitch == null) {
      const from = prior.type === 'note' && prior.pitch != null
        ? { pitch: prior.pitch, accidental: prior.accidental || null }
        : storedStaffNote(staffEl, STAFF_DEFAULT_PITCH, null);
      nc.pitch = from.pitch;
      nc.accidental = from.accidental;
    }
    return next;
  }
  function rhythmCellGlyph(cell) {
    if (cell.type === 'rest') {
      switch (cell.duration) {
        case 2: return REST_CODES['16th'];
        case 4: return REST_CODES['8th'];
        case 6: return REST_CODES['8th'] + AUG_DOT;
        case 8: return REST_CODES.quarter;
        case 12: return REST_CODES.quarter + AUG_DOT;
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
  function articulationMetrics(unit) {
    return { gap: unit * 0.08, margin: unit * 0.1, stroke: Math.max(1.1, unit * 0.045), dotR: Math.max(1.4, unit * 0.055), accentHalfH: unit * 0.12 };
  }
  // How far a note's articulations reach beyond its own ink on one side, so a
  // tie can clear them: `side` 1 = below (staccato, accent), -1 = above
  // (fermata). 0 when there are none there.
  function articulationDepth(articulations, unit, side) {
    if (!articulations || !articulations.length) return 0;
    const m = articulationMetrics(unit);
    if (side < 0) return articulations.includes('fermata') ? m.margin + unit * 0.32 : 0;
    let d = 0;
    if (articulations.includes('staccato')) d += 2 * m.dotR + m.gap;
    if (articulations.includes('accent')) d += 2 * m.accentHalfH;
    return d ? m.margin + d : 0;
  }
  function drawArticulations(container, anchor, articulations, unit) {
    if (!articulations || !articulations.length) return;
    const { gap, margin, stroke, dotR, accentHalfH } = articulationMetrics(unit);

    let y = anchor.belowY + margin; // top edge of the next glyph below; moves downward
    if (articulations.includes('staccato')) {
      const r = dotR;
      container.appendChild(svgCircle(anchor.belowX, y + r, r, { cls: 'el-artic-dot' }));
      y += 2 * r + gap;
    }
    if (articulations.includes('accent')) {
      const w = unit * 0.34, hh = accentHalfH;
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

  /* ---------- Ties ---------- */
  // `tie: true` on a note cell joins it to the note right after it (across a
  // barline too). It is only drawn while that next cell is a note, and picking
  // a rest for that cell clears it (see rebuildRhythmCells).
  function canTieCell(cells, idx) {
    return !!cells[idx] && cells[idx].type === 'note' && !!cells[idx + 1] && cells[idx + 1].type === 'note';
  }
  function isTiedToNext(cells, idx) { return canTieCell(cells, idx) && !!cells[idx].tie; }
  function toggleCellTie(cell) {
    if (cell.tie) delete cell.tie; else cell.tie = true;
  }
  // A tie is a crescent, thickest in the middle, from (x1, y1) to (x2, y2),
  // bowing down (`dir` 1) or up (-1). `unit` is a size reference (roughly the
  // staff / bar height).
  function drawTie(container, x1, y1, x2, y2, dir, unit) {
    const len = x2 - x1;
    if (len < 2) return;
    const thick = Math.max(1.3, unit * 0.06);
    const bulge = clamp(len * 0.25, thick + unit * 0.05, unit * 0.32);
    const k = len * 0.28;
    container.appendChild(svgPath(
      `M ${x1} ${y1} C ${x1 + k} ${y1 + dir * bulge}, ${x2 - k} ${y2 + dir * bulge}, ${x2} ${y2} ` +
      `C ${x2 - k} ${y2 + dir * (bulge - thick)}, ${x1 + k} ${y1 + dir * (bulge - thick)}, ${x1} ${y1} Z`,
      { cls: 'el-tie' }));
  }

  /* ---------- Tuplet grouping marks ---------- */
  // A run of tuplet sub-notes that's beamed together (an eighth-note
  // triplet whose 3 slots are all notes) reads as one group from the beam
  // alone -- it just needs the "3" centered over it, no bracket. `y` is the
  // beam's own y; the number sits just clear of it on the beam's outer side
  // (`dir` 1 = below the beam, -1 = above, matching a stem pointing that way).
  function drawTupletNumber(container, x1, x2, y, dir, numberSize) {
    container.appendChild(svgText('3', (x1 + x2) / 2, y + dir * numberSize * 0.55, { cls: 'el-tuplet-number', anchor: 'middle', size: numberSize }));
  }
  // Anything else (a quarter-note triplet, never beam-eligible, or any
  // triplet with a rest in it) gets a real bracket instead: two short
  // horizontal strokes in from the group's outer x's, leaving a gap at the
  // middle for the "3", each end bent toward the notes with a short tick.
  // `dir` 1 draws it below the notes (ticks pointing up into them), -1
  // above (ticks pointing down).
  function drawTupletBracket(container, x1, x2, y, dir, tickLen, numberSize) {
    const gap = Math.min((x2 - x1) * 0.34, numberSize * 1.3);
    const midL = (x1 + x2) / 2 - gap / 2, midR = (x1 + x2) / 2 + gap / 2;
    if (midL > x1) container.appendChild(svgLine(x1, y, midL, y, { cls: 'el-tuplet-bracket' }));
    if (x2 > midR) container.appendChild(svgLine(midR, y, x2, y, { cls: 'el-tuplet-bracket' }));
    container.appendChild(svgLine(x1, y, x1, y - dir * tickLen, { cls: 'el-tuplet-bracket' }));
    container.appendChild(svgLine(x2, y, x2, y - dir * tickLen, { cls: 'el-tuplet-bracket' }));
    container.appendChild(svgText('3', (x1 + x2) / 2, y + dir * numberSize * 0.3, { cls: 'el-tuplet-number', anchor: 'middle', size: numberSize }));
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

  // Key signature: a signed sharp/flat count, own to each note staff. A new
  // staff starts on the sheet's key (keySignatureForKey) and can then be set
  // apart from it in the edit box. The circle-of-fifths
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
    return NOTESTAFF_CLEF_W + notestaffKeySigWidth(displayedKeySignature(el)) + 4;
  }
  // Bottom line = step 0, top line = step 8, so the full 5-line staff spans
  // el.h; el.h/8 is one staff step in pixels.
  function pitchToY(position, el) {
    return el.y + el.h - position * (el.h / 8);
  }
  // Where a staff's cells go, bar by bar. Every bar gets an equal share of the
  // staff's width `w`, and its cells are spread inside it with a little air
  // after the opening barline and before the closing one. Without that, the
  // first head of every bar after the first sat right on the barline (a head
  // is drawn from the start of its cell, which lies flush against it), while
  // the last note of the bar before had a whole cell of room.
  // Returns per-cell `widths` and `offsets` (from the staff's first bar) and
  // the `barlines` between bars (also from there, the closing one not counted).
  function staffBarPads(el) {
    const size = el.h * 0.65;
    return { left: size * 0.4, right: size * 0.2 };
  }
  function staffLayout(el, cells, w) {
    const bars = splitStaffBars(cells, staffBarUnits(el));
    const barW = w / bars.length;
    const { left, right } = staffBarPads(el);
    const widths = [], offsets = [], barlines = [];
    bars.forEach((barCells, b) => {
      const start = b * barW;
      if (b > 0) barlines.push(start);
      let px = start + left;
      allocateCellWidths(barCells, Math.max(barW - left - right, 0)).forEach(cw => {
        widths.push(cw);
        offsets.push(px);
        px += cw;
      });
    });
    return { widths, offsets, barlines };
  }
  // The narrowest a staff can be squeezed: every cell of its fullest bar at
  // its floor width (see allocateCellWidths), plus the bar padding, per bar.
  function staffMinWidth(el) {
    const bars = splitStaffBars(el.cells, staffBarUnits(el));
    const { left, right } = staffBarPads(el);
    const floorSlots = bars.map(b => b.reduce((s, c) => s + cellFloorSlots(c), 0));
    return bars.length * (Math.max(...floorSlots) * RHYTHM_MIN_CELL_PX + left + right);
  }

  let model = JSON.parse(JSON.stringify(initialSheet));
  model.elements = model.elements || [];

  let dirty = false;
  let uidCounter = 0;
  function uid(prefix) { return `${prefix}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Transient UI state (never saved): the selected elements (a click or the
  // marquee fills it; the edit box shows whatever it holds), the chord slot
  // being typed into on a selected row, and the marquee box itself while it's
  // being drawn (SVG units).
  const selectedIds = new Set();

  // On a phone-sized screen the page is a viewer: see the sheet, transpose
  // it and print it, but nothing edits it (the CSS hides the editing tools).
  const viewerMQ = matchMedia('(max-width: 700px)');
  function isViewer() { return viewerMQ.matches; }
  // The shareable PDF of the current render (see "share as PDF"); any
  // re-render makes it stale.
  let sharePdf = null;
  let activeSlot = null;
  let marquee = null;

  // Size ranges, shared by the on-page resize zones and the edit box so the
  // two can't drift apart.
  const LIMITS = {
    textFont: [8, 64],
    row: { w: [30, PAGE_W], h: [16, 300] },
    repeat: { w: [10, 60], h: [16, 200] },
    volta: { w: [16, PAGE_W], h: [10, 60], fontSize: [6, 32] },
    glyphFont: [12, 100],
    rhythmbar: { h: [12, 100] },
    notestaff: { h: [24, 160] },
  };
  function clampR(v, range) { return clamp(v, range[0], range[1]); }
  // Width/height ranges of an element (absent = that dimension isn't a free
  // number: text boxes fit their text, glyphs follow their font size).
  function sizeLimits(el) {
    switch (el.type) {
      case 'row': return LIMITS.row;
      case 'repeat': return LIMITS.repeat;
      case 'volta': return LIMITS.volta;
      case 'rhythmbar': return { w: [rhythmBarMinWidth(el.cells), PAGE_W], h: LIMITS.rhythmbar.h };
      case 'notestaff': return { w: [staffMinWidth(el), PAGE_W - notestaffLeadWidth(el)], h: LIMITS.notestaff.h };
      default: return {};
    }
  }
  // The one place a width/height change is applied (corner drag or edit box): clamps to the element's range and keeps a volta's number scaled to
  // its bracket height.
  function applySize(el, w, h) {
    const lim = sizeLimits(el);
    if (w != null && lim.w) el.w = clampR(w, lim.w);
    if (h != null && lim.h) el.h = clampR(h, lim.h);
    if (h != null && el.type === 'volta') el.fontSize = clampR(Math.round(el.h * VOLTA_FONT_SIZE / VOLTA_H), LIMITS.volta.fontSize);
  }

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

  /* ---------- transposing ---------- */
  // The stored chords are always in the sheet's original key. Transposing is a
  // view: displayChord() is what gets drawn and shown in the edit box, and
  // storeChord() turns what's typed there back into the original key. The
  // state is per editor session; it is never saved with the sheet.
  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NOTE_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const FLAT_MAJOR_ROOTS = [1, 3, 5, 8, 10]; // Db Eb F Ab Bb
  const transposeState = { semitones: 0, flats: false, flatsChosen: false, pickerOpen: true };

  function noteSemitone(letter, acc) {
    const shift = acc === '#' || acc === '♯' ? 1 : acc === 'b' || acc === '♭' ? -1 : 0;
    return (NOTE_SEMITONE[letter.toUpperCase()] + shift + 12) % 12;
  }
  // `lower`: a slash bass may be written in lower case (B7/d#), and stays so.
  function noteName(semitone, flats, lower) {
    const name = (flats ? FLAT_NAMES : SHARP_NAMES)[((semitone % 12) + 12) % 12];
    return lower ? name.charAt(0).toLowerCase() + name.slice(1) : name;
  }

  // The root of a chord symbol: its letter and accidental. A # or b straight
  // after the letter belongs to the root (Bb7, F#m, A#9), except before a
  // number that is not a chord number: A#4 is A with a #4, not A# with a 4.
  // parseChordSegments and transposeChordText both read roots through this, so
  // drawing and transposing can't disagree.
  const ROOT_ACCIDENTAL_NUMBERS = new Set(['5', '6', '7', '9', '11', '13', '69']);
  function readChordRoot(s) {
    const m = /^([A-G])([#b♯♭])?/.exec(s);
    if (!m) return null;
    let acc = m[2] || '';
    if (acc) {
      const num = /^\d+/.exec(s.slice(m[0].length));
      if (num && !ROOT_ACCIDENTAL_NUMBERS.has(num[0])) acc = '';
    }
    return { letter: m[1], acc, length: 1 + acc.length };
  }

  // Same reading of a chord as parseChordSegments: a root letter and its
  // accidental, then a slash bass unless the "/" is part of a number (6/9) or a
  // bracket. Everything between them (m7b5, (#11) ...) is intervals and stays.
  // Shorthand and other text without a root (-, r, N.C., x2) is left alone.
  function transposeChordText(text, semitones, flats) {
    const s = String(text || '');
    if (!semitones) return s;
    // A chord box holding just a new bass note ("/d") means "same chord as
    // last written, new bass" -- there's no root to read, but the bass note
    // itself is still a real note and needs transposing like any other.
    if (s[0] === '/') {
      const bass = /^\/([A-Ga-g])([#b♯♭])?/.exec(s);
      if (!bass) return s;
      return '/' + noteName(noteSemitone(bass[1], bass[2]) + semitones, flats, bass[1] === bass[1].toLowerCase())
        + s.slice(bass[0].length);
    }
    const root = readChordRoot(s);
    if (!root) return s;
    let out = noteName(noteSemitone(root.letter, root.acc) + semitones, flats);
    let rest = s.slice(root.length);
    let depth = 0, slash = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c === '(') depth++;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === '/' && !depth && !/\d/.test(rest[i + 1] || '')) { slash = i; break; }
    }
    if (slash >= 0) {
      const bass = /^([A-Ga-g])([#b♯♭])?/.exec(rest.slice(slash + 1));
      if (bass) {
        out += rest.slice(0, slash + 1)
          + noteName(noteSemitone(bass[1], bass[2]) + semitones, flats, bass[1] === bass[1].toLowerCase());
        rest = rest.slice(slash + 1 + bass[0].length);
      }
    }
    return out + rest;
  }

  // The sheet's key text ("Am", "Bb", "F# minor") as a root plus what follows it.
  function parseKey(str) {
    const m = /^\s*([A-Ga-g])([#b♯♭])?(.*?)\s*$/.exec(String(str || ''));
    if (!m) return null;
    return { semitone: noteSemitone(m[1], m[2]), acc: m[2] || '', suffix: m[3], minor: /^\s*(?:m(?!aj)|[Mm]in|-)/.test(m[3]) };
  }
  // Which spelling a key is written in: flat keys by their relative major
  // (Ebm counts as flat although its major is Gb).
  function semitonePrefersFlats(semitone, minor) {
    const major = minor ? (semitone + 3) % 12 : semitone;
    return FLAT_MAJOR_ROOTS.includes(major) || (minor && major === 6);
  }
  function keyPrefersFlats(str) {
    const k = parseKey(str);
    if (!k) return false;
    return k.acc ? k.acc === 'b' || k.acc === '♭' : semitonePrefersFlats(k.semitone, k.minor);
  }
  // Whole tones, like a singer says it: Am -> Bm is "1 up", Am -> G#m "0.5 down".
  function formatAmount(semitones) {
    if (!semitones) return 'original';
    return `${Math.abs(semitones) / 2} ${semitones > 0 ? 'up' : 'down'}`;
  }

  function displayChord(text) {
    const t = transposeState;
    return t.semitones ? transposeChordText(text, t.semitones, t.flats) : text;
  }
  function storeChord(text) {
    const t = transposeState;
    return t.semitones ? transposeChordText(text, -t.semitones, keyPrefersFlats(model.key)) : text;
  }
  // The key as it should read now: the sheet's own text until transposed.
  function transposedKeyName() {
    const k = parseKey(model.key);
    const t = transposeState;
    if (!k || !t.semitones) return String(model.key || '').trim();
    return noteName(k.semitone + t.semitones, t.flats) + k.suffix;
  }

  /* ---------- note staff: key and transposing ---------- */
  // Stored staff data is in the sheet's original key, exactly like the chords;
  // transposing only changes what is drawn (see renderNoteStaffEl).
  const mod12 = n => ((n % 12) + 12) % 12;
  // The key signature (-7..7) of the major key on tonic `pc`; where two spell
  // the same pitch (B / Cb, F# / Gb, C# / Db) `flats` picks.
  function sigForTonic(pc, flats) {
    const r = mod12(7 * pc);
    if (r <= 4) return r;
    if (r >= 8) return r - 12;
    return flats ? r - 12 : r;
  }
  // The signature a sheet key ("G", "Bb", "F#m") starts a new staff on; a minor
  // key uses its relative major's. No readable key gives C.
  function keySignatureForKey(str) {
    const k = parseKey(str);
    if (!k) return 0;
    return sigForTonic(k.minor ? k.semitone + 3 : k.semitone, keyPrefersFlats(str));
  }
  function transposeKeySignature(sig, semitones, flats) {
    return sigForTonic(mod12(7 * sig) + semitones, flats);
  }
  // The signature drawn for a staff: transposed with the sheet, unless it's
  // the builder's stand-in (`staged`), which always shows the sheet's own key.
  function displayedKeySignature(el) {
    const t = transposeState;
    return t.semitones && !el.staged ? transposeKeySignature(el.keySignature || 0, t.semitones, t.flats) : (el.keySignature || 0);
  }
  // "G (1 sharp)" for a signature count, the way the Key select labels it.
  function keySignatureLabel(sig) { return KEYSIG_OPTIONS[clamp(sig, -7, 7) + 7].label; }

  const LETTERS_FROM_C = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  // A staff step's diatonic index (octave * 7 + letter counted from C) at the
  // bottom line: E4 in treble, G2 in bass.
  const STAFF_CLEF_DIATONIC_BASE = { treble: 30, bass: 18 };
  function keySigAlteration(letter, sig) {
    return alteredLettersForKeySignature(sig).has(letter) ? (sig > 0 ? 1 : -1) : 0;
  }
  // Moves one note of a staff from the key signature `fromSig` to `toSig`,
  // `semitones` up, and spells it there: a letter the new signature already
  // alters when that gives the pitch, else a natural, else a sharp or flat
  // (flat under a flat signature, or in C when `flats`). The accidental is
  // only set when the signature doesn't already say it. Returns the new
  // {pitch, accidental}; the notes always stay within the staff's range.
  function transposeStaffNote(cell, clef, fromSig, toSig, semitones, flats) {
    const step = cell.pitch != null ? cell.pitch : STAFF_DEFAULT_PITCH;
    const diatonic = STAFF_CLEF_DIATONIC_BASE[clef] + step;
    const letter = LETTERS_FROM_C[diatonic % 7];
    const oct = Math.floor(diatonic / 7);
    const alt = cell.accidental === 'sharp' ? 1 : cell.accidental === 'flat' ? -1
      : cell.accidental === 'natural' ? 0 : keySigAlteration(letter, fromSig);
    const pc = mod12(oct * 12 + NOTE_SEMITONE[letter] + alt + semitones);

    let newLetter = LETTERS_FROM_C.find(l => mod12(NOTE_SEMITONE[l] + keySigAlteration(l, toSig)) === pc);
    let newAlt = newLetter ? keySigAlteration(newLetter, toSig) : 0;
    if (!newLetter) {
      newLetter = LETTERS_FROM_C.find(l => NOTE_SEMITONE[l] === pc);
      if (!newLetter) {
        const useFlats = toSig < 0 || (toSig === 0 && flats);
        newLetter = LETTERS_FROM_C.find(l => NOTE_SEMITONE[l] === mod12(pc + (useFlats ? 1 : -1)));
        newAlt = useFlats ? -1 : 1;
      }
    }
    // The letter's own octave (a Cb or B# lands in the neighbouring one).
    const absSemi = oct * 12 + NOTE_SEMITONE[letter] + alt + semitones;
    const newOct = (absSemi - newAlt - NOTE_SEMITONE[newLetter]) / 12;
    let pitch = newOct * 7 + LETTERS_FROM_C.indexOf(newLetter) - STAFF_CLEF_DIATONIC_BASE[clef];
    while (pitch > STAFF_PITCH_MAX) pitch -= 7;
    while (pitch < STAFF_PITCH_MIN) pitch += 7;
    const accidental = newAlt === keySigAlteration(newLetter, toSig) ? null
      : newAlt > 0 ? 'sharp' : newAlt < 0 ? 'flat' : 'natural';
    return { pitch, accidental };
  }
  // A note of `el` as it's drawn: transposed with the sheet, else as stored.
  function displayedStaffNote(el, cell) {
    const t = transposeState;
    if (!t.semitones || el.staged) return { pitch: cell.pitch != null ? cell.pitch : STAFF_DEFAULT_PITCH, accidental: cell.accidental || null };
    return transposeStaffNote(cell, el.clef || 'treble', el.keySignature || 0, displayedKeySignature(el), t.semitones, t.flats);
  }
  // The other way, for what's dragged or picked on a transposed staff: a note
  // as shown (`pitch`, `accidental`) back to what to store.
  function storedStaffNote(el, pitch, accidental) {
    const t = transposeState;
    if (!t.semitones || el.staged) return { pitch, accidental };
    return transposeStaffNote({ pitch, accidental }, el.clef || 'treble', displayedKeySignature(el), el.keySignature || 0,
      -t.semitones, keyPrefersFlats(model.key));
  }
  // A signature as picked in the edit box (where it reads transposed) back to what to store.
  function storedKeySignature(el, shown) {
    const t = transposeState;
    return t.semitones && !el.staged ? transposeKeySignature(shown, -t.semitones, keyPrefersFlats(model.key)) : shown;
  }

  // Splits a chord symbol into runs, the way it's engraved on a real chart.
  // Each run has a `kind` (see CHORD_RUN_STYLE): `base` -- the root letter,
  // quality words (m, maj, dim, sus, add...); `acc` -- the root's accidental,
  // raised and a bit smaller; `sup` -- raised: extension numbers and altered
  // tones (F#m7 -> F + ^# + m + ^7,
  // Cm7b5 -> C + m + ^7b5, C7(#11) -> C + ^7(#11), Ao7 -> A + ^o7); `bass` -- a slash bass
  // note, smaller and dropped a little (Bb7/D -> B + ^b + ^7 + /D); `bassSup`
  // -- that bass note's own accidental, raised within the small run.
  // The stored text stays plain; this only affects how it's drawn.
  function parseChordSegments(text) {
    const s = String(text || '');
    const segs = [];
    const push = (t, kind) => {
      if (!t) return;
      const last = segs[segs.length - 1];
      if (last && last.kind === kind) last.text += t;
      else segs.push({ text: t, kind });
    };
    // A chord box holding just a new bass note ("/d") means "same chord as
    // last written, new bass" -- draw it in the same raised/smaller bass
    // style as a slash bass following a root (see the loop below).
    if (s[0] === '/') {
      const bass = /^\/[A-Ga-g]?/.exec(s)[0];
      push(bass, 'bass');
      let i = bass.length;
      const bacc = /^[#b♯♭]/.exec(s.slice(i));
      if (bacc) { push(bacc[0], 'bassSup'); i += 1; }
      push(s.slice(i), 'bass');
      return segs;
    }
    const root = readChordRoot(s);
    if (!root) return s ? [{ text: s, kind: 'base' }] : []; // N.C., %, x2...
    push(root.letter, 'base');
    if (root.acc) push(root.acc, 'acc');
    let i = root.length;
    while (i < s.length) {
      const rest = s.slice(i);
      if (rest[0] === '/' && !/^\/\d/.test(rest)) { // slash bass; "6/9" is not one
        const bass = /^\/[A-Ga-g]?/.exec(rest)[0];
        push(bass, 'bass');
        i += bass.length;
        const bacc = /^[#b♯♭]/.exec(s.slice(i));
        if (bacc) { push(bacc[0], 'bassSup'); i += 1; }
        push(s.slice(i), 'bass');
        break;
      }
      // "o" is the diminished sign (Ao7); not the o of a word like "Coda".
      let m = /^\([^)]*\)/.exec(rest) || /^o(?![A-Za-z])/.exec(rest) || /^[#b♯♭]?\d+(?:\/\d+)?/.exec(rest);
      // "+"/"-" only count as an alteration after a number ("7-9"); before one
      // they're the chord's quality ("C-7"), which stays on the baseline.
      if (!m && /[\d)]/.test(s[i - 1])) m = /^[+-]\d+(?:\/\d+)?/.exec(rest);
      if (m) { push(m[0], 'sup'); i += m[0].length; }
      else { push(rest[0], 'base'); i += 1; }
    }
    return segs;
  }

  // Font size and vertical lift of each run kind, as fractions of the chord's
  // font size (lift > 0 is up).
  const CHORD_SUP_SCALE = 0.9, CHORD_SUP_RAISE = 0.4;
  const CHORD_BASS_SCALE = 0.8, CHORD_BASS_DROP = 0.15;
  const CHORD_ACC_SCALE = 0.75; // the root's # / b: raised like the numbers, but a bit smaller
  const CHORD_RUN_STYLE = {
    base: { scale: 1, lift: 0 },
    sup: { scale: CHORD_SUP_SCALE, lift: CHORD_SUP_RAISE },
    acc: { scale: CHORD_ACC_SCALE, lift: CHORD_SUP_RAISE },
    bass: { scale: CHORD_BASS_SCALE, lift: -CHORD_BASS_DROP },
    bassSup: { scale: CHORD_BASS_SCALE * CHORD_ACC_SCALE, lift: CHORD_SUP_RAISE * CHORD_BASS_SCALE - CHORD_BASS_DROP },
  };
  function measureChordWidth(text, size) {
    return parseChordSegments(text).reduce(
      (w, seg) => w + measureTextWidth(seg.text, size * CHORD_RUN_STYLE[seg.kind].scale), 0);
  }
  // Same as svgText, but with the smaller/shifted runs as tspans (dy, not
  // baseline-shift, which Safari/Firefox don't all honour). Each run's dy is
  // relative to the run before it.
  function svgChordText(text, x, y, opts = {}) {
    const size = opts.size || 13;
    const el = svgText('', x, y, opts);
    let lift = 0;
    for (const seg of parseChordSegments(text)) {
      const style = CHORD_RUN_STYLE[seg.kind];
      const span = svgEl('tspan', {});
      if (style.scale !== 1) span.setAttribute('font-size', size * style.scale);
      if (style.lift !== lift) span.setAttribute('dy', -(style.lift - lift) * size);
      lift = style.lift;
      span.textContent = seg.text;
      el.appendChild(span);
    }
    return el;
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

  /* ---------- marquee selection ---------- */
  // Approximate on-page footprint of an element, used only to decide what a
  // marquee "touches" and to outline the selection -- so the padding on the
  // notation types (stems, beams, ledger lines) needn't be exact.
  function elementBounds(el) {
    switch (el.type) {
      case 'title': case 'chordText': case 'text': {
        const chord = el.type === 'chordText';
        const { w, h } = textBoxSize(chord ? displayChord(el.text) : el.text, el.fontSize, chord);
        return { x: el.x, y: el.y, w, h };
      }
      case 'row': case 'repeat': case 'volta':
        return { x: el.x, y: el.y, w: el.w, h: el.h };
      case 'glyph': {
        const { w, h } = glyphSize(el);
        return { x: el.x, y: el.y - h * 0.75, w, h };
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

  // Drops the selection outline (and resize zone and arrow handle) nodes straight from the DOM. Used when a
  // gesture changes the selection: a full re-render inside mousedown would
  // detach the very node being pressed, so the outline is repainted by the
  // next render (the first drag move, or the mouseup of a click) instead.
  function dropOutlineNodes() {
    document.querySelectorAll('#sheet-svg .el-selection, #sheet-svg .el-slot-active, #sheet-svg .el-resize-handle, #sheet-svg .el-arrow-handle, #sheet-svg .el-arrow-bow-handle').forEach(n => n.remove());
    document.querySelectorAll('#sheet-svg .el-group.is-selected').forEach(n => n.classList.remove('is-selected'));
  }
  // Makes `id` the only selected element (the edit box follows on the next
  // syncEditBox). No-op if it already is.
  function selectOnly(id) {
    if (selectedIds.size === 1 && selectedIds.has(id)) return;
    selectedIds.clear();
    selectedIds.add(id);
    activeSlot = null;
    dropOutlineNodes();
  }
  function clearSelection() {
    if (!selectedIds.size) return;
    selectedIds.clear();
    activeSlot = null;
    dropOutlineNodes();
    syncEditBox();
  }

  function drawSelectionOverlay(svg) {
    model.elements.forEach(el => {
      if (!selectedIds.has(el.id)) return;
      const b = elementBounds(el);
      svg.appendChild(svgRect(b.x - 3, b.y - 3, b.w + 6, b.h + 6, { cls: 'el-selection', rx: 3 }));
      if (selectedIds.size === 1 && el.type === 'row' && activeSlot != null) {
        const s = rowChordSlots(el)[activeSlot];
        if (s) svg.appendChild(svgRect(s.x + 1.5, s.y + 1.5, Math.max(s.w - 3, 1), Math.max(s.h - 3, 1), { cls: 'el-slot-active', rx: 2 }));
      }
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
      if (e.button !== 0 || isViewer()) return;
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
        activeSlot = null;
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
  // calling `onDrag`. `selectEl` is the element a press on this target selects
  // (defaults to `moveEl`); pass it alone for handles that don't move the
  // element but should still pick it, like a resize zone or an arrow's end handle. A press selects
  // right away (so the edit box follows), shift adds/removes it, and a click
  // that lands inside a multi-selection narrows it to that element.
  function wireDragAndClick(hitEl, onDrag, onClick, moveEl, selectEl) {
    hitEl.addEventListener('mousedown', e => {
      if (isViewer()) return;
      e.preventDefault();
      e.stopPropagation();
      const target = selectEl || moveEl;
      let narrowTo = null;
      if (target) {
        if (e.shiftKey) {
          if (selectedIds.has(target.id)) selectedIds.delete(target.id);
          else selectedIds.add(target.id);
          activeSlot = null;
          dropOutlineNodes();
        } else if (selectedIds.has(target.id) && selectedIds.size > 1) {
          narrowTo = target.id;
        } else {
          selectOnly(target.id);
        }
        syncEditBox();
      }
      let groupDrag = null;
      if (moveEl && selectedIds.has(moveEl.id) && selectedIds.size > 1) {
        const snaps = model.elements
          .filter(el => selectedIds.has(el.id))
          .map(el => ({ el, snap: snapshotPos(el) }));
        groupDrag = (ddx, ddy) => {
          snaps.forEach(({ el, snap }) => applyOffset(el, snap, ddx, ddy));
          markDirty(); renderSvg();
        };
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
        if (!moved) {
          if (narrowTo) { selectOnly(narrowTo); syncEditBox(); }
          // Safe now that the press is over: paint the selection outline.
          if (target) renderSvg();
          if (onClick) onClick(ev.clientX, ev.clientY);
        }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  // Resizing: an invisible hit-zone over the element's bottom-right corner
  // (only the cursor changes on hover), so the page shows no handle boxes.
  // It exists only while `el` is the one selected element -- click an element
  // first, then drag its corner. `onDrag(ddx, ddy)` gets the drag offset in
  // SVG units.
  function addResizeHandle(g, x, y, onDrag, el) {
    if (selectedIds.size !== 1 || !selectedIds.has(el.id)) return;
    const zone = svgRect(x - 6, y - 6, 12, 12, { cls: 'el-resize-handle' });
    wireDragAndClick(zone, onDrag, null, null, el);
    g.appendChild(zone);
  }
  // Drag handlers that resize `el`. Start values are captured when the
  // element is drawn (a drag re-renders on every move but keeps using the
  // handler from the first render), so each move applies its offset to the
  // original size rather than compounding.
  function sizeDrag(el) {
    const w0 = el.w, h0 = el.h;
    return (ddx, ddy) => { applySize(el, w0 + ddx, h0 + ddy); markDirty(); renderSvg(); };
  }
  function fontDrag(el, range) {
    const size0 = el.fontSize;
    return ddx => { el.fontSize = clampR(Math.round(size0 + ddx * 0.4), range); markDirty(); renderSvg(); };
  }

  // A small handle that moves the whole element -- used where the element's
  // own body is already claimed by a different drag gesture (a note staff's
  // noteheads drag to re-pitch, so the bar needs its own dedicated way to
  // move).
  function addMoveHandle(g, x, y, onDrag, moveEl) {
    const handle = svgRect(x - 5, y - 5, 10, 10, { cls: 'el-move-handle' });
    wireDragAndClick(handle, onDrag, null, moveEl);
    g.appendChild(handle);
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
    if (e.key === 'Escape' && activeRhythmMenu && !staffEditor.el) closeRhythmMenu();
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
    const sync = () => items.forEach(it => {
      it.btn.classList.toggle('rhythm-menu-item--on', it.isOn());
      it.btn.disabled = !!(it.disabled && it.disabled());
    });
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
  function tieIcon() {
    const svg = svgEl('svg', { width: 28, height: 16, viewBox: '0 0 28 16', class: 'rhythm-menu-icon' });
    drawTie(svg, 3, 3, 25, 3, 1, 44);
    return svg;
  }
  function articulationIcon(kind) {
    const svg = svgEl('svg', { width: 28, height: 16, viewBox: '0 0 28 16', class: 'rhythm-menu-icon' });
    drawArticulations(svg, { aboveX: 14, aboveY: 15, belowX: 14, belowY: 0 }, [kind], 34);
    return svg;
  }

  // Rhythm bars only (a note staff is written in the staff editor, see
  // openStaffEditor). `opts.onChange()` is called after an in-place change to
  // the cell (articulation / tie) so the caller can mark dirty and re-render.
  // The sections apply to notes only -- a rest just gets the duration grid.
  function openRhythmMenu(clientX, clientY, cells, idx, onApply, opts = {}) {
    closeRhythmMenu();
    const menu = document.createElement('div');
    menu.className = 'rhythm-menu';
    const prior = cells[idx];
    // Which items appear is set in the edit box (see NOTE_MENU_ITEMS).
    rhythmMenuOptionsFor(cells, idx).filter(opt => isMenuItemOn(`${opt.type}-${opt.duration}`)).forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rhythm-menu-item';
      const glyph = document.createElement('span');
      glyph.className = 'rhythm-menu-glyph';
      // A tuplet option isn't a plain note/rest cell (rhythmCellGlyph doesn't
      // know its shape) -- show the plain note of that shape instead.
      glyph.textContent = opt.type === 'triplet' ? NOTE_CODES[opt.unit === 4 ? '8th' : 'quarter'] : rhythmCellGlyph(opt);
      const label = document.createElement('span');
      label.className = 'rhythm-menu-label';
      label.textContent = opt.label;
      btn.appendChild(glyph);
      btn.appendChild(label);
      btn.addEventListener('click', () => {
        onApply(replaceCellKeeping(cells, idx, opt.type === 'triplet' ? makeTupletCell(opt.unit) : { type: opt.type, duration: opt.duration }));
        closeRhythmMenu();
      });
      menu.appendChild(btn);
    });
    const changed = () => { if (opts.onChange) opts.onChange(); };
    if (prior.type === 'note') {
      const artics = ARTICULATION_KINDS.filter(k => isMenuItemOn(`artic-${k.value}`));
      if (artics.length) {
        addMenuToggleSection(menu, 'Articulation', Math.min(artics.length, 3), artics.map(k => ({
          glyph: articulationIcon(k.value),
          label: k.label,
          isOn: () => cellHasArticulation(prior, k.value),
          onClick: () => { toggleCellArticulation(prior, k.value); changed(); },
        })));
      }
      if (isMenuItemOn('tie')) {
        addMenuToggleSection(menu, 'Tie', 3, [{
          glyph: tieIcon(),
          label: 'Tie to next',
          isOn: () => isTiedToNext(cells, idx),
          disabled: () => !canTieCell(cells, idx),
          onClick: () => { toggleCellTie(prior); changed(); },
        }]);
      }
    }
    if (!menu.children.length) {
      const none = document.createElement('div');
      none.className = 'rhythm-menu-heading';
      none.textContent = 'Nothing to show. Turn menu items on in the edit box.';
      menu.appendChild(none);
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

  // The restricted menu for one slot of a placed tuplet (see renderTupletGroupRhythm
  // / renderTupletGroupStaff). Unlike the normal cell menu, a slot's duration
  // can never change -- that's what keeps the group's equal parts adding up
  // to its own slot -- so this offers only a note/rest toggle at the
  // tuplet's own `unit`, the same articulation section as the
  // normal menu (no tie: ties into/out of a tuplet aren't supported), and a
  // "Remove triplet" action that hands off to `onRemove` -- the caller
  // replaces the *whole* tuplet cell with a plain rest of its total
  // duration (see rebuildRhythmCells). `onChange` is called after every
  // edit (mutations are all in place, on `tupletCell.cells[subIdx]`).
  function openTupletSlotMenu(clientX, clientY, tupletCell, subIdx, onChange, onRemove) {
    closeRhythmMenu();
    const menu = document.createElement('div');
    menu.className = 'rhythm-menu';
    const subCells = tupletCell.cells;
    const prior = subCells[subIdx];
    RHYTHM_MENU_OPTIONS.filter(o => (o.type === 'note' || o.type === 'rest') && o.duration === tupletCell.unit)
      .filter(opt => isMenuItemOn(`${opt.type}-${opt.duration}`)).forEach(opt => {
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
          const next = { type: opt.type, duration: opt.duration };
          if (opt.type === 'note' && prior.type === 'note' && prior.articulations) next.articulations = [...prior.articulations];
          subCells[subIdx] = next;
          onChange();
          closeRhythmMenu();
        });
        menu.appendChild(btn);
      });
    if (prior.type === 'note') {
      const artics = ARTICULATION_KINDS.filter(k => isMenuItemOn(`artic-${k.value}`));
      if (artics.length) {
        addMenuToggleSection(menu, 'Articulation', Math.min(artics.length, 3), artics.map(k => ({
          glyph: articulationIcon(k.value),
          label: k.label,
          isOn: () => cellHasArticulation(prior, k.value),
          onClick: () => { toggleCellArticulation(prior, k.value); onChange(); },
        })));
      }
    }
    addMenuToggleSection(menu, 'Triplet', 1, [{
      glyph: '×',
      label: 'Remove triplet',
      isOn: () => false,
      onClick: () => { closeRhythmMenu(); onRemove(); },
    }]);
    document.body.appendChild(menu);
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

  // `chord`: size for a chord symbol's raised numbers (see parseChordSegments).
  function textBoxSize(text, fontSize, chord) {
    const w = Math.max(50, (chord ? measureChordWidth(text, fontSize) : measureTextWidth(text, fontSize)) + 16);
    const h = fontSize + 14;
    return { w, h };
  }

  // The clickable/editable number area of a volta bracket, just inside its
  // left hook; grows with the text so longer labels like "1, 2." still fit.
  function voltaTextPad(el) { return el.fontSize * 0.6; }
  function voltaLabelBox(el, text) {
    return { x: el.x, y: el.y, w: Math.max(el.fontSize * 2.3, measureTextWidth(text, el.fontSize) + 2 * voltaTextPad(el)), h: el.h };
  }

  /* ---------- row chord slots ---------- */
  // How many chord boxes each bar of a row has. Bars usually all share the
  // row's `chordsPerBar`; `chordCounts` (one entry per bar) is only present
  // while some bar differs. The flat `row.chords` list holds the boxes bar by
  // bar, so box `k` of bar `i` is at (boxes in the bars before `i`) + k.
  function rowBarCounts(row) {
    if (Array.isArray(row.chordCounts) && row.chordCounts.length === row.barCount) {
      return row.chordCounts.map(c => clamp(Math.round(c) || 0, 0, ROW_MAX_CHORDS));
    }
    return Array(row.barCount).fill(row.chordsPerBar || 0);
  }
  function rowSlotCount(row) { return rowBarCounts(row).reduce((sum, c) => sum + c, 0); }

  // The typeable chord boxes of a row (or of the sidebar preview, which passes
  // its own geometry): each bar is split into `counts[bar]` equal slots, with
  // the first/last bar inset where a repeat mark sits on that edge. `idx` is
  // the slot's index into `row.chords` (and its position in the returned
  // list), `n` how many slots share its bar.
  function chordSlotRects(x, y, w, h, counts, repeatStart, repeatEnd) {
    const rects = [];
    const barCount = counts.length;
    if (!barCount) return rects;
    const barW = w / barCount;
    for (let i = 0; i < barCount; i++) {
      const n = counts[i];
      if (!(n > 0)) continue;
      const left = x + i * barW + (i === 0 && repeatStart ? REPEAT_MARK_W : 0);
      const right = x + (i + 1) * barW - (i === barCount - 1 && repeatEnd ? REPEAT_MARK_W : 0);
      const slotW = (right - left) / n;
      for (let k = 0; k < n; k++) {
        rects.push({ x: left + k * slotW, y, w: slotW, h, bar: i, k, idx: rects.length, n });
      }
    }
    return rects;
  }
  function rowChordSlots(row) {
    return chordSlotRects(row.x, row.y, row.w, row.h, rowBarCounts(row), row.repeatStart, row.repeatEnd);
  }

  // Largest chord size that still fits the room (`gap` is the breathing room
  // it needs in total): shrinks for long chords in narrow slots (8 to a bar)
  // rather than spilling over the barlines.
  function slotFontSize(text, room, h, gap = 4) {
    let size = Math.min(CHORD_FONT_SIZE, h * 0.55);
    while (size > 7 && measureChordWidth(text, size) + gap > room) size -= 0.5;
    return Math.max(size, 7);
  }

  // The rest a "-" draws: the longest standard rest that fits its box, taking
  // the bar as 4/4 (rows carry no time signature) -- a whole rest with 1 box in
  // the bar, a half with 2, a quarter with 3-4, an eighth with 5-8. `rise` (a
  // fraction of the glyph size) nudges each glyph so it sits centred in the
  // bar: the whole rest hangs below its origin, the half rest sits on top.
  function restForSlots(n) {
    if (n <= 1) return { code: REST_CODES.whole, rise: -1 / 16 };
    if (n === 2) return { code: REST_CODES.half, rise: 1 / 16 };
    if (n <= 4) return { code: REST_CODES.quarter, rise: 0 };
    return { code: REST_CODES['8th'], rise: 0 };
  }

  // Shorthand typed into a chord box that is drawn as a symbol instead of
  // text: "-" is a rest as long as the box (see restForSlots), "r" a
  // repeat-previous-bar sign spanning the whole bar. `n` is how many boxes
  // share the bar. The stored text stays what was typed. (A chord with a
  // trailing "-", "Am-", is a tie to the next chord instead; see chordTie.)
  function barSymbol(text, n) {
    const t = String(text || '').trim().toLowerCase();
    if (t === '-') return { ...restForSlots(n || 1), across: 'slot' };
    if (t === 'r') return { code: SIMILE_MARK, rise: 0, across: 'bar' };
    return null;
  }

  // A chord typed with a trailing "-" ("Am-") is tied to the next chord in its
  // row. `chord` is the text to draw (the dash dropped); a "-" alone is a rest,
  // and one inside a chord ("C-7", "Bb7-9") is part of it.
  function chordTie(text) {
    const s = String(text || '').trim();
    const m = /^(.*\S)-$/.exec(s);
    if (m && readChordRoot(m[1])) return { chord: m[1], tied: true };
    return { chord: s, tied: false };
  }

  // Where a chord drawn in slot `s` runs horizontally: from its left edge
  // (`x1`) to its right (`x2`). In a bar with several slots it starts at the
  // slot's left edge; in a one-slot bar it is centred.
  function chordSlotSpan(text, s, size) {
    const w = measureChordWidth(text, size);
    const x1 = s.n > 1 ? s.x + SLOT_CHORD_PAD : s.x + s.w / 2 - w / 2;
    return { x1, x2: x1 + w };
  }

  // Draws a slot's content: the chord, or, if it's shorthand for a symbol, that
  // symbol -- a rest centred in its own slot, a repeat sign centred across the
  // whole bar `bar`. A chord never moves out of its slot: in a
  // bar with one slot it is centred; in a bar with several it starts at the
  // slot's left edge, so `Am F _ _` and `_ _ Am F` read differently.
  function drawSlotContent(g, text, s, bar, h, chordSize, perBar) {
    const sym = barSymbol(text, s.n);
    if (sym) {
      const room = sym.across === 'slot' ? s.w : bar.w;
      const cx = sym.across === 'slot' ? s.x + s.w / 2 : bar.x + bar.w / 2;
      let size = sym.across === 'slot' ? h * REST_SIZE : h;
      const gw = measureTextWidth(sym.code, size, 'MuseJazz');
      if (gw > room - 4) size *= Math.max(room - 4, 4) / gw; // very narrow bars / boxes
      g.appendChild(svgText(sym.code, cx, s.y + h / 2 + sym.rise * size, {
        cls: 'el-glyph-text', anchor: 'middle', size,
      }));
      return;
    }
    const size = chordSize || slotFontSize(text, s.w, h);
    const left = perBar > 1;
    g.appendChild(svgChordText(text, left ? s.x + SLOT_CHORD_PAD : s.x + s.w / 2, s.y + h / 2 + size * 0.35, {
      cls: 'el-chord-text', anchor: left ? 'start' : 'middle', size,
    }));
  }

  // Tab order: every chord slot of every row that has any, rows in reading
  // order (top to bottom, then left to right), slots left to right within.
  function nextChordSlot(row, idx, dir) {
    const rows = model.elements
      .filter(e => e.type === 'row' && rowSlotCount(e) > 0)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    const seq = [];
    rows.forEach(r => rowChordSlots(r).forEach(s => seq.push({ rowId: r.id, idx: s.idx })));
    const at = seq.findIndex(s => s.rowId === row.id && s.idx === idx);
    return at < 0 ? null : seq[at + dir] || null;
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
      return { id: uid('el'), type: 'title', x, y, text: 'Section', fontSize: TITLE_FONT_SIZE };
    } else if (type === 'row') {
      const n = clamp(parseInt(opts.barCount, 10) || 4, 1, ROW_MAX_BARS);
      const el = { id: uid('el'), type: 'row', x, y, w: Math.min(n * BAR_UNIT, ROW_MAX_W), h: BAR_H, barCount: n };
      if (opts.repeatStart) el.repeatStart = true;
      if (opts.repeatEnd) el.repeatEnd = true;
      // Each bar holds `chordsPerBar` typeable chord slots; `chords` is flat,
      // slot `k` of bar `i` at index i * chordsPerBar + k. Absent = plain bars.
      const cpb = clamp(parseInt(opts.chordsPerBar, 10) || 0, 0, ROW_MAX_CHORDS);
      if (cpb > 0) { el.chordsPerBar = cpb; el.chords = Array(n * cpb).fill(''); }
      return el;
    } else if (type === 'chordText') {
      return { id: uid('el'), type: 'chordText', x, y, text: 'Am', fontSize: CHORD_FONT_SIZE };
    } else if (type === 'text') {
      return { id: uid('el'), type: 'text', x, y, text: 'Note', fontSize: TEXT_FONT_SIZE };
    } else if (type === 'repeat-start') {
      return { id: uid('el'), type: 'repeat', x, y, w: REPEAT_MARK_W, h: BAR_H, kind: 'start' };
    } else if (type === 'repeat-end') {
      return { id: uid('el'), type: 'repeat', x, y, w: REPEAT_MARK_W, h: BAR_H, kind: 'end' };
    } else if (type === 'volta') {
      return { id: uid('el'), type: 'volta', x, y, w: VOLTA_W, h: VOLTA_H, text: '1.', fontSize: VOLTA_FONT_SIZE };
    } else if (type === 'arrow') {
      return { id: uid('el'), type: 'arrow', x1: x, y1: y, x2: x + 70, y2: y - 40, bow: { dx: 0, dy: 0 } };
    } else if (type === 'glyph') {
      return { id: uid('el'), type: 'glyph', x, y, code: opts.code || SIMILE_MARK, fontSize: 20 };
    } else if (type === 'rhythmbar') {
      const totalUnits = opts.cells.reduce((s, c) => s + c.duration, 0);
      return {
        id: uid('el'), type: 'rhythmbar', x, y,
        // Other time signatures scale with the bar; never narrower than the cells need.
        w: Math.max(RHYTHMBAR_DEFAULT_W * totalUnits / 32, rhythmBarMinWidth(opts.cells)), h: RHYTHMBAR_DEFAULT_H,
        numerator: opts.numerator || 4, denominator: opts.denominator || 4,
        cells: JSON.parse(JSON.stringify(opts.cells)),
      };
    } else if (type === 'notestaff') {
      const totalUnits = opts.cells.reduce((s, c) => s + c.duration, 0);
      const el = {
        id: uid('el'), type: 'notestaff', x, y,
        w: 0, h: NOTESTAFF_DEFAULT_H,
        numerator: opts.numerator || 4, denominator: opts.denominator || 4,
        bars: clamp(Math.round(opts.bars) || 1, 1, STAFF_MAX_BARS),
        clef: opts.clef || 'treble', keySignature: opts.keySignature || 0,
        cells: JSON.parse(JSON.stringify(opts.cells)),
      };
      // The width follows the bars: NOTESTAFF_DEFAULT_BAR_W per 4/4 bar (other
      // time signatures scale with the length of the bar).
      el.w = clamp(NOTESTAFF_DEFAULT_BAR_W * totalUnits / 32, staffMinWidth(el), ROW_MAX_W - notestaffLeadWidth(el));
      return el;
    }
    return null;
  }

  function addElement(type, x, y, opts) {
    const el = buildElement(type, x, y, opts);
    if (!el) return;
    // A dropped row is kept within the page margins (a full-width row can
    // only sit at the left margin).
    if (el.type === 'row') el.x = clamp(el.x, PAGE_MARGIN, PAGE_W - PAGE_MARGIN - el.w);
    if (el.type === 'notestaff') el.x = clamp(el.x, PAGE_MARGIN, PAGE_W - PAGE_MARGIN - notestaffLeadWidth(el) - el.w);
    model.elements.push(el);
    markDirty();
    render();
    // Pick the new element and put the cursor where typing starts: its text
    // field, or a row's first chord box (Tab carries on from there).
    selectOnly(el.id);
    renderSvg();
    if (type === 'title' || type === 'chordText' || type === 'text') focusEditField('text');
    else if (el.type === 'row' && rowSlotCount(el) > 0) focusSlot(el.id, 0);
    else if (el.type === 'notestaff') openStaffEditor(el, { idx: 0 }, { input: true }); // straight to writing its notes
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
    activeSlot = null;
    copies.forEach(c => selectedIds.add(c.id));
    markDirty(); render();
  }

  function removeElement(id) {
    model.elements = model.elements.filter(e => e.id !== id);
    selectedIds.delete(id);
    activeSlot = null;
    markDirty(); render();
  }
  function removeSelection() {
    if (!selectedIds.size) return;
    model.elements = model.elements.filter(e => !selectedIds.has(e.id));
    selectedIds.clear();
    activeSlot = null;
    markDirty(); render();
  }
  function nudgeSelection(dx, dy) {
    model.elements.forEach(el => { if (selectedIds.has(el.id)) applyOffset(el, snapshotPos(el), dx, dy); });
    markDirty(); renderSvg();
  }

  /* ---------- rendering ---------- */
  // Title/chordText/text all share this: an optional visible box, text
  // inside it, drag-to-move, click-to-select (the text itself is typed in the
  // edit box), and a corner handle that scales fontSize (which drives the
  // box's own auto-fit size on the next render).
  function renderTextEl(svg, el, opts) {
    const fontSize = el.fontSize;
    const shown = opts.chord ? displayChord(el.text) : el.text;
    const { w, h } = textBoxSize(shown, fontSize, opts.chord);
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
    const draw = opts.chord ? svgChordText : svgText;
    g.appendChild(draw(shown || '', textX, el.y + h / 2 + fontSize * 0.35, {
      cls: opts.textCls, anchor: opts.boxed ? 'middle' : 'start', size: fontSize,
    }));

    const startX = el.x, startY = el.y;
    wireDragAndClick(interactiveEl,
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      () => focusEditField('text'), el);

    addResizeHandle(g, el.x + w, el.y + h, fontDrag(el, LIMITS.textFont), el);

    svg.appendChild(g);
  }

  function renderRowEl(svg, el) {
    const n = el.barCount, w = el.w, h = el.h;
    const barW = w / n;
    // The dashed outlines of empty chord slots show only on the one selected row.
    const g = svgGroup({ cls: selectedIds.size === 1 && selectedIds.has(el.id) ? 'el-group is-selected' : 'el-group' });

    const hit = svgRect(el.x, el.y, w, h, { cls: 'el-row-hit' });
    g.appendChild(hit);
    const startX = el.x, startY = el.y;
    const dragRow = (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); };
    wireDragAndClick(hit, dragRow, null, el);

    // Chord slots sit right above the hit rect (and below everything else
    // drawn here) so the repeat marks and the resize corner stay clickable. A drag on
    // a slot still moves the row; a plain click selects the row and puts the
    // cursor in that slot's field in the edit box.
    const slots = rowChordSlots(el);
    const barExtent = {}; // bar index -> the x-range its boxes span
    slots.forEach(s => {
      const e = barExtent[s.bar] || (barExtent[s.bar] = { x: s.x, right: s.x + s.w });
      e.x = Math.min(e.x, s.x);
      e.right = Math.max(e.right, s.x + s.w);
    });
    const chordAt = s => displayChord((el.chords && el.chords[s.idx]) || '');
    // How much room a chord may take: its own slot plus the empty slots after
    // it in the same bar (`Am _ F G`: the Am can run into the empty slot).
    // This only limits its size -- it never changes where the chord sits.
    const roomOf = s => {
      let last = s;
      for (let j = s.idx + 1; j < slots.length && slots[j].bar === s.bar && !chordAt(slots[j]); j++) last = slots[j];
      const w = last.x + last.w - s.x;
      // Left-aligned chords start a little inside their slot, which only costs
      // room at the end of the bar (the next chord starts inside its slot too).
      // The bar's last chord may also run a little past the barline.
      return s.n > 1 && last.k === s.n - 1 ? w - SLOT_CHORD_PAD + SLOT_CHORD_OVERHANG : w;
    };
    const gapOf = s => (s.n > 1 ? 2 : 4);
    const drawn = []; // per slot: where its chord was drawn, for the ties below
    slots.forEach(s => {
      const tie = chordTie(chordAt(s));
      const text = tie.chord;
      // Each chord is as big as its own spot allows: a roomy one-chord bar
      // keeps the full size, and only a chord squeezed into a crowded bar shrinks.
      const chordSize = text && !barSymbol(text) ? slotFontSize(text, roomOf(s), h, gapOf(s)) : 0;
      if (chordSize) drawn[s.idx] = { tied: tie.tied, size: chordSize, ...chordSlotSpan(text, s, chordSize) };
      const ext = barExtent[s.bar];
      const bar = { x: ext.x, w: ext.right - ext.x };
      const slotEl = svgRect(s.x + 1.5, s.y + 1.5, Math.max(s.w - 3, 1), Math.max(s.h - 3, 1), {
        cls: text ? 'el-chord-slot' : 'el-chord-slot empty',
      });
      g.appendChild(slotEl);
      wireDragAndClick(slotEl, dragRow, () => focusSlot(el.id, s.idx), el);
      if (text) drawSlotContent(g, text, s, bar, h, chordSize, s.n);
    });

    // A chord typed "Am-" is tied to the next chord in the row (across
    // barlines, over empty boxes); the tie bows down under the baseline. It
    // isn't drawn when nothing but a rest or a repeat sign follows.
    slots.forEach(s => {
      const from = drawn[s.idx];
      if (!from || !from.tied) return;
      let next = null;
      for (let j = s.idx + 1; j < slots.length && !next; j++) {
        const t = chordAt(slots[j]);
        if (!t) continue;
        if (barSymbol(t)) break;
        next = drawn[j];
      }
      if (!next) return;
      const y = s.y + h / 2 + from.size * 0.35 + from.size * 0.12;
      // It starts a little under the first chord, so it is wide even between
      // neighbouring chords, and ends just short of the next one.
      drawTie(g, from.x2 - from.size * 0.4, y, next.x1 - 2, y, 1, h * 1.4);
    });

    for (let i = 0; i <= n; i++) {
      if (i === 0 && el.repeatStart) continue; // a repeat mark replaces the plain barline at that edge
      if (i === n && el.repeatEnd) continue;
      const lx = el.x + i * barW;
      g.appendChild(svgHandDrawnBarline(lx, el.y, h, seedFromString(`${el.id}-${i}`), 'el-row-divider'));
    }

    if (el.repeatStart) {
      drawRepeatMark(g, el.x, el.y, REPEAT_MARK_W, h, 'start', `${el.id}-repeatStart`);
    }
    if (el.repeatEnd) {
      const rx = el.x + w - REPEAT_MARK_W;
      drawRepeatMark(g, rx, el.y, REPEAT_MARK_W, h, 'end', `${el.id}-repeatEnd`);
    }

    addResizeHandle(g, el.x + w, el.y + h, sizeDrag(el), el);

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
      null, el);

    addResizeHandle(g, el.x + w, el.y + h, sizeDrag(el), el);

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
    wireDragAndClick(label, moveTo, () => focusEditField('text'), el);
    g.appendChild(svgText(el.text || '', el.x + voltaTextPad(el), el.y + h / 2 + el.fontSize * 0.35 + 1, {
      cls: 'el-volta-text', size: el.fontSize,
    }));

    // The number scales with the bracket's height (see applySize), so
    // shrinking the corner shrinks the whole volta rather than cramping a
    // full-size number.
    addResizeHandle(g, el.x + w, el.y + h, sizeDrag(el), el);

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

    // The handles only show while this arrow is the selected one (clicked, in
    // the edit box), so an unselected arrow is just the line.
    if (selectedIds.size === 1 && selectedIds.has(el.id)) {
      const h1 = svgCircle(el.x1, el.y1, 5, { cls: 'el-arrow-handle' });
      wireDragAndClick(h1, (ddx, ddy) => { el.x1 = sx1 + ddx; el.y1 = sy1 + ddy; markDirty(); renderSvg(); }, null, null, el);
      g.appendChild(h1);

      const h2 = svgCircle(el.x2, el.y2, 5, { cls: 'el-arrow-handle' });
      wireDragAndClick(h2, (ddx, ddy) => { el.x2 = sx2 + ddx; el.y2 = sy2 + ddy; markDirty(); renderSvg(); }, null, null, el);
      g.appendChild(h2);

      // Bow handle: drag away from the straight-line midpoint to curve the
      // arrow. At (dx,dy)=(0,0) the quadratic control point sits exactly on
      // the line between the endpoints, so the path renders perfectly straight.
      const startBowDx = el.bow.dx, startBowDy = el.bow.dy;
      const hb = svgCircle(cx, cy, 4, { cls: 'el-arrow-bow-handle' });
      wireDragAndClick(hb, (ddx, ddy) => {
        el.bow.dx = startBowDx + ddx; el.bow.dy = startBowDy + ddy;
        markDirty(); renderSvg();
      }, null, null, el);
      g.appendChild(hb);
    }

    svg.appendChild(g);
  }

  // A glyph element's footprint after the wider/shorter scaling applied when
  // it's drawn (see GLYPH_SCALE_X/Y) -- used for both the render and its hit
  // box / bounds, so they stay in step with what's actually on the page.
  function glyphSize(el) {
    const w = Math.max(20, measureTextWidth(el.code, el.fontSize, 'MuseJazz') * GLYPH_SCALE_X);
    const h = el.fontSize * GLYPH_SCALE_Y;
    return { w, h };
  }
  function renderGlyphEl(svg, el) {
    const size = el.fontSize;
    const { w, h } = glyphSize(el);
    const g = svgGroup({ cls: 'el-group' });
    const hit = svgRect(el.x, el.y - h * 0.75, w, h, { cls: 'el-glyph-hit' });
    g.appendChild(hit);
    // Scaled around (el.x, el.y) -- its left edge / baseline -- so widening
    // and shortening it doesn't shift where it sits.
    const text = svgText(el.code, el.x, el.y, { cls: 'el-glyph-text', size });
    text.setAttribute('transform', `translate(${el.x} ${el.y}) scale(${GLYPH_SCALE_X} ${GLYPH_SCALE_Y}) translate(${-el.x} ${-el.y})`);
    g.appendChild(text);
    const startX = el.x, startY = el.y;
    wireDragAndClick(hit, (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); }, null, el);

    addResizeHandle(g, el.x + w, el.y + h * 0.25, fontDrag(el, LIMITS.glyphFont), el);

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

  // Draws one tuplet group inside a rhythm bar: `cell.cells.length` (3, in
  // v1) equal-width slots spanning `[x, x+w)`, each with its own hit-rect
  // wired the same way a plain cell's is -- a drag still moves the whole
  // bar, a click opens that slot's own restricted menu via
  // `onSlotClick(subIdx, clientX, clientY)`. Beamed together (with a plain
  // "3" over the beam) when every slot is a note of a beam-eligible shape;
  // bracketed (with a "3" in its gap) otherwise -- a quarter-note triplet
  // is never beam-eligible, and a beam is never drawn over a rest.
  function renderTupletGroupRhythm(container, cell, x, w, y, h, onSlotClick, onCellDrag, moveEl) {
    const n = cell.cells.length;
    const slotW = w / n;
    const headW = h * 0.33;
    const stemLen = h * 0.68;
    const beamThick = h * 0.16;
    const beamY = y - stemLen;
    const slotX = k => x + k * slotW;

    cell.cells.forEach((sub, k) => {
      const hit = svgRect(slotX(k), beamY - beamThick - 4, slotW, (y - beamY) + beamThick + h * 0.9, { cls: 'el-rhythm-cell-hit' });
      container.appendChild(hit);
      if (onCellDrag) wireDragAndClick(hit, onCellDrag, (clientX, clientY) => onSlotClick(k, clientX, clientY), moveEl);
      else hit.addEventListener('click', e => onSlotClick(k, e.clientX, e.clientY));
    });

    const beamed = cell.cells.every(sub => sub.type === 'note') && BEAM_ELIGIBLE_DURATIONS.has(cell.unit);
    if (beamed) {
      const stemXs = [];
      cell.cells.forEach((sub, k) => {
        const nx = slotX(k);
        const noteY = y + h * 0.05;
        const { stemX, stemY } = drawNoteheadSlash(container, nx, noteY, headW, h);
        stemXs.push(stemX);
        container.appendChild(svgLine(stemX, stemY, stemX, beamY, { cls: 'el-notegroup-stem' }));
        drawArticulations(container, {
          aboveX: stemX, aboveY: beamY - beamThick / 2,
          belowX: nx + headW / 2, belowY: noteY + headW * 0.38 + h * 0.05,
        }, sub.articulations, h * 1.2);
      });
      const primary = svgLine(stemXs[0], beamY, stemXs[stemXs.length - 1], beamY, { cls: 'el-notegroup-beam' });
      primary.setAttribute('stroke-width', beamThick);
      container.appendChild(primary);
      drawTupletNumber(container, stemXs[0], stemXs[stemXs.length - 1], beamY, -1, h * 0.55);
    } else {
      cell.cells.forEach((sub, k) => {
        const nx = slotX(k);
        if (sub.type === 'rest') {
          container.appendChild(svgText(rhythmCellGlyph(sub), nx + slotW / 2, y - h * 0.05, { cls: 'el-glyph-text', anchor: 'middle', size: h }));
        } else {
          drawSingleNote(container, nx, y, sub, h, headW, stemLen);
        }
      });
      drawTupletBracket(container, x + w * 0.04, x + w * 0.96, beamY, -1, h * 0.12, h * 0.55);
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

      if (cell.type === 'tuplet') {
        renderTupletGroupRhythm(container, cell, cellX, cellW, y, h,
          (subIdx, clientX, clientY) => onCellClick(i, clientX, clientY, subIdx), onCellDrag, moveEl);
        return;
      }

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

    // A tie under the slashes, from one note to the next (past its dot).
    cells.forEach((cell, i) => {
      if (!isTiedToNext(cells, i)) return;
      const dotted = cell.duration === 6 || cell.duration === 12 || cell.duration === 24 || cell.duration === 48;
      const depth = Math.max(articulationDepth(cell.articulations, h * 1.2, 1), articulationDepth(cells[i + 1].articulations, h * 1.2, 1));
      const tieY = y + h * 0.05 + headW * 0.38 + (depth ? h * 0.05 + depth : h * 0.08);
      drawTie(container, x + positionsPx[i] + headW * 0.8 + (dotted ? h * 0.25 : 0), tieY, x + positionsPx[i + 1] + headW * 0.2, tieY, 1, h * 1.2);
    });

    return { topY: beamY - beamThick - 4, bottomY: y + h * 0.4 };
  }

  function renderRhythmBarEl(svg, el) {
    const g = svgGroup({ cls: 'el-group' });
    const startX = el.x, startY = el.y;
    renderRhythmCells(g, el.cells, el.x, el.y, el.w, el.h,
      (idx, clientX, clientY, subIdx) => {
        if (subIdx != null) {
          openTupletSlotMenu(clientX, clientY, el.cells[idx], subIdx,
            () => { markDirty(); renderSvg(); },
            () => { el.cells = rebuildRhythmCells(el.cells, idx, { type: 'rest', duration: el.cells[idx].duration }); markDirty(); renderSvg(); });
          return;
        }
        openRhythmMenu(clientX, clientY, el.cells, idx, newCells => {
          el.cells = newCells; markDirty(); renderSvg();
        }, { onChange: () => { markDirty(); renderSvg(); } });
      },
      (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); },
      barBeatUnits(el.denominator || 4), el);

    // Width and height are independent -- dragging sideways spaces the cells
    // out without changing note size; dragging up/down scales the notes and
    // stems without changing the bar's overall width. The grab zone sits on the
    // bottom-right corner of the selection outline (see elementBounds).
    addResizeHandle(g, el.x + el.w, el.y + el.h, sizeDrag(el), el);

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
    const k = displayedKeySignature(el);
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

  // A vertical line across the staff at every bar boundary of `cells` (laid
  // out from `x` over width `w`, as renderStaffCells does), and one closing
  // the last bar.
  function drawStaffBarlines(container, el, x, w, cells) {
    staffLayout(el, cells, w).barlines.forEach(px => {
      container.appendChild(svgLine(x + px, el.y, x + px, el.y + el.h, { cls: 'el-staff-barline' }));
    });
    container.appendChild(svgLine(x + w, el.y, x + w, el.y + el.h, { cls: 'el-staff-barline' }));
  }

  function drawLedgerLines(container, el, cx, position, halfLen) {
    ledgerStepsFor(position).forEach(s => {
      container.appendChild(svgLine(cx - halfLen, pitchToY(s, el), cx + halfLen, pitchToY(s, el), { cls: 'el-ledger-line' }));
    });
  }

  // The hit area of one staff cell (or tuplet slot `k`), drawn under its ink.
  // On the page (`callbacks.onMove`) it spans the cell's whole column: a
  // click fires onCellClick and a drag moves the staff. In the staff editor a
  // rest keeps the column (a click selects it), but a note is only grabbable
  // by its head, where a drag re-pitches it (onNoteDrag) and a click selects it.
  function wireStaffCellHit(container, el, callbacks, cell, i, k, colX, colW, cx, pitch, halfW) {
    if (!callbacks.onCellClick && !callbacks.onMove) return;
    const click = () => { if (callbacks.onCellClick) callbacks.onCellClick(i, k); };
    if (cell.type === 'rest' || !callbacks.onNoteDrag) {
      const hit = svgRect(colX, el.y - el.h * 0.25, colW, el.h * 1.5, { cls: 'el-rhythm-cell-hit' });
      container.appendChild(hit);
      if (callbacks.onMove) wireDragAndClick(hit, callbacks.onMove, click, el);
      else hit.addEventListener('click', click);
      return;
    }
    const hitW = Math.max(halfW * 2 * 1.6, 12), hitH = el.h * 0.35;
    const hit = svgRect(cx - hitW / 2, pitchToY(pitch, el) - hitH / 2, hitW, hitH, { cls: 'el-note-hit' });
    container.appendChild(hit);
    // `pitch` is fixed for the whole gesture: a drag's own mousemove/mouseup
    // listeners outlive the re-renders it triggers, so this closure is what
    // keeps firing, and onNoteDrag applies ddy against it rather than the
    // already-moved pitch (which would compound every tick).
    wireDragAndClick(hit, (ddx, ddy) => callbacks.onNoteDrag(i, ddy, pitch, k), click);
  }

  // Sibling of renderTupletGroupRhythm: draws one tuplet group on the note
  // staff -- `cell.cells.length` (3, in v1) equal-width slots spanning
  // `[x, x+w)`, with real pitched noteheads (ledger lines, accidentals, a
  // stem direction from each note's own pitch) instead of the rhythm
  // tool's slashes. Handles its own hit-testing too, each slot exactly like
  // a plain cell (see wireStaffCellHit), routing back through
  // `callbacks.onCellClick` / `onNoteDrag` with the slot index. `i` is the
  // tuplet's own index in the outer `cells`.
  function renderTupletGroupStaff(container, cell, x, w, el, callbacks, i) {
    const subCells = cell.cells;
    const n = subCells.length;
    const slotW = w / n;
    const noteSize = el.h * 0.65;
    const stemLen = el.h * 0.68;
    const beamThick = el.h * 0.12;
    const stemHalf = NOTESTAFF_STEM_W / 2;
    const midlineY = pitchToY(4, el);

    const slotX = k => x + k * slotW;
    const cx = k => slotX(k) + slotW / 2;
    const pitchOf = k => (subCells[k].pitch != null ? subCells[k].pitch : STAFF_DEFAULT_PITCH);
    const halfWOf = k => noteheadHalfW(subCells[k].duration, noteSize);
    const stemXOf = (k, up) => cx(k) + (up ? 1 : -1) * (halfWOf(k) - stemHalf);
    const sel = k => (callbacks.selected && callbacks.selected(i, k) ? ' is-cell-selected' : '');

    subCells.forEach((sub, k) => {
      wireStaffCellHit(container, el, callbacks, sub, i, k, slotX(k), slotW, cx(k), pitchOf(k), halfWOf(k));
    });

    subCells.forEach((sub, k) => {
      if (sub.type === 'rest') {
        container.appendChild(svgText(rhythmCellGlyph(sub), cx(k), midlineY, { cls: `el-glyph-text${sel(k)}`, anchor: 'middle', size: el.h * 0.75 }));
        return;
      }
      const pitch = pitchOf(k), noteY = pitchToY(pitch, el), halfW = halfWOf(k);
      drawLedgerLines(container, el, cx(k), pitch, halfW + noteSize * 0.1);
      if (sub.accidental) {
        container.appendChild(svgText(ACCIDENTAL_CODES[sub.accidental], cx(k) - halfW - noteSize * 0.14, noteY, {
          cls: `el-notestaff-accidental${sel(k)}`, anchor: 'end', size: noteSize,
        }));
      }
      container.appendChild(svgText(noteheadCode(sub.duration), cx(k), noteY, {
        cls: `el-notehead-oval ${sub.duration >= 16 ? 'el-notehead-oval-open' : 'el-notehead-oval-filled'}${sel(k)}`,
        anchor: 'middle', size: noteSize,
      }));
    });

    // Eighth-shaped slots that are all notes beam together (with a plain "3"
    // over the beam); a quarter-shaped triplet is never beam-eligible, and
    // any group containing a rest falls back to individual stems/flags plus
    // a bracket (with a "3" in its gap) -- same choice as the rhythm tool.
    const beamed = subCells.every(sub => sub.type === 'note') && BEAM_ELIGIBLE_DURATIONS.has(cell.unit);
    if (beamed) {
      const avgPitch = subCells.reduce((s, sub, k) => s + pitchOf(k), 0) / n;
      const stemUp = avgPitch < 4;
      const extremePitch = stemUp
        ? Math.max(...subCells.map((s, k) => pitchOf(k)))
        : Math.min(...subCells.map((s, k) => pitchOf(k)));
      const beamY = pitchToY(extremePitch, el) + (stemUp ? -stemLen : stemLen);
      const stemXs = [];
      subCells.forEach((sub, k) => {
        const stemX = stemXOf(k, stemUp);
        stemXs.push(stemX);
        const stemStartY = pitchToY(pitchOf(k), el) + (stemUp ? -1 : 1) * noteSize * 0.04;
        container.appendChild(svgLine(stemX, stemStartY, stemX, beamY, { cls: `el-notegroup-stem${sel(k)}` }));
        drawArticulations(container, stemUp
          ? { aboveX: stemX, aboveY: beamY - beamThick / 2, belowX: cx(k), belowY: pitchToY(pitchOf(k), el) + el.h / 8 }
          : { aboveX: cx(k), aboveY: pitchToY(pitchOf(k), el) - el.h / 8, belowX: stemX, belowY: beamY + beamThick / 2 },
          sub.articulations, el.h * 0.85);
      });
      const primary = svgLine(stemXs[0] - stemHalf, beamY, stemXs[stemXs.length - 1] + stemHalf, beamY, { cls: 'el-notegroup-beam' });
      primary.setAttribute('stroke-width', beamThick);
      container.appendChild(primary);
      drawTupletNumber(container, stemXs[0], stemXs[stemXs.length - 1], beamY, stemUp ? -1 : 1, el.h * 0.5);
    } else {
      let topY = pitchToY(STAFF_PITCH_MAX, el);
      subCells.forEach((sub, k) => {
        if (sub.type === 'rest') return;
        const pitch = pitchOf(k);
        const stemUp = pitch < 4;
        const stemX = stemXOf(k, stemUp);
        const noteY = pitchToY(pitch, el);
        const stemStartY = noteY + (stemUp ? -1 : 1) * noteSize * 0.04;
        const stemTipY = stemUp ? noteY - stemLen : noteY + stemLen;
        container.appendChild(svgLine(stemX, stemStartY, stemX, stemTipY, { cls: `el-notegroup-stem${sel(k)}` }));
        topY = Math.min(topY, stemTipY);
        if (sub.duration === 2 || sub.duration === 4 || sub.duration === 6) {
          const flagCode = sub.duration === 2
            ? (stemUp ? FLAG_CODES['16th-up'] : FLAG_CODES['16th-down'])
            : (stemUp ? FLAG_CODES['8th-up'] : FLAG_CODES['8th-down']);
          container.appendChild(svgText(flagCode, stemX - stemHalf, stemTipY, { cls: `el-notestaff-flag${sel(k)}`, anchor: 'start', size: noteSize }));
        }
        drawArticulations(container, stemUp
          ? { aboveX: stemX, aboveY: stemTipY, belowX: cx(k), belowY: noteY + el.h / 8 }
          : { aboveX: cx(k), aboveY: noteY - el.h / 8, belowX: stemX, belowY: stemTipY },
          sub.articulations, el.h * 0.85);
      });
      drawTupletBracket(container, x + w * 0.04, x + w * 0.96, topY - el.h * 0.12, -1, el.h * 0.1, el.h * 0.5);
    }
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
  // `callbacks` (all optional; none at all draws a plain preview, like the
  // sidebar builder's) is `{ onCellClick(idx, subIdx), onMove(ddx, ddy),
  // onNoteDrag(idx, ddy, startPitch, subIdx), selected(idx, subIdx), onOpen() }`
  // -- see wireStaffCellHit for what a press on a cell does. A drag anywhere
  // else on a placed staff moves it, and a double-click there fires onOpen.
  // `selected` cells are drawn in the selection colour.
  // Returns the drawing's vertical reach and `cellBoxes`, where each cell
  // (and each tuplet slot, in `subs`) sits: `{ x, w, cx }`, cx being where
  // its head or rest is centred.
  function renderStaffCells(container, cells, x, y, w, el, callbacks = {}) {
    const totalUnits = cells.reduce((s, c) => s + c.duration, 0);
    const { widths: cellWidths, offsets: positionsPx } = staffLayout(el, cells, w);
    let cursor = 0;
    const positions = cells.map(c => { const p = cursor; cursor += c.duration; return p; });
    const { runOf } = computeBeamRuns(cells, positions, barBeatUnits(el.denominator || 4));

    const noteSize = el.h * 0.65;
    const stemLen = el.h * 0.68;
    const beamThick = el.h * 0.12;
    const beamGap = el.h * 0.16;
    const midlineY = pitchToY(4, el);
    const stemHalf = NOTESTAFF_STEM_W / 2;

    const slotW = 2 * cellWidths.reduce((s, cw) => s + cw, 0) / totalUnits; // a 16th's share of the room
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
    const sel = k => (callbacks.selected && callbacks.selected(k, null) ? ' is-cell-selected' : '');

    const cellBoxes = cells.map((cell, i) => {
      const bx = x + positionsPx[i], bw = cellWidths[i];
      if (cell.type !== 'tuplet') return { x: bx, w: bw, cx: cell.type === 'rest' ? restCx(i) : noteCx(i) };
      const sw = bw / cell.cells.length;
      return { x: bx, w: bw, cx: bx + bw / 2, subs: cell.cells.map((_, k) => ({ x: bx + k * sw, w: sw, cx: bx + (k + 0.5) * sw })) };
    });

    if (callbacks.onMove) {
      const body = svgRect(el.x, el.y - el.h * 0.35, x + w - el.x, el.h * 1.7, { cls: 'el-row-hit' });
      container.appendChild(body);
      wireDragAndClick(body, callbacks.onMove, null, el);
      if (callbacks.onOpen) body.addEventListener('dblclick', () => callbacks.onOpen());
    }

    cells.forEach((cell, i) => {
      if (cell.type === 'tuplet') {
        renderTupletGroupStaff(container, cell, x + positionsPx[i], cellWidths[i], el, callbacks, i);
        return;
      }
      wireStaffCellHit(container, el, callbacks, cell, i, null, x + positionsPx[i], cellWidths[i], noteCx(i), pitchOf(i), halfWOf(i));
    });

    const handledRunStarts = new Set();
    // Where each note's articulations go (see drawArticulations): its highest
    // and lowest ink -- the stem tip / beam on whichever side the stem points,
    // else the notehead -- and the x to center on at each end.
    const articulationAnchor = new Map();
    const stemUpAt = new Map(); // which way each note's stem points (a tie bows the other way)
    const headTopY = k => pitchToY(pitchOf(k), el) - el.h / 8;
    const headBottomY = k => pitchToY(pitchOf(k), el) + el.h / 8;
    cells.forEach((cell, i) => {
      // Already fully drawn (hits, noteheads/rests, beam or bracket) in the
      // hit-testing pass above -- see renderTupletGroupStaff.
      if (cell.type === 'tuplet') return;
      if (cell.type === 'rest') {
        container.appendChild(svgText(rhythmCellGlyph(cell), restCx(i), midlineY, { cls: `el-glyph-text${sel(i)}`, anchor: 'middle', size: el.h * 0.75 }));
        return;
      }
      const cx = noteCx(i), halfW = halfWOf(i);
      const pitch = pitchOf(i);
      const noteY = pitchToY(pitch, el);
      drawLedgerLines(container, el, cx, pitch, halfW + noteSize * 0.1);

      if (cell.accidental) {
        container.appendChild(svgText(ACCIDENTAL_CODES[cell.accidental], cx - halfW - noteSize * 0.14, noteY, {
          cls: `el-notestaff-accidental${sel(i)}`, anchor: 'end', size: noteSize,
        }));
      }
      container.appendChild(svgText(noteheadCode(cell.duration), cx, noteY, {
        cls: `el-notehead-oval ${cell.duration >= 16 ? 'el-notehead-oval-open' : 'el-notehead-oval-filled'}${sel(i)}`,
        anchor: 'middle', size: noteSize,
      }));
      if (cell.duration === 6 || cell.duration === 12 || cell.duration === 24 || cell.duration === 48) {
        // A note on a line gets its dot in the space above, like engraved
        // music, not struck through by the line.
        const dotY = pitch % 2 === 0 ? noteY - el.h / 8 : noteY;
        container.appendChild(svgText(AUG_DOT, cx + halfW + noteSize * 0.1, dotY, { cls: `el-glyph-text${sel(i)}`, size: noteSize }));
      }
      if (cell.duration === 32 || cell.duration === 48) { // whole notes: no stem
        stemUpAt.set(i, pitch < 4);
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
        for (let k = run.start; k <= run.end; k++) stemUpAt.set(k, stemUp);
        const extremePitch = stemUp
          ? Math.max(...runCells.map((c, k) => pitchOf(run.start + k)))
          : Math.min(...runCells.map((c, k) => pitchOf(run.start + k)));
        const beamY = pitchToY(extremePitch, el) + (stemUp ? -stemLen : stemLen);
        const stemXs = [];
        for (let k = run.start; k <= run.end; k++) {
          const stemX = stemXOf(k, stemUp);
          stemXs.push(stemX);
          container.appendChild(svgLine(stemX, stemStartYOf(k, stemUp), stemX, beamY, { cls: `el-notegroup-stem${sel(k)}` }));
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
        stemUpAt.set(i, stemUp);
        const stemX = stemXOf(i, stemUp);
        const stemTipY = stemUp ? noteY - stemLen : noteY + stemLen;
        container.appendChild(svgLine(stemX, stemStartYOf(i, stemUp), stemX, stemTipY, { cls: `el-notegroup-stem${sel(i)}` }));
        articulationAnchor.set(i, stemUp
          ? { aboveX: stemX, aboveY: stemTipY, belowX: cx, belowY: headBottomY(i) }
          : { aboveX: cx, aboveY: headTopY(i), belowX: stemX, belowY: stemTipY });
        if (cell.duration === 2 || cell.duration === 4 || cell.duration === 6) {
          const flagCode = cell.duration === 2
            ? (stemUp ? FLAG_CODES['16th-up'] : FLAG_CODES['16th-down'])
            : (stemUp ? FLAG_CODES['8th-up'] : FLAG_CODES['8th-down']);
          container.appendChild(svgText(flagCode, stemX - stemHalf, stemTipY, { cls: `el-notestaff-flag${sel(i)}`, anchor: 'start', size: noteSize }));
        }
      }
    });

    articulationAnchor.forEach((a, i) => {
      drawArticulations(container, a, cells[i].articulations, el.h * 0.85);
    });

    // A tie runs from a note to the one after it, on the side opposite its
    // stem, starting after its augmentation dot and stopping short of the next
    // note's accidental.
    cells.forEach((cell, i) => {
      if (!isTiedToNext(cells, i)) return;
      const next = cells[i + 1];
      const dir = stemUpAt.get(i) ? 1 : -1;
      const dotted = cell.duration === 6 || cell.duration === 12 || cell.duration === 24 || cell.duration === 48;
      const x1 = noteCx(i) + halfWOf(i) * 0.5 + (dotted ? noteSize * 0.3 : 0);
      const x2 = noteCx(i + 1) - (next.accidental ? halfWOf(i + 1) + noteSize * 0.5 : halfWOf(i + 1) * 0.5);
      // Just off the heads, or past whatever articulations sit on that side.
      const depth = Math.max(articulationDepth(cell.articulations, el.h * 0.85, dir), articulationDepth(next.articulations, el.h * 0.85, dir));
      const edge = depth ? el.h / 8 + depth : el.h * 0.1;
      drawTie(container, x1, pitchToY(pitchOf(i), el) + dir * edge, x2, pitchToY(pitchOf(i + 1), el) + dir * edge, dir, el.h);
    });

    return {
      topY: pitchToY(STAFF_PITCH_MAX, el) - el.h * 0.3,
      bottomY: pitchToY(STAFF_PITCH_MIN, el) + el.h * 0.3,
      cellBoxes,
    };
  }

  // Transposed with the sheet, a staff's notes are drawn from copies with the
  // pitch and accidental as they read now; the stored cells stay as they were
  // written. Anything picked or typed on a copy goes back through
  // storedStaffNote.
  function displayedCells(el) {
    const show = c => {
      if (c.type !== 'note') return c;
      const n = displayedStaffNote(el, c);
      return { ...c, pitch: n.pitch, accidental: n.accidental };
    };
    return el.cells.map(c => (c.type === 'tuplet' ? { ...c, cells: c.cells.map(show) } : show(c)));
  }

  // On the page a staff is only laid out: moved, squeezed and resized. A
  // click on a note or rest opens the staff editor on it (see openStaffEditor).
  function renderNoteStaffEl(svg, el) {
    const g = svgGroup({ cls: 'el-group' });
    const startX = el.x, startY = el.y;
    const leadW = notestaffLeadWidth(el);
    const moveTo = (ddx, ddy) => { el.x = startX + ddx; el.y = startY + ddy; markDirty(); renderSvg(); };

    drawStaffLines(g, el);
    drawClef(g, el);
    drawKeySignature(g, el);
    drawStaffBarlines(g, el, el.x + leadW, el.w, el.cells);

    renderStaffCells(g, displayedCells(el), el.x + leadW, el.y, el.w, el, {
      onCellClick: (idx, subIdx) => openStaffEditor(el, { idx, subIdx }),
      onOpen: () => openStaffEditor(el),
      onMove: moveTo,
    });

    addMoveHandle(g, el.x - 8, el.y + el.h / 2, moveTo, el);

    // Same as the rhythm bar: width re-spaces cells, height rescales the notes
    // and staff. The grab zone sits on the bottom-right corner of the
    // selection outline (see elementBounds), where it is looked for.
    addResizeHandle(g, el.x + leadW + el.w, el.y + el.h * 1.4, sizeDrag(el), el);

    svg.appendChild(g);
  }

  function renderElement(svg, el) {
    if (el.type === 'title') renderTextEl(svg, el, { boxed: true, textCls: 'el-title-text' });
    else if (el.type === 'chordText') renderTextEl(svg, el, { boxed: false, textCls: 'el-chord-text', chord: true });
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
    if (sharePdf) { sharePdf = null; viewerPrintBtn.textContent = 'Share PDF'; }
    const svg = document.getElementById('sheet-svg');
    svg.setAttribute('viewBox', `0 0 ${PAGE_W} ${PAGE_H}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    ensureDefs(svg);

    svg.appendChild(svgRect(0, 0, PAGE_W, PAGE_H, { cls: 'page-bg' }));

    const titleStr = model.title || 'Untitled';
    svg.appendChild(svgText(titleStr, PAGE_W / 2, PAGE_MARGIN, { cls: 'page-title-text', anchor: 'middle', size: 22 }));
    const artistStr = String(model.artist || '').trim();
    if (artistStr) {
      svg.appendChild(svgText(artistStr, PAGE_W / 2, PAGE_MARGIN + 22, { cls: 'page-key-text', anchor: 'middle', size: 13 }));
    }
    const keyStr = transposeState.semitones ? transposedKeyName() : model.key;
    if (keyStr) {
      svg.appendChild(svgText(`Key: ${keyStr}`, PAGE_W - PAGE_MARGIN, PAGE_MARGIN, { cls: 'page-key-text', anchor: 'end', size: 15 }));
    }

    model.elements.forEach(el => renderElement(svg, el));
    drawSelectionOverlay(svg);
    syncEditBox();
  }

  function render() {
    document.getElementById('viewer-title').textContent = model.title || 'Untitled';
    document.getElementById('viewer-artist').textContent = model.artist || '';
    document.getElementById('sheet-title').value = model.title;
    document.getElementById('sheet-artist').value = model.artist || '';
    document.getElementById('sheet-key').value = model.key;
    renderTransposeBox();
    renderSvg();
  }

  /* ---------- save status ---------- */
  function markDirty() { dirty = true; updateSaveStatus(); }
  function updateSaveStatus() {
    const el = document.getElementById('save-status');
    el.textContent = dirty ? 'Unsaved' : 'Saved';
    el.classList.toggle('unsaved', dirty);
  }

  /* ---------- floating note-menu items ---------- */
  // Every entry the note/rest picker menu (openRhythmMenu) can show. Which
  // ones are on is chosen in the edit box, so rarely used items can live here
  // without cluttering the menu: give a new item `defaultOn: false` and it
  // stays hidden until someone ticks it. Ids: `note-<dur>` / `rest-<dur>` /
  // `triplet-<dur>` (durations, matching RHYTHM_MENU_OPTIONS), `artic-<kind>`,
  // `tie`.
  const NOTE_MENU_GROUPS = [
    { id: 'duration', label: 'Notes' },
    { id: 'rest', label: 'Rests' },
    { id: 'tuplet', label: 'Tuplets' },
    { id: 'articulation', label: 'Articulations' },
    { id: 'tie', label: 'Tie' },
  ];
  const NOTE_MENU_ITEMS = [
    ...RHYTHM_MENU_OPTIONS.map(o => ({
      id: `${o.type}-${o.duration}`,
      group: o.type === 'note' ? 'duration' : o.type === 'triplet' ? 'tuplet' : 'rest',
      label: o.label, defaultOn: true,
    })),
    ...ARTICULATION_KINDS.map(k => ({ id: `artic-${k.value}`, group: 'articulation', label: k.label, defaultOn: true })),
    { id: 'tie', group: 'tie', label: 'Tie to next note', defaultOn: true },
  ];
  const NOTE_MENU_BY_ID = Object.fromEntries(NOTE_MENU_ITEMS.map(i => [i.id, i]));
  // An editor preference rather than sheet content, so it lives in this
  // browser (`{ id: bool }` overrides; anything absent follows `defaultOn`).
  const NOTE_MENU_STORAGE_KEY = 'leadsheet.noteMenu.v1';
  let noteMenuPrefs = {};
  try {
    const saved = JSON.parse(localStorage.getItem(NOTE_MENU_STORAGE_KEY));
    if (saved && typeof saved === 'object') noteMenuPrefs = saved;
  } catch (err) { /* storage unavailable: defaults */ }
  function saveNoteMenuPrefs() {
    try { localStorage.setItem(NOTE_MENU_STORAGE_KEY, JSON.stringify(noteMenuPrefs)); } catch (err) { /* ignore */ }
  }
  function isMenuItemOn(id) {
    const item = NOTE_MENU_BY_ID[id];
    if (!item) return true;
    return id in noteMenuPrefs ? !!noteMenuPrefs[id] : item.defaultOn;
  }
  let noteMenuSectionOpen = false;

  /* ---------- edit-box setters ---------- */
  // The logic behind the edit box's fields, kept apart from the DOM code.
  function ensureChords(row) {
    if (!row.chords) row.chords = [];
    const total = rowSlotCount(row);
    while (row.chords.length < total) row.chords.push('');
  }
  // Re-lays the flat `chords` list out for new per-bar counts: every bar keeps
  // its first min(old, new) chords, so what is typed stays in its (bar, box).
  function remapChords(row, oldCounts, newCounts) {
    const old = row.chords || [];
    const out = [];
    let at = 0;
    newCounts.forEach((n, i) => {
      const had = oldCounts[i] || 0;
      for (let k = 0; k < n; k++) out.push(k < had ? (old[at + k] || '') : '');
      at += had;
    });
    row.chords = out;
  }
  // Stores per-bar counts the shortest way: when every bar agrees they collapse
  // back into the row's `chordsPerBar`, so `chordCounts` only exists while
  // bars really differ (and the two never contradict each other).
  function storeBarCounts(row, counts) {
    if (counts.every(c => c === counts[0])) {
      delete row.chordCounts;
      if (counts[0] > 0) row.chordsPerBar = counts[0]; else delete row.chordsPerBar;
    } else {
      row.chordCounts = counts;
    }
    if (!counts.some(c => c > 0)) delete row.chords;
    activeSlot = null;
  }
  // Keeps each bar's width (adding a bar adds a bar), but never lets the row
  // grow past the right page margin: then the bars squeeze instead. New bars
  // get the row's default chord count; existing bars keep theirs.
  function setRowBars(row, n) {
    n = clamp(Math.round(n) || 1, 1, ROW_MAX_BARS);
    if (n === row.barCount) return;
    const oldCounts = rowBarCounts(row); // before barCount changes
    const barW = row.w / row.barCount;
    const room = Math.max(PAGE_W - PAGE_MARGIN - row.x, row.w);
    row.w = clamp(n * barW, LIMITS.row.w[0], Math.min(ROW_MAX_W, room));
    row.barCount = n;
    const cpb = row.chordsPerBar || 0;
    const counts = Array.from({ length: n }, (_, i) => (i < oldCounts.length ? oldCounts[i] : cpb));
    remapChords(row, oldCounts, counts); // rebuilt rather than resized, so a removed bar's chords don't come back when one is added again
    storeBarCounts(row, counts);
  }
  // Every bar gets `cpb` chord boxes (the edit box's "all bars" stepper).
  function setRowChordsPerBar(row, cpb) {
    cpb = clamp(Math.round(cpb) || 0, 0, ROW_MAX_CHORDS);
    if (!row.chordCounts && (row.chordsPerBar || 0) === cpb) return;
    const counts = Array(row.barCount).fill(cpb);
    remapChords(row, rowBarCounts(row), counts);
    storeBarCounts(row, counts);
  }
  // Just bar `bar` (0-based) gets `n` chord boxes.
  function setRowBarChords(row, bar, n) {
    const counts = rowBarCounts(row);
    if (bar < 0 || bar >= counts.length) return;
    const next = counts.slice();
    next[bar] = clamp(Math.round(n) || 0, 0, ROW_MAX_CHORDS);
    if (next[bar] === counts[bar]) return;
    remapChords(row, counts, next);
    storeBarCounts(row, next);
  }
  function fitRowToPage(row) {
    row.x = PAGE_MARGIN;
    row.w = ROW_MAX_W;
  }

  // Keeps the leading cells that still fit a bar of `totalUnits`, and fills the
  // rest with 16th rests -- a time-signature change keeps what was written.
  function refitCells(cells, totalUnits) {
    const out = [];
    let used = 0;
    for (const c of cells) {
      if (used + c.duration > totalUnits) break;
      out.push(JSON.parse(JSON.stringify(c)));
      used += c.duration;
    }
    for (; used < totalUnits; used += 2) out.push({ type: 'rest', duration: 2 });
    return out;
  }
  // Shared by the rhythm bar and the note staff. The width follows the bar's
  // length, so the spacing per beat stays as it was. A staff refits each of
  // its bars on its own, so a note never ends up across a barline.
  function setBarTimeSig(el, num, den) {
    const bars = el.type === 'notestaff' ? staffBarCount(el) : 1;
    const oldUnits = barTotalUnits(el.numerator || 4, el.denominator || 4);
    el.numerator = clamp(Math.round(num) || 4, 1, 32);
    el.denominator = den;
    const newUnits = barTotalUnits(el.numerator, el.denominator);
    if (bars === 1 && el.type !== 'notestaff') {
      el.cells = refitCells(el.cells, newUnits);
    } else {
      const perBar = splitStaffBars(el.cells, oldUnits);
      el.cells = [];
      for (let b = 0; b < bars; b++) el.cells.push(...refitCells(perBar[b] || [], newUnits));
    }
    applySize(el, el.w * newUnits / oldUnits, null);
  }
  // A staff's flat cell list cut into bars of `barUnits` (no cell crosses a boundary).
  function splitStaffBars(cells, barUnits) {
    const bars = [[]];
    let used = 0;
    cells.forEach(c => {
      if (used >= barUnits) { bars.push([]); used = 0; }
      bars[bars.length - 1].push(c);
      used += c.duration;
    });
    return bars;
  }
  // Refills the bar(s) with notes of `unit` 32nds each (0 = all rests).
  function fillCells(el, unit) {
    const total = barTotalUnits(el.numerator || 4, el.denominator || 4);
    const staff = el.type === 'notestaff';
    const cells = [];
    let used = 0;
    if (unit) {
      for (; used + unit <= total; used += unit) {
        cells.push(staff ? { type: 'note', duration: unit, pitch: STAFF_DEFAULT_PITCH, accidental: null } : { type: 'note', duration: unit });
      }
    }
    for (; used < total; used += 2) cells.push({ type: 'rest', duration: 2 });
    if (!unit) cells.splice(0, cells.length, ...defaultBeatCells(el.numerator || 4, el.denominator || 4, 1));
    if (!staff) { el.cells = cells; return; }
    // Every bar gets the same fill. The pitch is the middle line as drawn, so
    // a transposed staff doesn't jump.
    const first = storedStaffNote(el, STAFF_DEFAULT_PITCH, null);
    el.cells = [];
    for (let b = 0; b < staffBarCount(el); b++) {
      cells.forEach(c => el.cells.push(c.type === 'note' ? { ...c, pitch: first.pitch, accidental: first.accidental } : { ...c }));
    }
  }
  // Changes how many bars a staff has: new bars start as rests, dropped ones
  // take their notes with them, and the width follows so each bar keeps its size.
  function setStaffBars(el, n) {
    const oldBars = staffBarCount(el);
    const bars = clamp(Math.round(n) || 1, 1, STAFF_MAX_BARS);
    const barUnits = staffBarUnits(el);
    const perBar = splitStaffBars(el.cells, barUnits);
    el.cells = [];
    for (let b = 0; b < bars; b++) {
      el.cells.push(...(perBar[b] || defaultBeatCells(el.numerator || 4, el.denominator || 4, 1)));
    }
    el.bars = bars;
    applySize(el, el.w * bars / oldBars, null);
  }
  // Moves every note by `steps` staff steps (7 = an octave), as far as the
  // staff allows, keeping the intervals between them.
  function transposeStaff(el, steps) {
    const notes = el.cells.filter(c => c.type === 'note');
    if (!notes.length) return;
    const pitchOf = c => (c.pitch != null ? c.pitch : STAFF_DEFAULT_PITCH);
    const lo = STAFF_PITCH_MIN - Math.min(...notes.map(pitchOf));
    const hi = STAFF_PITCH_MAX - Math.max(...notes.map(pitchOf));
    const d = clamp(steps, lo, hi);
    notes.forEach(c => { c.pitch = pitchOf(c) + d; });
  }
  /* ---------- note staff: editing operations ---------- */
  // What the staff editor's keys and toolbar do (see openStaffEditor), kept
  // apart from its DOM code. A place in a staff is `{ idx, subIdx }`: cell
  // `idx` of `el.cells`, or with a `subIdx` one slot of the tuplet there
  // (`subIdx` is null otherwise). Pitches are worked on as drawn, so a
  // transposed staff is written in the key it shows, and stored back through
  // storedStaffNote. Each returns false when it can't apply.
  const NOTE_DURATIONS = [48, 32, 24, 16, 12, 8, 6, 4, 2];
  const REST_DURATIONS = [32, 16, 12, 8, 6, 4, 2]; // the rests rhythmCellGlyph can draw
  const DOTTED = { 4: 6, 8: 12, 16: 24, 32: 48 };
  const UNDOTTED = { 6: 4, 12: 8, 24: 16, 48: 32 };
  function cellStart(cells, idx) { return cells.slice(0, idx).reduce((s, c) => s + c.duration, 0); }
  function cellAt(el, addr) {
    const c = el.cells[addr.idx];
    return c && addr.subIdx != null ? c.cells[addr.subIdx] : c;
  }
  function sameAddr(a, b) { return !!a && !!b && a.idx === b.idx && a.subIdx === b.subIdx; }
  // Every place in reading order: each plain cell, each tuplet slot.
  function staffAddresses(el) {
    const out = [];
    el.cells.forEach((c, idx) => {
      if (c.type === 'tuplet') c.cells.forEach((_, subIdx) => out.push({ idx, subIdx }));
      else out.push({ idx, subIdx: null });
    });
    return out;
  }
  // From the start of cell `idx` to the end of its bar.
  function roomInBar(el, idx) {
    const barUnits = staffBarUnits(el);
    return barUnits - cellStart(el.cells, idx) % barUnits;
  }
  // A plain note and the notes tied to it on either side: a pitch change
  // moves them all, as in MuseScore.
  function tieChain(el, addr) {
    if (addr.subIdx != null) return [cellAt(el, addr)];
    let a = addr.idx, b = addr.idx;
    while (a > 0 && isTiedToNext(el.cells, a - 1)) a--;
    while (isTiedToNext(el.cells, b)) b++;
    return el.cells.slice(a, b + 1);
  }
  function setShownNote(el, cell, pitch, accidental) {
    const stored = storedStaffNote(el, pitch, accidental);
    cell.pitch = stored.pitch;
    cell.accidental = stored.accidental;
  }
  function setChainNote(el, addr, pitch, accidental) {
    tieChain(el, addr).forEach(c => setShownNote(el, c, pitch, accidental));
  }
  // The staff position of `letter` nearest `near` (both as drawn).
  function pitchForLetter(letter, clef, near) {
    let best = null;
    for (let p = STAFF_PITCH_MIN; p <= STAFF_PITCH_MAX; p++) {
      if (staffLetterForPosition(p, clef) === letter && (best == null || Math.abs(p - near) < Math.abs(best - near))) best = p;
    }
    return best;
  }
  // The drawn pitch of the last note before `addr`: what a typed letter's
  // octave is judged from.
  function pitchBefore(el, addr) {
    const list = staffAddresses(el);
    const at = list.findIndex(a => sameAddr(a, addr));
    for (let k = (at < 0 ? list.length : at) - 1; k >= 0; k--) {
      const c = cellAt(el, list[k]);
      if (c.type === 'note') return displayedStaffNote(el, c).pitch;
    }
    return STAFF_DEFAULT_PITCH;
  }

  // The note (or rest, which becomes a note) at `addr` goes to `letter`, in
  // the octave nearest where it was, with the key's own accidental.
  function setNoteLetter(el, addr, letter) {
    const cell = cellAt(el, addr);
    if (!cell || cell.type === 'tuplet') return false;
    const near = cell.type === 'note' ? displayedStaffNote(el, cell).pitch : pitchBefore(el, addr);
    cell.type = 'note';
    setChainNote(el, addr, pitchForLetter(letter, el.clef || 'treble', near), null);
    return true;
  }
  // A semitone up or down, sharpened going up and flattened going down unless
  // the key already spells it (see transposeStaffNote).
  function stepSemitone(el, addr, dir) {
    const cell = cellAt(el, addr);
    if (!cell || cell.type !== 'note') return false;
    const shown = displayedStaffNote(el, cell);
    const sig = displayedKeySignature(el);
    const next = transposeStaffNote(shown, el.clef || 'treble', sig, sig, dir, dir < 0);
    // transposeStaffNote folds a note that leaves the staff back by an
    // octave; stepping stops at the edge instead.
    if (Math.abs(next.pitch - shown.pitch) > 1) return false;
    setChainNote(el, addr, next.pitch, next.accidental);
    return true;
  }
  // `steps` staff steps (7 = an octave). A single step lands on the key's own
  // note, like MuseScore's diatonic up/down; an octave keeps the accidental.
  function stepStaff(el, addr, steps) {
    const cell = cellAt(el, addr);
    if (!cell || cell.type !== 'note') return false;
    const shown = displayedStaffNote(el, cell);
    const pitch = shown.pitch + steps;
    if (pitch < STAFF_PITCH_MIN || pitch > STAFF_PITCH_MAX) return false;
    setChainNote(el, addr, pitch, Math.abs(steps) === 7 ? shown.accidental : null);
    return true;
  }
  // Sets the accidental as drawn, or back to the key's own when it's already set.
  function toggleAccidental(el, addr, accidental) {
    const cell = cellAt(el, addr);
    if (!cell || cell.type !== 'note') return false;
    const shown = displayedStaffNote(el, cell);
    setChainNote(el, addr, shown.pitch, shown.accidental === accidental ? null : accidental);
    return true;
  }

  // A plain cell's new length, if it fits before the barline. A tuplet
  // slot's length is fixed (it's what keeps the group adding up).
  function setCellDuration(el, addr, duration) {
    if (addr.subIdx != null) return false;
    const cell = el.cells[addr.idx];
    if (!cell || cell.type === 'tuplet') return false;
    if (!(cell.type === 'rest' ? REST_DURATIONS : NOTE_DURATIONS).includes(duration)) return false;
    if (duration > roomInBar(el, addr.idx)) return false;
    if (duration !== cell.duration) el.cells = replaceCellKeeping(el.cells, addr.idx, { type: cell.type, duration }, el);
    return true;
  }
  function dotToggled(duration) { return DOTTED[duration] || UNDOTTED[duration] || null; }
  function halved(duration) { return NOTE_DURATIONS.includes(duration / 2) ? duration / 2 : null; }
  function doubled(duration) { return NOTE_DURATIONS.includes(duration * 2) ? duration * 2 : null; }

  // The note or tuplet slot at `addr` becomes a rest. A tuplet slot that
  // already is one takes the whole tuplet with it.
  function toRest(el, addr) {
    const cell = el.cells[addr.idx];
    if (!cell) return false;
    const barUnits = staffBarUnits(el);
    const wholeCellToRests = () => {
      el.cells = rebuildRhythmCells(el.cells, addr.idx, restsForGap(cellStart(el.cells, addr.idx) % barUnits, cell.duration)[0], barUnits);
    };
    if (addr.subIdx != null) {
      if (cell.cells[addr.subIdx].type === 'rest') wholeCellToRests();
      else cell.cells[addr.subIdx] = { type: 'rest', duration: cell.unit };
      return true;
    }
    if (cell.type === 'rest') return false;
    wholeCellToRests();
    return true;
  }
  // An eighth- or quarter-note triplet (`duration` 8 or 16: the group's
  // length) in place of whatever starts at cell `idx`.
  function makeTriplet(el, idx, duration) {
    if ((duration !== 8 && duration !== 16) || idx >= el.cells.length || duration > roomInBar(el, idx)) return false;
    el.cells = rebuildRhythmCells(el.cells, idx, makeTupletCell(duration / 2), staffBarUnits(el));
    return true;
  }
  // Ties the note at `addr` to the next one, which takes its pitch (a tie
  // joins two of the same note); a second time unties them.
  function toggleTie(el, addr) {
    if (addr.subIdx != null || !canTieCell(el.cells, addr.idx)) return false;
    const cell = el.cells[addr.idx];
    toggleCellTie(cell);
    if (cell.tie) {
      const next = el.cells[addr.idx + 1];
      next.pitch = cell.pitch;
      next.accidental = cell.accidental || null;
    }
    return true;
  }
  function toggleArticulation(el, addr, kind) {
    const cell = cellAt(el, addr);
    if (!cell || cell.type !== 'note') return false;
    toggleCellArticulation(cell, kind);
    return true;
  }

  // Note input: writes a note or rest (`spec`: { type, duration, pitch,
  // accidental }, pitch as stored) at `cursor` over whatever is there, and
  // returns where it went (`written`) and the place after it (`next`), or
  // null when there's no room. As in MuseScore, a note running past the
  // barline carries on in the next bar as tied notes, and writing past the
  // last bar adds one (up to STAFF_MAX_BARS; past that it's cut short).
  // Inside a tuplet it fills the slot, whose length is fixed.
  function writeAtCursor(el, cursor, spec) {
    const fill = (cell, type) => {
      if (type === 'note') { cell.pitch = spec.pitch; cell.accidental = spec.accidental; }
      return cell;
    };
    if (cursor.subIdx != null) {
      const tuplet = el.cells[cursor.idx];
      tuplet.cells[cursor.subIdx] = fill({ type: spec.type, duration: tuplet.unit }, spec.type);
      const last = cursor.subIdx === tuplet.cells.length - 1;
      return { written: { ...cursor }, next: last ? { idx: cursor.idx + 1, subIdx: null } : { idx: cursor.idx, subIdx: cursor.subIdx + 1 } };
    }
    const values = spec.type === 'rest' ? REST_DURATIONS : NOTE_DURATIONS;
    const barUnits = staffBarUnits(el);
    let idx = cursor.idx, remaining = spec.duration, first = null;
    while (remaining > 0) {
      if (idx >= el.cells.length) {
        if (staffBarCount(el) >= STAFF_MAX_BARS) break;
        setStaffBars(el, staffBarCount(el) + 1);
      }
      let chunk = Math.min(remaining, roomInBar(el, idx));
      remaining -= chunk;
      while (chunk > 0) {
        const d = values.find(v => v <= chunk);
        el.cells = rebuildRhythmCells(el.cells, idx, fill({ type: spec.type, duration: d }, spec.type), barUnits);
        if (first == null) first = idx;
        else if (spec.type === 'note') el.cells[idx - 1].tie = true;
        chunk -= d;
        idx++;
      }
    }
    return first == null ? null : { written: { idx: first, subIdx: null }, next: { idx, subIdx: null } };
  }

  function reorderElement(el, toFront) {
    model.elements = model.elements.filter(e => e !== el);
    if (toFront) model.elements.push(el); else model.elements.unshift(el);
  }
  function alignToPage(el, mode) {
    const b = elementBounds(el);
    const dx = mode === 'center' ? (PAGE_W - b.w) / 2 - b.x : PAGE_MARGIN - b.x;
    applyOffset(el, snapshotPos(el), dx, 0);
  }
  // Aligns the selection's edges/centres to its own bounding box.
  function alignSelection(mode) {
    const els = model.elements.filter(e => selectedIds.has(e.id));
    const bs = els.map(elementBounds);
    const minX = Math.min(...bs.map(b => b.x)), maxX = Math.max(...bs.map(b => b.x + b.w));
    const minY = Math.min(...bs.map(b => b.y)), maxY = Math.max(...bs.map(b => b.y + b.h));
    els.forEach((el, i) => {
      const b = bs[i];
      let dx = 0, dy = 0;
      if (mode === 'left') dx = minX - b.x;
      else if (mode === 'center') dx = (minX + maxX) / 2 - (b.x + b.w / 2);
      else if (mode === 'right') dx = maxX - (b.x + b.w);
      else if (mode === 'top') dy = minY - b.y;
      else if (mode === 'middle') dy = (minY + maxY) / 2 - (b.y + b.h / 2);
      else if (mode === 'bottom') dy = maxY - (b.y + b.h);
      applyOffset(el, snapshotPos(el), dx, dy);
    });
  }
  // Spaces the selection so the gaps between neighbours are equal.
  function distributeSelection(axis) {
    const horiz = axis === 'h';
    const items = model.elements.filter(e => selectedIds.has(e.id)).map(el => ({ el, b: elementBounds(el) }));
    if (items.length < 3) return;
    const pos = b => (horiz ? b.x : b.y), size = b => (horiz ? b.w : b.h);
    items.sort((a, c) => pos(a.b) - pos(c.b));
    const first = pos(items[0].b);
    const last = items.reduce((m, i) => Math.max(m, pos(i.b) + size(i.b)), -Infinity);
    const gap = (last - first - items.reduce((s, i) => s + size(i.b), 0)) / (items.length - 1);
    let cursor = first;
    items.forEach(({ el, b }) => {
      const d = cursor - pos(b);
      applyOffset(el, snapshotPos(el), horiz ? d : 0, horiz ? 0 : d);
      cursor += size(b) + gap;
    });
  }

  /* ---------- edit box ---------- */
  // Everything about the selected element that isn't a drag, a squeeze or a
  // click lives here. Each element type has a schema (a list of sections of
  // fields, see EDIT_SCHEMAS); the box is rebuilt from it when the selection
  // changes, and its inputs are refreshed in place after every render, so
  // dragging or squeezing an element on the page updates its numbers live.
  const editBox = document.getElementById('edit-box');
  let editBoxSig = null;     // which selection the box was last built for
  let editBoxSyncs = [];     // one refresher per input
  let editBoxBuilding = false;

  const ELEMENT_NAMES = {
    title: 'Title box', chordText: 'Chord text', text: 'Text', row: 'Bars', repeat: 'Repeat sign',
    volta: 'Volta ending', arrow: 'Arrow', glyph: 'Symbol', rhythmbar: 'Rhythm bar', notestaff: 'Note staff',
  };
  const TEXT_TYPE_OPTIONS = [
    { value: 'title', label: 'Title box' }, { value: 'chordText', label: 'Chord text' }, { value: 'text', label: 'Text' },
  ];
  const GLYPH_OPTIONS = [
    { value: '', label: 'Repeat bar (%)' }, { value: '', label: 'Repeat 2 bars' }, { value: '', label: 'Repeat 4 bars' },
    { value: '', label: 'Segno' }, { value: '', label: 'Coda' }, { value: '', label: 'Fermata' },
    { value: '', label: 'Breath mark' }, { value: '', label: 'Caesura' },
  ];
  const KEYSIG_OPTIONS = [
    'Cb (7 flats)', 'Gb (6 flats)', 'Db (5 flats)', 'Ab (4 flats)', 'Eb (3 flats)', 'Bb (2 flats)', 'F (1 flat)', 'C (none)',
    'G (1 sharp)', 'D (2 sharps)', 'A (3 sharps)', 'E (4 sharps)', 'B (5 sharps)', 'F# (6 sharps)', 'C# (7 sharps)',
  ].map((label, i) => ({ value: i - 7, label }));
  // What one beat of the time signature is (the bottom number), in words.
  const TIMESIG_DENOMINATORS = [1, 2, 4, 8, 16];
  const TIMESIG_NOTE_NAMES = { 1: 'whole notes', 2: 'half notes', 4: 'quarter notes', 8: 'eighth notes', 16: '16th notes' };

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  const fmtNum = v => String(Math.round(v * 10) / 10);
  const resolveLimit = (v, el) => (typeof v === 'function' ? v(el) : v);
  function numField(label, key, extra) {
    return { kind: 'number', id: key, label, get: e => e[key], set: (e, v) => { e[key] = v; }, ...extra };
  }

  function geometrySection(el) {
    const lim = sizeLimits(el);
    const fields = [];
    const posRange = { min: -50, max: PAGE_W + 50 };
    if (el.type === 'arrow') {
      ['x1', 'y1', 'x2', 'y2'].forEach(k => fields.push(numField(k.toUpperCase(), k, posRange)));
    } else {
      fields.push(numField('X', 'x', posRange), numField('Y', 'y', { min: -50, max: PAGE_H + 50 }));
      if (lim.w) fields.push(numField('W', 'w', { min: e => sizeLimits(e).w[0], max: e => sizeLimits(e).w[1], set: (e, v) => applySize(e, v, null) }));
      if (lim.h) fields.push(numField('H', 'h', { min: e => sizeLimits(e).h[0], max: e => sizeLimits(e).h[1], set: (e, v) => applySize(e, null, v) }));
    }
    return { title: 'Position & size', fields };
  }
  function actionsSection() {
    return {
      title: 'Element',
      fields: [
        { kind: 'buttons', items: [
          { label: 'Duplicate', own: true, onClick: () => duplicateSelection() },
          { label: 'To front', onClick: e => reorderElement(e, true) },
          { label: 'To back', onClick: e => reorderElement(e, false) },
        ] },
        { kind: 'buttons', items: [
          { label: 'Center on page', onClick: e => alignToPage(e, 'center') },
          { label: 'Left margin', onClick: e => alignToPage(e, 'left') },
        ] },
        { kind: 'buttons', items: [
          { label: 'Delete', danger: true, own: true, onClick: e => removeElement(e.id) },
        ] },
      ],
    };
  }
  function textSchema(el) {
    return [
      { fields: [
        { kind: 'text', id: 'text', label: 'Text', wide: true, get: e => (e.type === 'chordText' ? displayChord(e.text || '') : e.text || ''), set: (e, v) => { e.text = e.type === 'chordText' ? storeChord(v) : v; } },
        numField('Size', 'fontSize', { stepper: true, integer: true, min: LIMITS.textFont[0], max: LIMITS.textFont[1] }),
        { kind: 'select', id: 'type', label: 'Type', options: TEXT_TYPE_OPTIONS, get: e => e.type, set: (e, v) => { e.type = v; }, structural: true },
      ] },
      geometrySection(el),
      actionsSection(),
    ];
  }
  // Time signature, fills and the floating-menu list: shared by the rhythm
  // bar and the note staff.
  function barSections(el) {
    const beat = barBeatUnits(el.denominator || 4);
    const denOptions = TIMESIG_DENOMINATORS.includes(el.denominator || 4)
      ? TIMESIG_DENOMINATORS : [...TIMESIG_DENOMINATORS, el.denominator].sort((a, b) => a - b);
    return [
      { title: 'Time signature', fields: [
        numField('Beats', 'numerator', { stepper: true, integer: true, min: 1, max: 32, get: e => e.numerator || 4, set: (e, v) => setBarTimeSig(e, v, e.denominator || 4), structural: true }),
        { kind: 'select', id: 'denominator', label: 'of', options: denOptions.map(d => ({ value: d, label: TIMESIG_NOTE_NAMES[d] || `1/${d} notes` })),
          get: e => e.denominator || 4, set: (e, v) => setBarTimeSig(e, e.numerator || 4, v), structural: true },
      ] },
      { title: 'Fill the bar with', fields: [
        { kind: 'buttons', items: [
          { label: 'Rests', onClick: e => fillCells(e, 0) },
          { label: 'Each beat', onClick: e => fillCells(e, beat) },
          ...(beat >= 4 ? [{ label: 'Half beats', onClick: e => fillCells(e, beat / 2) }] : []),
        ] },
      ] },
    ];
  }
  const EDIT_SCHEMAS = {
    title: textSchema,
    chordText: textSchema,
    text: textSchema,
    row: el => [
      { fields: [
        numField('Bars', 'barCount', { stepper: true, integer: true, min: 1, max: ROW_MAX_BARS, set: setRowBars, structural: true }),
        numField('Chords / bar (all)', 'chordsPerBar', { stepper: true, integer: true, min: 0, max: ROW_MAX_CHORDS, get: e => e.chordsPerBar || 0, set: setRowChordsPerBar, structural: true }),
        { kind: 'toggle', id: 'repeatStart', label: 'Repeat start', get: e => !!e.repeatStart, set: (e, v) => { e.repeatStart = v; } },
        { kind: 'toggle', id: 'repeatEnd', label: 'Repeat end', get: e => !!e.repeatEnd, set: (e, v) => { e.repeatEnd = v; } },
      ] },
      { title: 'Chords', fields: [{ kind: 'chordSlots' }] },
      geometrySection(el),
      { title: 'Layout', fields: [{ kind: 'buttons', items: [
        { label: 'Fit to page width', onClick: e => fitRowToPage(e) },
        ...(rowSlotCount(el) > 0 ? [{ label: 'Clear chords', onClick: e => { e.chords = Array(rowSlotCount(e)).fill(''); } }] : []),
      ] }] },
      actionsSection(),
    ],
    repeat: el => [
      { fields: [
        { kind: 'segmented', id: 'kind', label: 'Kind', options: [{ value: 'start', label: 'Start' }, { value: 'end', label: 'End' }],
          get: e => e.kind, set: (e, v) => { e.kind = v; } },
      ] },
      geometrySection(el),
      actionsSection(),
    ],
    volta: el => [
      { fields: [
        { kind: 'text', id: 'text', label: 'Text', wide: true, get: e => e.text || '', set: (e, v) => { e.text = v; } },
        { kind: 'buttons', items: ['1.', '2.', '3.', '1, 2.'].map(t => ({ label: t, onClick: e => { e.text = t; } })) },
        numField('Size', 'fontSize', { stepper: true, integer: true, min: LIMITS.volta.fontSize[0], max: LIMITS.volta.fontSize[1] }),
      ] },
      geometrySection(el),
      actionsSection(),
    ],
    glyph: el => [
      { fields: [
        { kind: 'select', id: 'code', label: 'Symbol',
          options: GLYPH_OPTIONS.some(o => o.value === el.code) ? GLYPH_OPTIONS : [...GLYPH_OPTIONS, { value: el.code, label: 'Custom' }],
          get: e => e.code, set: (e, v) => { e.code = v; } },
        numField('Size', 'fontSize', { stepper: true, integer: true, min: LIMITS.glyphFont[0], max: LIMITS.glyphFont[1] }),
      ] },
      geometrySection(el),
      actionsSection(),
    ],
    arrow: el => [
      { title: 'Curve', fields: [
        numField('Bow X', 'bowDx', { min: -300, max: 300, get: e => (e.bow ? e.bow.dx : 0), set: (e, v) => { e.bow = { dx: v, dy: e.bow ? e.bow.dy : 0 }; } }),
        numField('Bow Y', 'bowDy', { min: -300, max: 300, get: e => (e.bow ? e.bow.dy : 0), set: (e, v) => { e.bow = { dx: e.bow ? e.bow.dx : 0, dy: v }; } }),
        { kind: 'buttons', items: [
          { label: 'Straighten', onClick: e => { e.bow = { dx: 0, dy: 0 }; } },
          { label: 'Swap ends', onClick: e => { [e.x1, e.x2] = [e.x2, e.x1]; [e.y1, e.y2] = [e.y2, e.y1]; } },
        ] },
      ] },
      geometrySection(el),
      actionsSection(),
    ],
    rhythmbar: el => [
      ...barSections(el),
      { fields: [{ kind: 'noteMenu' }] },
      geometrySection(el),
      actionsSection(),
    ],
    notestaff: el => [
      { fields: [
        { kind: 'buttons', items: [{ label: 'Edit notes…', title: 'Open the staff editor (Enter, or click a note on the page)', own: true, onClick: e => openStaffEditor(e) }] },
      ] },
      { title: 'Bars', fields: [
        numField('Bars', 'bars', { stepper: true, integer: true, min: 1, max: STAFF_MAX_BARS, get: e => staffBarCount(e), set: setStaffBars, structural: true }),
      ] },
      ...barSections(el),
      { title: 'Clef & key', fields: [
        { kind: 'select', id: 'clef', label: 'Clef', options: [{ value: 'treble', label: 'Treble' }, { value: 'bass', label: 'Bass' }],
          get: e => e.clef || 'treble', set: (e, v) => { e.clef = v; } },
        { kind: 'select', id: 'keySignature', label: 'Key', options: KEYSIG_OPTIONS,
          // Reads and writes the key as it shows, so on a transposed sheet it
          // matches the signature on the page.
          get: e => displayedKeySignature(e), set: (e, v) => { e.keySignature = storedKeySignature(e, v); applySize(e, e.w, null); } },
      ] },
      { title: 'Transpose notes', fields: [{ kind: 'buttons', items: [
        { label: '− step', onClick: e => transposeStaff(e, -1) },
        { label: '+ step', onClick: e => transposeStaff(e, 1) },
        { label: '− octave', onClick: e => transposeStaff(e, -7) },
        { label: '+ octave', onClick: e => transposeStaff(e, 7) },
      ] }] },
      geometrySection(el),
      actionsSection(),
    ],
  };

  // Applies a field's new value to the element and refreshes everything that
  // shows it. `structural` fields (bar count, time signature, ...) change what
  // the box itself contains, so it is rebuilt.
  function applyField(el, spec, value) {
    spec.set(el, value);
    markDirty();
    renderSvg();
    if (spec.structural) renderEditBox();
  }

  function fieldNumber(el, f) {
    const wrap = mk('div', 'eb-field');
    wrap.appendChild(mk('span', 'eb-label', f.label));
    const input = mk('input');
    input.type = 'number';
    input.dataset.field = f.id;
    input.setAttribute('aria-label', f.label);
    const step = f.step || 1;
    input.step = f.integer ? step : 'any';
    const read = () => f.get(el);
    const commit = raw => {
      let v = parseFloat(raw);
      if (Number.isNaN(v)) { input.value = fmtNum(read()); return; }
      if (f.integer) v = Math.round(v);
      const lo = resolveLimit(f.min, el), hi = resolveLimit(f.max, el);
      if (lo != null) v = Math.max(lo, v);
      if (hi != null) v = Math.min(hi, v);
      if (v !== read()) applyField(el, f, v);
      input.value = fmtNum(read());
    };
    input.addEventListener('change', () => commit(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    if (f.stepper) {
      const box = mk('span', 'eb-stepper');
      const minus = mk('button', 'eb-btn eb-btn--step', '−');
      const plus = mk('button', 'eb-btn eb-btn--step', '+');
      minus.type = plus.type = 'button';
      minus.dataset.field = `${f.id}-minus`; // so focus survives a rebuild (see renderEditBox)
      plus.dataset.field = `${f.id}-plus`;
      minus.setAttribute('aria-label', `${f.label} minus`);
      plus.setAttribute('aria-label', `${f.label} plus`);
      minus.addEventListener('click', () => commit(read() - step));
      plus.addEventListener('click', () => commit(read() + step));
      box.append(minus, input, plus);
      wrap.appendChild(box);
    } else {
      wrap.appendChild(input);
    }
    const sync = () => { if (document.activeElement !== input) input.value = fmtNum(read()); };
    sync();
    editBoxSyncs.push(sync);
    return wrap;
  }

  function fieldText(el, f) {
    const wrap = mk('div', f.wide ? 'eb-field eb-field--wide' : 'eb-field');
    wrap.appendChild(mk('span', 'eb-label', f.label));
    const input = mk('input');
    input.type = 'text';
    input.dataset.field = f.id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', f.label);
    // Typed text lands on the page as it is typed.
    input.addEventListener('input', () => { f.set(el, input.value); markDirty(); renderSvg(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    const sync = () => { if (document.activeElement !== input) input.value = f.get(el); };
    sync();
    editBoxSyncs.push(sync);
    wrap.appendChild(input);
    return wrap;
  }

  function fieldToggle(el, f) {
    const wrap = mk('label', 'eb-field');
    const input = mk('input');
    input.type = 'checkbox';
    input.dataset.field = f.id;
    input.addEventListener('change', () => applyField(el, f, input.checked));
    wrap.append(input, mk('span', 'eb-label', f.label));
    const sync = () => { input.checked = !!f.get(el); };
    sync();
    editBoxSyncs.push(sync);
    return wrap;
  }

  function fieldSelect(el, f) {
    const wrap = mk('div', 'eb-field');
    wrap.appendChild(mk('span', 'eb-label', f.label));
    const select = mk('select');
    select.dataset.field = f.id;
    select.setAttribute('aria-label', f.label);
    f.options.forEach((o, i) => { const opt = mk('option', null, o.label); opt.value = String(i); select.appendChild(opt); });
    select.addEventListener('change', () => applyField(el, f, f.options[parseInt(select.value, 10)].value));
    const sync = () => { select.value = String(Math.max(0, f.options.findIndex(o => o.value === f.get(el)))); };
    sync();
    editBoxSyncs.push(sync);
    wrap.appendChild(select);
    return wrap;
  }

  function fieldSegmented(el, f) {
    const wrap = mk('div', 'eb-field');
    wrap.appendChild(mk('span', 'eb-label', f.label));
    const seg = mk('span', 'eb-seg');
    const btns = f.options.map(o => {
      const b = mk('button', 'eb-btn', o.label);
      b.type = 'button';
      b.addEventListener('click', () => applyField(el, f, o.value));
      seg.appendChild(b);
      return { b, o };
    });
    const sync = () => btns.forEach(({ b, o }) => b.classList.toggle('eb-btn--on', f.get(el) === o.value));
    sync();
    editBoxSyncs.push(sync);
    wrap.appendChild(seg);
    return wrap;
  }

  function fieldButtons(el, f) {
    const wrap = mk('div', 'eb-actions');
    f.items.forEach(item => {
      const b = mk('button', item.danger ? 'eb-btn eb-btn--danger' : 'eb-btn', item.label);
      b.type = 'button';
      if (item.title) b.title = item.title;
      b.addEventListener('click', () => {
        item.onClick(el);
        // `own` actions (duplicate, delete) render for themselves.
        if (!item.own) { markDirty(); renderSvg(); }
        if (item.rebuild) renderEditBox();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // One text box per chord slot, grouped by bar, in Tab order, with a - / + on
  // each bar's line to change how many boxes that bar has. A box gets the page
  // highlight while it has focus; Tab off the row's first/last box moves on to
  // the neighbouring row.
  function fieldChordSlots(el) {
    ensureChords(el);
    const counts = rowBarCounts(el);
    const total = rowSlotCount(el);
    const wrap = mk('div');
    const list = mk('div', 'eb-chords');
    let idx = 0;
    counts.forEach((n, bar) => {
      const line = mk('div', 'eb-chord-bar');
      line.appendChild(mk('span', 'eb-chord-bar-num', String(bar + 1)));
      const boxes = mk('div', 'eb-chord-boxes');
      for (let k = 0; k < n; k++) {
        const slotIdx = idx++;
        const input = mk('input');
        input.type = 'text';
        input.dataset.field = `slot-${slotIdx}`;
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', `Bar ${bar + 1}, chord ${k + 1}`);
        input.title = '- rest, r repeat bar, Am- tie to the next chord';
        input.addEventListener('focus', () => { if (activeSlot !== slotIdx) { activeSlot = slotIdx; renderSvg(); } });
        input.addEventListener('blur', () => {
          if (editBoxBuilding) return; // the box is being rebuilt around it
          if (activeSlot === slotIdx) { activeSlot = null; renderSvg(); }
        });
        input.addEventListener('input', () => { ensureChords(el); el.chords[slotIdx] = storeChord(input.value); markDirty(); renderSvg(); });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); return; }
          // Cmd/Ctrl + / -: one more / fewer box in this bar (same as its - / +).
          if ((e.metaKey || e.ctrlKey) && !e.altKey && /^[-+=_]$/.test(e.key)) {
            e.preventDefault(); // not the browser's zoom
            const next = clamp(n + (e.key === '-' || e.key === '_' ? -1 : 1), 0, ROW_MAX_CHORDS);
            if (next === n) return;
            setRowBarChords(el, bar, next);
            markDirty(); renderEditBox();
            // renderEditBox keeps the cursor in this box; if it was the one removed, go to the bar's last.
            const at = slotIdx - k + Math.min(k, next - 1);
            if (next > 0 && k >= next) focusEditField(`slot-${at}`);
            activeSlot = next > 0 ? at : null;
            renderSvg();
            return;
          }
          if (e.key !== 'Tab') return;
          const dir = e.shiftKey ? -1 : 1;
          if ((dir < 0 && slotIdx === 0) || (dir > 0 && slotIdx === total - 1)) {
            const next = nextChordSlot(el, slotIdx, dir);
            if (next) { e.preventDefault(); focusSlot(next.rowId, next.idx); }
          }
        });
        const sync = () => { if (document.activeElement !== input) input.value = displayChord(el.chords[slotIdx] || ''); };
        sync();
        editBoxSyncs.push(sync);
        boxes.appendChild(input);
      }
      line.appendChild(boxes);
      const step = mk('span', 'eb-bar-step');
      [['\u2212', -1, 'minus', 'fewer'], ['+', 1, 'plus', 'more']].forEach(([label, d, name, word]) => {
        const b = mk('button', 'eb-btn eb-btn--step', label);
        b.type = 'button';
        b.dataset.field = `bar-${bar}-${name}`; // so focus survives the rebuild
        b.tabIndex = -1; // Tab runs box to box; these are for the mouse
        b.setAttribute('aria-label', `Bar ${bar + 1}: ${word} chords`);
        b.disabled = d < 0 ? n <= 0 : n >= ROW_MAX_CHORDS;
        b.addEventListener('click', () => {
          setRowBarChords(el, bar, n + d);
          markDirty(); renderSvg(); renderEditBox();
        });
        step.appendChild(b);
      });
      line.appendChild(step);
      list.appendChild(line);
    });
    wrap.appendChild(list);
    wrap.appendChild(mk('p', 'eb-hint', 'The - / + on each line changes that bar only; "Chords / bar (all)" above sets every bar. Type - for a rest as long as the box, r for a repeat-bar sign. Tab moves to the next box; Cmd/Ctrl + or - adds or removes a box in the bar you are typing in.'));
    return wrap;
  }

  // The list of items the floating note menu shows (see NOTE_MENU_ITEMS).
  function fieldNoteMenu() {
    const det = mk('details', 'eb-details');
    det.open = noteMenuSectionOpen;
    det.addEventListener('toggle', () => { noteMenuSectionOpen = det.open; });
    det.appendChild(mk('summary', null, 'Floating note menu'));
    det.appendChild(mk('p', 'eb-hint', `Choose what the menu offers when you click a note. Applies to all rhythm bars.`));
    NOTE_MENU_GROUPS.forEach(group => {
      const items = NOTE_MENU_ITEMS.filter(i => i.group === group.id);
      const box = mk('div', 'eb-check-group');
      box.appendChild(mk('div', 'eb-check-group-title', group.label));
      const list = mk('div', 'eb-check-list');
      items.forEach(item => {
        const label = mk('label');
        const cb = mk('input');
        cb.type = 'checkbox';
        cb.checked = isMenuItemOn(item.id);
        cb.addEventListener('change', () => { noteMenuPrefs[item.id] = cb.checked; saveNoteMenuPrefs(); });
        label.append(cb, mk('span', null, item.label));
        list.appendChild(label);
      });
      box.appendChild(list);
      det.appendChild(box);
    });
    const actions = mk('div', 'eb-actions');
    const all = mk('button', 'eb-btn', 'Show all');
    const reset = mk('button', 'eb-btn', 'Reset');
    all.type = reset.type = 'button';
    all.addEventListener('click', () => { NOTE_MENU_ITEMS.forEach(i => { noteMenuPrefs[i.id] = true; }); saveNoteMenuPrefs(); renderEditBox(); });
    reset.addEventListener('click', () => { noteMenuPrefs = {}; saveNoteMenuPrefs(); renderEditBox(); });
    actions.append(all, reset);
    det.appendChild(actions);
    return det;
  }

  const FIELD_BUILDERS = {
    number: fieldNumber, text: fieldText, toggle: fieldToggle, select: fieldSelect, segmented: fieldSegmented,
    buttons: fieldButtons, chordSlots: fieldChordSlots, noteMenu: fieldNoteMenu,
  };
  // Full-width fields; the rest (numbers, selects, toggles) flow side by side.
  const BLOCK_KINDS = new Set(['buttons', 'chordSlots', 'noteMenu']);

  function buildSection(el, sec) {
    const box = mk('div', 'eb-section');
    if (sec.title) box.appendChild(mk('div', 'eb-section-title', sec.title));
    let row = null;
    sec.fields.forEach(f => {
      const node = FIELD_BUILDERS[f.kind](el, f);
      if (BLOCK_KINDS.has(f.kind) || f.wide) {
        row = null;
        box.appendChild(node.classList.contains('eb-field') ? wrapRow(node) : node);
      } else {
        if (!row) { row = mk('div', 'eb-row'); box.appendChild(row); }
        row.appendChild(node);
      }
    });
    return box;
  }
  function wrapRow(node) {
    const row = mk('div', 'eb-row');
    row.appendChild(node);
    return row;
  }

  function buildEmptyPanel() {
    editBox.appendChild(mk('div', 'eb-head')).appendChild(mk('span', 'eb-head-title', 'Edit'));
    const empty = mk('div', 'eb-empty');
    empty.appendChild(mk('p', null, 'Click an element on the page to edit it here.'));
    const tips = mk('ul');
    ['Drag an element to move it, or its corner handle to resize it.',
      'Drag a box around several elements to select them, or Shift-click to add one.',
      'Cmd/Ctrl+D copies the selection, Delete removes it, arrow keys nudge it.'].forEach(t => tips.appendChild(mk('li', null, t)));
    empty.appendChild(tips);
    editBox.appendChild(empty);
  }

  function buildMultiPanel(els) {
    const head = mk('div', 'eb-head');
    head.appendChild(mk('span', 'eb-head-title', `${els.length} elements selected`));
    editBox.appendChild(head);
    const sec = (title, items) => {
      const s = mk('div', 'eb-section');
      s.appendChild(mk('div', 'eb-section-title', title));
      const row = mk('div', 'eb-actions');
      items.forEach(([label, fn, danger]) => {
        const b = mk('button', danger ? 'eb-btn eb-btn--danger' : 'eb-btn', label);
        b.type = 'button';
        b.addEventListener('click', fn);
        row.appendChild(b);
      });
      s.appendChild(row);
      editBox.appendChild(s);
    };
    const changed = fn => () => { fn(); markDirty(); renderSvg(); };
    sec('Align', [
      ['Left', changed(() => alignSelection('left'))], ['Center', changed(() => alignSelection('center'))], ['Right', changed(() => alignSelection('right'))],
      ['Top', changed(() => alignSelection('top'))], ['Middle', changed(() => alignSelection('middle'))], ['Bottom', changed(() => alignSelection('bottom'))],
    ]);
    if (els.length >= 3) {
      sec('Distribute', [
        ['Horizontally', changed(() => distributeSelection('h'))], ['Vertically', changed(() => distributeSelection('v'))],
      ]);
    }
    sec('Selection', [
      ['Duplicate', () => duplicateSelection()],
      ['Delete', () => removeSelection(), true],
    ]);
  }

  function selectionSig() {
    return model.elements.filter(el => selectedIds.has(el.id)).map(el => el.id).join(',');
  }

  // Rebuilds the box for the current selection, keeping the cursor in the same
  // field if one had it (a structural change rebuilds under the user's hands).
  function renderEditBox() {
    const active = document.activeElement;
    const keep = active && editBox.contains(active) && active.dataset && active.dataset.field
      ? { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd } : null;
    editBoxBuilding = true;
    editBoxSyncs = [];
    editBox.textContent = '';
    editBoxSig = selectionSig();
    const els = model.elements.filter(el => selectedIds.has(el.id));
    if (!els.length) {
      buildEmptyPanel();
    } else if (els.length > 1) {
      buildMultiPanel(els);
    } else {
      const el = els[0];
      const head = mk('div', 'eb-head');
      head.appendChild(mk('span', 'eb-head-title', ELEMENT_NAMES[el.type] || el.type));
      editBox.appendChild(head);
      (EDIT_SCHEMAS[el.type] ? EDIT_SCHEMAS[el.type](el) : []).filter(Boolean)
        .forEach(sec => editBox.appendChild(buildSection(el, sec)));
    }
    editBoxBuilding = false;
    if (keep) {
      const input = editBox.querySelector(`[data-field="${keep.field}"]`);
      if (input) {
        input.focus();
        try { if (keep.start != null) input.setSelectionRange(keep.start, keep.end); } catch (err) { /* number inputs have no selection range */ }
      }
    }
  }

  // Called after every render: rebuilds if the selection changed, otherwise
  // just refreshes the numbers and text the page may have moved under it.
  function syncEditBox() {
    if (editBoxBuilding) return;
    if (selectionSig() !== editBoxSig) renderEditBox();
    else editBoxSyncs.forEach(fn => fn());
  }
  function focusEditField(name) {
    syncEditBox();
    const input = editBox.querySelector(`[data-field="${name}"]`);
    if (!input) return;
    input.focus();
    if (input.select) input.select();
  }
  // Selects `rowId` and puts the cursor in its chord slot `idx`.
  function focusSlot(rowId, idx) {
    selectOnly(rowId);
    activeSlot = idx;
    syncEditBox();
    focusEditField(`slot-${idx}`);
    renderSvg();
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
    if (staffEditor.el) return; // it takes the keys while it's open
    const t = e.target;
    const typing = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'));
    // Escape leaves a field first; pressed on the page it drops the selection.
    if (e.key === 'Escape') {
      if (typing) t.blur();
      else if (selectedIds.size) { clearSelection(); renderSvg(); }
      return;
    }
    // The rest are left alone while typing in any field.
    if (typing || !selectedIds.size) return;
    // Enter or N on a single selected note staff opens it in the staff editor.
    const only = selectedIds.size === 1 ? model.elements.find(el => selectedIds.has(el.id)) : null;
    if (only && only.type === 'notestaff' && plain(e) && (e.key === 'Enter' || keyIs(e, 'n')) && t.tagName !== 'BUTTON') {
      e.preventDefault();
      openStaffEditor(only);
      return;
    }
    // Cmd/Ctrl+D duplicates the selection (and keeps the browser from
    // bookmarking the page).
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelection();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && t.tagName !== 'BUTTON') { // not while a button has focus: a stray key shouldn't delete
      e.preventDefault();
      removeSelection();
    } else if (e.key.startsWith('Arrow') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Nudge the selection: 1px, or 10px with Shift.
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      nudgeSelection(dx, dy);
    }
  });

  const pageWrap = document.getElementById('page-wrap');
  pageWrap.addEventListener('dragover', e => { e.preventDefault(); pageWrap.classList.add('drag-over'); });
  pageWrap.addEventListener('dragleave', () => pageWrap.classList.remove('drag-over'));
  pageWrap.addEventListener('drop', e => {
    e.preventDefault();
    pageWrap.classList.remove('drag-over');
    if (isViewer()) return;
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
  const barsChordsInput = document.getElementById('bars-chords');
  const BARS_PREVIEW_W = 240, BARS_PREVIEW_H = 44;
  function barsBuilderCount() {
    return clamp(parseInt(barsCountInput.value, 10) || 4, 1, ROW_MAX_BARS);
  }
  function barsBuilderChords() {
    const v = parseInt(barsChordsInput.value, 10);
    return clamp(Number.isNaN(v) ? 1 : v, 0, ROW_MAX_CHORDS);
  }
  function renderBarsBuilderSvg() {
    const svg = document.getElementById('bars-builder-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const n = barsBuilderCount();
    const padX = 8, top = 8, h = BARS_PREVIEW_H - 16;
    const barW = (BARS_PREVIEW_W - 2 * padX) / n;
    chordSlotRects(padX, top, BARS_PREVIEW_W - 2 * padX, h, Array(n).fill(barsBuilderChords()), barsRepeatStart.checked, barsRepeatEnd.checked)
      .forEach(s => svg.appendChild(svgRect(s.x + 1, s.y + 1.5, Math.max(s.w - 2, 1), h - 3, { cls: 'el-chord-slot empty' })));
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
  barsChordsInput.addEventListener('input', renderBarsBuilderSvg);
  barsChordsInput.addEventListener('change', () => {
    barsChordsInput.value = barsBuilderChords();
    renderBarsBuilderSvg();
  });
  barsRepeatStart.addEventListener('change', renderBarsBuilderSvg);
  barsRepeatEnd.addEventListener('change', renderBarsBuilderSvg);
  document.getElementById('bars-builder-drag').addEventListener('dragstart', e => {
    startPlacementDrag(e, {
      type: 'row', barCount: barsBuilderCount(), chordsPerBar: barsBuilderChords(),
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
  let builderCells = defaultBeatCells(builderNumerator, builderDenominator, 1);
  const BUILDER_H = 20;
  const BUILDER_UNIT_PX = 7.5; // matches the old fixed 16-slot/240px builder width at 4/4

  function renderBuilderSvg() {
    const svg = document.getElementById('rhythm-builder-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const builderW = barTotalUnits(builderNumerator, builderDenominator) * BUILDER_UNIT_PX;
    renderRhythmCells(svg, builderCells, 6, 40, builderW, BUILDER_H,
      (idx, clientX, clientY, subIdx) => {
        if (subIdx != null) {
          openTupletSlotMenu(clientX, clientY, builderCells[idx], subIdx, renderBuilderSvg,
            () => { builderCells = rebuildRhythmCells(builderCells, idx, { type: 'rest', duration: builderCells[idx].duration }); renderBuilderSvg(); });
          return;
        }
        openRhythmMenu(clientX, clientY, builderCells, idx, newCells => {
          builderCells = newCells; renderBuilderSvg();
        }, { onChange: renderBuilderSvg });
      },
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
    builderCells = defaultBeatCells(builderNumerator, builderDenominator, 1);
    renderBuilderSvg();
  });
  function wireTimeSigInput(id, apply) {
    document.getElementById(id).addEventListener('change', e => {
      const v = clamp(parseInt(e.target.value, 10) || 4, 1, 32);
      e.target.value = v;
      apply(v);
      builderCells = defaultBeatCells(builderNumerator, builderDenominator, 1);
      renderBuilderSvg();
    });
  }
  wireTimeSigInput('rhythm-time-num', v => { builderNumerator = v; });
  wireTimeSigInput('rhythm-time-den', v => { builderDenominator = v; });

  /* ---------- note staff builder ---------- */
  // Sets up an empty staff (time, clef, bars) to drag onto the page; the
  // preview only shows it. The notes are written in the staff editor, which
  // opens as soon as the staff is dropped (see addElement).
  let staffBuilderNumerator = 4, staffBuilderDenominator = 4;
  let staffBuilderClef = 'treble';
  let staffBuilderBars = 1;
  // The key isn't set here: a new staff starts on the sheet's key (see
  // keySignatureForKey) and is changed afterwards in its edit box.
  const STAFF_BUILDER_H = 24;
  const STAFF_BUILDER_VIEW_W = 300; // the whole drawing is this wide, whatever the bars or time signature
  const STAFF_BUILDER_VIEW_H = 68; // as tall as the rhythm builder's preview
  function staffBuilderCells() {
    return defaultBeatCells(staffBuilderNumerator, staffBuilderDenominator, staffBuilderBars);
  }

  function renderStaffBuilderSvg() {
    const svg = document.getElementById('notestaff-builder-svg');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const builderEl = {
      x: 10, y: (STAFF_BUILDER_VIEW_H - STAFF_BUILDER_H) / 2, h: STAFF_BUILDER_H, w: 0, staged: true,
      clef: staffBuilderClef, keySignature: keySignatureForKey(model.key),
      numerator: staffBuilderNumerator, denominator: staffBuilderDenominator, bars: staffBuilderBars,
    };
    const leadW = notestaffLeadWidth(builderEl);
    const builderW = STAFF_BUILDER_VIEW_W - builderEl.x - leadW - 10;
    builderEl.w = builderW;
    document.getElementById('staff-key-label').textContent = `Key: ${keySignatureLabel(builderEl.keySignature)}${model.key ? '' : ' (no song key)'}`;

    drawStaffLines(svg, builderEl);
    drawClef(svg, builderEl);
    drawKeySignature(svg, builderEl);
    const cells = staffBuilderCells();
    drawStaffBarlines(svg, builderEl, builderEl.x + leadW, builderW, cells);
    renderStaffCells(svg, cells, builderEl.x + leadW, builderEl.y, builderW, builderEl);

    svg.setAttribute('viewBox', `0 0 ${STAFF_BUILDER_VIEW_W} ${STAFF_BUILDER_VIEW_H}`);
    svg.setAttribute('width', STAFF_BUILDER_VIEW_W);
    svg.setAttribute('height', STAFF_BUILDER_VIEW_H);
    svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  }
  renderStaffBuilderSvg();

  document.getElementById('staff-builder-drag').addEventListener('dragstart', e => {
    startPlacementDrag(e, {
      type: 'notestaff', cells: staffBuilderCells(), numerator: staffBuilderNumerator, denominator: staffBuilderDenominator,
      bars: staffBuilderBars, clef: staffBuilderClef, keySignature: keySignatureForKey(model.key),
    });
  });
  function wireStaffTimeSigInput(id, apply) {
    document.getElementById(id).addEventListener('change', e => {
      const v = clamp(parseInt(e.target.value, 10) || 4, 1, 32);
      e.target.value = v;
      apply(v);
      renderStaffBuilderSvg();
    });
  }
  wireStaffTimeSigInput('staff-time-num', v => { staffBuilderNumerator = v; });
  wireStaffTimeSigInput('staff-time-den', v => { staffBuilderDenominator = v; });
  document.getElementById('staff-bars').addEventListener('change', e => {
    staffBuilderBars = clamp(parseInt(e.target.value, 10) || 1, 1, STAFF_MAX_BARS);
    e.target.value = staffBuilderBars;
    renderStaffBuilderSvg();
  });
  document.getElementById('staff-clef').addEventListener('change', e => {
    staffBuilderClef = e.target.value;
    renderStaffBuilderSvg();
  });

  /* ---------- note staff editor (modal) ---------- */
  // Where a staff's notes are written, MuseScore style (the keys are in
  // STAFF_EDITOR_BINDINGS). Edits land on the staff straight away, so the page
  // behind shows them; Done keeps them, Cancel puts the staff back as it was
  // when the editor opened, and undo/redo step through snapshots in between.
  // Two modes, as in MuseScore: normal mode works on the selected note or
  // rest; in note-input mode (N) there's a cursor, and a letter writes a note
  // of the current duration there and moves on. In both, `sel` is the cell
  // shown selected, which the pitch/accidental/articulation keys act on (in
  // note input, the note just written or the one under the cursor).
  const staffEditorEl = document.getElementById('staff-editor');
  const staffEditorSvg = document.getElementById('staff-editor-svg');
  const staffEditorHelp = document.getElementById('staff-editor-help');
  const staffEditor = {
    el: null, mode: 'normal', sel: null, cursor: null,
    duration: 8, // note input's current duration; kept from one opening to the next
    undo: [], redo: [], opening: null, message: '',
  };
  const STAFF_EDITOR_H = 56; // the staff's height in the editor (a placed one is about 30)
  const STAFF_EDITOR_VIEW_W = 1000;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';

  function staffSnapshot(el) { return JSON.stringify({ cells: el.cells, bars: el.bars, w: el.w }); }
  function restoreStaff(el, snap) {
    const s = JSON.parse(snap);
    el.cells = s.cells; el.bars = s.bars; el.w = s.w;
  }
  // The nearest real place to `a` after the cells changed under it; with
  // `allowEnd` (the input cursor) also the place after the last cell.
  function clampAddr(el, a, allowEnd) {
    if (allowEnd && a.idx >= el.cells.length) return { idx: el.cells.length, subIdx: null };
    const idx = clamp(a.idx, 0, el.cells.length - 1);
    const c = el.cells[idx];
    if (c.type !== 'tuplet') return { idx, subIdx: null };
    return { idx, subIdx: clamp(a.subIdx != null ? a.subIdx : 0, 0, c.cells.length - 1) };
  }

  function openStaffEditor(el, at = {}, opts = {}) {
    if (staffEditor.el) return;
    closeRhythmMenu();
    selectOnly(el.id);
    Object.assign(staffEditor, { el, mode: opts.input ? 'input' : 'normal', undo: [], redo: [], opening: staffSnapshot(el), message: '' });
    staffEditor.sel = clampAddr(el, { idx: at.idx || 0, subIdx: at.subIdx != null ? at.subIdx : null });
    staffEditor.cursor = staffEditor.sel;
    staffEditorEl.hidden = false;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // keys go to the editor, not a field behind it
    renderSvg();
    renderStaffEditor();
  }
  // `keep` false (Cancel) puts the staff back as it was when the editor opened.
  function closeStaffEditor(keep) {
    const { el, opening } = staffEditor;
    if (!el) return;
    if (!keep && staffSnapshot(el) !== opening) { restoreStaff(el, opening); markDirty(); }
    staffEditor.el = null;
    staffEditorEl.hidden = true;
    renderSvg();
  }

  // Runs one edit as an undo step. `fn(el)` may return a message to show
  // (why nothing happened); an edit that changes nothing isn't recorded.
  function editStaff(fn) {
    const { el } = staffEditor;
    const before = staffSnapshot(el);
    const msg = fn(el);
    staffEditor.message = typeof msg === 'string' ? msg : '';
    if (staffSnapshot(el) !== before) {
      staffEditor.undo.push(before);
      staffEditor.redo = [];
      applySize(el, el.w, null); // more or shorter notes change how narrow the staff can be
      markDirty();
      renderSvg();
    }
    staffEditor.sel = clampAddr(el, staffEditor.sel);
    staffEditor.cursor = clampAddr(el, staffEditor.cursor, true);
    renderStaffEditor();
  }
  function undoStaffEdit(dir) {
    const { el } = staffEditor;
    const from = dir < 0 ? staffEditor.undo : staffEditor.redo;
    const to = dir < 0 ? staffEditor.redo : staffEditor.undo;
    if (!from.length) return;
    to.push(staffSnapshot(el));
    restoreStaff(el, from.pop());
    staffEditor.sel = clampAddr(el, staffEditor.sel);
    staffEditor.cursor = clampAddr(el, staffEditor.cursor, true);
    staffEditor.message = '';
    markDirty();
    renderSvg();
    renderStaffEditor();
  }

  /* what the keys and toolbar buttons do */
  const isInput = () => staffEditor.mode === 'input';
  // An edit of the selected cell: `fn(el, sel)` returns false when it can't
  // apply, and `why` is shown then.
  function editSelected(fn, why) {
    editStaff(el => (fn(el, staffEditor.sel) === false ? why : undefined));
  }
  // The duration the toolbar shows as current: note input's, else the selection's.
  function shownDuration() {
    if (isInput()) return staffEditor.duration;
    const c = cellAt(staffEditor.el, staffEditor.sel);
    return c && staffEditor.sel.subIdx == null ? c.duration : null;
  }
  function selectedNote() {
    const c = staffEditor.el && cellAt(staffEditor.el, staffEditor.sel);
    return c && c.type === 'note' ? c : null;
  }
  function toggleInputMode() {
    staffEditor.mode = isInput() ? 'normal' : 'input';
    if (isInput()) staffEditor.cursor = staffEditor.sel;
    staffEditor.message = '';
    renderStaffEditor();
  }
  // Note input: sets the duration for what's typed next. Normal mode: the
  // selected cell gets it.
  function changeDuration(next, why) {
    if (isInput()) {
      if (next) staffEditor.duration = next;
      staffEditor.message = next ? '' : why;
      renderStaffEditor();
      return;
    }
    editSelected((el, sel) => !!next && setCellDuration(el, sel, next), why);
  }
  const NO_ROOM = "That length doesn't fit before the barline (a triplet's notes can't change length)";
  function pickDuration(d) { changeDuration(d, NO_ROOM); }
  function durationStep(fn, why) { const d = shownDuration(); changeDuration(d ? fn(d) : null, why); }

  // Note input: writes a note (at `shownPitch`, as drawn) or a rest at the cursor.
  function writeAt(type, pitchFor) {
    editStaff(el => {
      const cursor = staffEditor.cursor;
      const spec = { type, duration: staffEditor.duration };
      if (type === 'note') Object.assign(spec, storedStaffNote(el, pitchFor(el, cursor), null));
      const res = writeAtCursor(el, cursor, spec);
      if (!res) return `The staff is full (${STAFF_MAX_BARS} bars)`;
      staffEditor.sel = res.written;
      staffEditor.cursor = res.next;
      return undefined;
    });
  }
  function typeLetter(letter) {
    if (isInput()) writeAt('note', (el, cursor) => pitchForLetter(letter, el.clef || 'treble', pitchBefore(el, cursor)));
    else editSelected((el, sel) => setNoteLetter(el, sel, letter), "A triplet's slots are picked one at a time");
  }
  function restAction() {
    if (isInput()) writeAt('rest');
    else editSelected(toRest, 'That is a rest already');
  }
  function deleteAction() {
    if (!isInput()) { editSelected(toRest, 'That is a rest already'); return; }
    // Note input: steps back over the last cell and makes it a rest.
    const list = staffAddresses(staffEditor.el);
    const at = list.findIndex(a => sameAddr(a, staffEditor.cursor));
    const prev = list[(at < 0 ? list.length : at) - 1];
    if (!prev) return;
    staffEditor.cursor = prev;
    staffEditor.sel = prev;
    editSelected(toRest);
  }
  function tripletAction() {
    const why = 'A triplet is made from a quarter (eighth-note triplet) or a half (quarter-note triplet) that fits in the bar';
    if (isInput()) {
      editStaff(el => {
        const idx = staffEditor.cursor.idx;
        if (staffEditor.cursor.subIdx != null || !makeTriplet(el, idx, staffEditor.duration)) return why;
        staffEditor.cursor = staffEditor.sel = { idx, subIdx: 0 };
        return undefined;
      });
      return;
    }
    editStaff(el => {
      const { idx, subIdx } = staffEditor.sel;
      if (subIdx != null || !makeTriplet(el, idx, el.cells[idx].duration)) return why;
      staffEditor.sel = { idx, subIdx: 0 };
      return undefined;
    });
  }
  function addBarAction() {
    editStaff(el => {
      if (staffBarCount(el) >= STAFF_MAX_BARS) return `A staff has at most ${STAFF_MAX_BARS} bars`;
      setStaffBars(el, staffBarCount(el) + 1);
      return undefined;
    });
  }
  // ← / → (by cell, or with `byBar` to the first cell of the previous/next
  // bar): moves the selection, or in note input the cursor, which can also
  // sit after the last cell.
  function moveSelection(dir, byBar) {
    const el = staffEditor.el;
    const list = staffAddresses(el);
    if (isInput()) list.push({ idx: el.cells.length, subIdx: null });
    const from = isInput() ? staffEditor.cursor : staffEditor.sel;
    let i = Math.max(0, list.findIndex(a => sameAddr(a, from)));
    if (byBar) {
      const barUnits = staffBarUnits(el);
      const barOf = a => Math.floor(cellStart(el.cells, a.idx) / barUnits);
      const want = barOf(from) + dir;
      const hit = list.findIndex(a => (dir > 0 ? barOf(a) >= want : barOf(a) === want));
      i = hit >= 0 ? hit : (dir > 0 ? list.length - 1 : 0);
    } else {
      i = clamp(i + dir, 0, list.length - 1);
    }
    const to = list[i];
    if (isInput()) {
      staffEditor.cursor = to;
      if (to.idx < el.cells.length) staffEditor.sel = to;
    } else {
      staffEditor.sel = to;
    }
    staffEditor.message = '';
    renderStaffEditor();
  }
  function pitchAction(fn) { editSelected(fn, 'Select a note first (it stays within the staff)'); }

  // Every key and toolbar button, in one list, so the shortcut sheet can't
  // drift from what the keys do. The first binding whose `match` fits a
  // keydown runs; one with a `glyph` is also a toolbar button (`group` sets
  // where the separators go). Keys are matched on `e.key`, so the symbol
  // keys work on any keyboard layout.
  const isMod = e => (IS_MAC ? e.metaKey : e.ctrlKey);
  const plain = e => !e.metaKey && !e.ctrlKey && !e.altKey;
  const keyIs = (e, k) => e.key.toLowerCase() === k;
  const arrowDir = (e, a, b) => (e.key === a ? -1 : e.key === b ? 1 : 0);
  const STAFF_EDITOR_BINDINGS = [
    { keys: 'N', label: 'Note input on/off', group: 'mode', glyph: 'N',
      match: e => plain(e) && !e.shiftKey && keyIs(e, 'n'), run: toggleInputMode, isOn: isInput },
    ...[[2, '3', '16th', '16th'], [4, '4', '8th', '8th'], [8, '5', 'Quarter', 'quarter'], [16, '6', 'Half', 'half'], [32, '7', 'Whole', 'whole']]
      .map(([d, key, label, code]) => ({
        keys: key, label, group: 'duration', glyph: NOTE_CODES[code], musical: true,
        match: e => plain(e) && e.key === key, run: () => pickDuration(d),
        isOn: () => { const cur = shownDuration(); return cur === d || UNDOTTED[cur] === d; },
      })),
    { keys: '.', label: 'Dot', group: 'duration', glyph: AUG_DOT, musical: true,
      match: e => plain(e) && e.key === '.', run: () => durationStep(dotToggled, "That can't be dotted here"),
      isOn: () => !!UNDOTTED[shownDuration()] },
    { keys: '0', label: 'Rest', group: 'duration', glyph: REST_CODES.quarter, musical: true,
      match: e => plain(e) && e.key === '0', run: restAction },
    ...[['+', 'Sharp', 'sharp'], ['-', 'Flat', 'flat'], ['=', 'Natural', 'natural']].map(([key, label, acc]) => ({
      keys: key, label, group: 'accidental', glyph: ACCIDENTAL_CODES[acc], musical: true,
      match: e => plain(e) && e.key === key,
      run: () => pitchAction((el, sel) => toggleAccidental(el, sel, acc)),
      isOn: () => { const n = selectedNote(); return !!n && displayedStaffNote(staffEditor.el, n).accidental === acc; },
    })),
    { keys: 'T', label: 'Tie to next note', group: 'mark', glyph: tieIcon,
      match: e => plain(e) && !e.shiftKey && keyIs(e, 't'),
      run: () => editSelected(toggleTie, 'A tie joins a note to the note right after it'),
      isOn: () => !!staffEditor.el && staffEditor.sel.subIdx == null && isTiedToNext(staffEditor.el.cells, staffEditor.sel.idx) },
    { keys: `${MOD_LABEL}3`, label: 'Triplet', group: 'mark', glyph: '3',
      match: e => isMod(e) && !e.altKey && e.key === '3', run: tripletAction },
    ...[['S', 'staccato', 'Staccato'], ['V', 'accent', 'Accent'], ['F', 'fermata', 'Fermata']].map(([key, kind, label]) => ({
      keys: `Shift+${key}`, label, group: 'articulation', glyph: () => articulationIcon(kind),
      match: e => plain(e) && e.shiftKey && keyIs(e, key.toLowerCase()),
      run: () => editSelected((el, sel) => toggleArticulation(el, sel, kind), 'Select a note first'),
      isOn: () => { const n = selectedNote(); return !!n && cellHasArticulation(n, kind); },
    })),
    { keys: `${MOD_LABEL}Z`, label: 'Undo', group: 'history', glyph: '↶',
      match: e => isMod(e) && !e.shiftKey && keyIs(e, 'z'), run: () => undoStaffEdit(-1) },
    { keys: `Shift+${MOD_LABEL}Z`, label: 'Redo', group: 'history', glyph: '↷',
      match: e => isMod(e) && e.shiftKey && keyIs(e, 'z'), run: () => undoStaffEdit(1) },
    { keys: '?', label: 'Show/hide the shortcuts', group: 'help', glyph: '?',
      match: e => !e.metaKey && !e.ctrlKey && e.key === '?', run: () => { staffEditorHelp.hidden = !staffEditorHelp.hidden; } },
    // Keys only.
    { keys: 'A–G', label: 'Note input: write that note (nearest the one before). Else: change the selected note to it',
      match: e => plain(e) && !e.shiftKey && /^[a-g]$/i.test(e.key), run: e => typeLetter(e.key.toUpperCase()) },
    { keys: '↑ ↓', label: 'Up/down a semitone',
      match: e => plain(e) && !e.shiftKey && arrowDir(e, 'ArrowDown', 'ArrowUp'),
      run: e => pitchAction((el, sel) => stepSemitone(el, sel, arrowDir(e, 'ArrowDown', 'ArrowUp'))) },
    { keys: 'Alt+Shift+↑ ↓', label: 'Up/down one staff step (in the key)',
      match: e => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && arrowDir(e, 'ArrowDown', 'ArrowUp'),
      run: e => pitchAction((el, sel) => stepStaff(el, sel, arrowDir(e, 'ArrowDown', 'ArrowUp'))) },
    { keys: `${MOD_LABEL}↑ ↓`, label: 'Up/down an octave',
      match: e => isMod(e) && arrowDir(e, 'ArrowDown', 'ArrowUp'),
      run: e => pitchAction((el, sel) => stepStaff(el, sel, 7 * arrowDir(e, 'ArrowDown', 'ArrowUp'))) },
    { keys: '← →', label: 'Previous/next note (in note input: move the cursor)',
      match: e => plain(e) && !e.shiftKey && arrowDir(e, 'ArrowLeft', 'ArrowRight'),
      run: e => moveSelection(arrowDir(e, 'ArrowLeft', 'ArrowRight'), false) },
    { keys: `${MOD_LABEL}← →`, label: 'Previous/next bar',
      match: e => isMod(e) && arrowDir(e, 'ArrowLeft', 'ArrowRight'),
      run: e => moveSelection(arrowDir(e, 'ArrowLeft', 'ArrowRight'), true) },
    { keys: 'Q W', label: 'Halve/double the length',
      match: e => plain(e) && !e.shiftKey && (keyIs(e, 'q') || keyIs(e, 'w')),
      run: e => (keyIs(e, 'q') ? durationStep(halved, "That can't be halved") : durationStep(doubled, NO_ROOM)) },
    { keys: 'Delete', label: 'Make it a rest (on a triplet rest: remove the triplet). In note input: the one before the cursor',
      match: e => !e.metaKey && !e.ctrlKey && (e.key === 'Delete' || e.key === 'Backspace'), run: deleteAction },
    { keys: `${MOD_LABEL}B`, label: 'Add a bar', match: e => isMod(e) && keyIs(e, 'b'), run: addBarAction },
    { keys: 'Esc', label: 'Leave note input; else close (keeps the changes)',
      match: e => e.key === 'Escape', run: () => (isInput() ? toggleInputMode() : closeStaffEditor(true)) },
    { keys: `${MOD_LABEL}Enter`, label: 'Done', match: e => isMod(e) && e.key === 'Enter', run: () => closeStaffEditor(true) },
  ];

  // Captures every key while the editor is open, so nothing reaches the page
  // behind (arrows would nudge the staff, Delete would remove it).
  document.addEventListener('keydown', e => {
    if (!staffEditor.el) return;
    const binding = STAFF_EDITOR_BINDINGS.find(b => b.match(e));
    if (!binding) return;
    e.preventDefault();
    e.stopPropagation();
    binding.run(e);
  }, true);

  // The toolbar and the shortcut sheet, built once from the bindings.
  const staffEditorButtons = [];
  (function buildStaffEditorChrome() {
    const bar = document.getElementById('staff-editor-toolbar');
    let group = null, box = null;
    STAFF_EDITOR_BINDINGS.filter(b => b.glyph).forEach(b => {
      if (b.group !== group) {
        group = b.group;
        box = mk('div', 'staff-editor-group');
        bar.appendChild(box);
      }
      const btn = mk('button', 'staff-editor-btn');
      btn.type = 'button';
      btn.title = `${b.label} (${b.keys})`;
      btn.setAttribute('aria-label', b.label);
      const glyph = mk('span', b.musical ? 'staff-editor-glyph staff-editor-glyph--music' : 'staff-editor-glyph');
      if (typeof b.glyph === 'function') glyph.appendChild(b.glyph());
      else glyph.textContent = b.glyph;
      btn.append(glyph, mk('span', 'staff-editor-key', b.keys));
      btn.addEventListener('click', () => { b.run(); btn.blur(); });
      box.appendChild(btn);
      staffEditorButtons.push({ btn, b });
    });
    const list = mk('dl', 'staff-editor-help-list');
    STAFF_EDITOR_BINDINGS.forEach(b => list.append(mk('dt', null, b.keys), mk('dd', null, b.label)));
    staffEditorHelp.appendChild(list);
    document.getElementById('staff-editor-done').addEventListener('click', () => closeStaffEditor(true));
    document.getElementById('staff-editor-cancel').addEventListener('click', () => closeStaffEditor(false));
  })();

  const DURATION_NAMES = Object.fromEntries(RHYTHM_MENU_OPTIONS.filter(o => o.type === 'note').map(o => [o.duration, o.label.toLowerCase()]));
  // "Bar 2, beat 3" for a place (the cursor after the last cell: "end").
  function staffPlaceLabel(el, addr) {
    if (addr.idx >= el.cells.length) return 'End of the staff';
    const barUnits = staffBarUnits(el);
    const pos = cellStart(el.cells, addr.idx);
    const beat = (pos % barUnits) / barBeatUnits(el.denominator || 4) + 1;
    const text = `Bar ${Math.floor(pos / barUnits) + 1}, beat ${Math.round(beat * 100) / 100}`;
    return addr.subIdx != null ? `${text}, triplet note ${addr.subIdx + 1}` : text;
  }

  function renderStaffEditor() {
    const { el } = staffEditor;
    if (!el) return;
    const svg = staffEditorSvg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // The same staff drawn big: it keeps the real one's key and transposition,
    // so the notes read exactly as they do on the page.
    const view = { ...el, x: 24, y: 84, h: STAFF_EDITOR_H };
    const leadW = notestaffLeadWidth(view);
    view.w = Math.max(STAFF_EDITOR_VIEW_W - view.x - leadW - 24, staffMinWidth(view));
    const viewW = view.x + leadW + view.w + 24, viewH = view.y + view.h + 84;
    svg.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);
    svg.appendChild(svgRect(0, 0, viewW, viewH, { cls: 'staff-editor-bg' }));
    drawStaffLines(svg, view);
    drawClef(svg, view);
    drawKeySignature(svg, view);
    drawStaffBarlines(svg, view, view.x + leadW, view.w, el.cells);

    const input = isInput();
    // One undo step per drag: a drag keeps calling the callbacks of the
    // render it started in, so this flag lives exactly one gesture.
    let dragRecorded = false;
    const { cellBoxes } = renderStaffCells(svg, displayedCells(el), view.x + leadW, view.y, view.w, view, {
      selected: (idx, subIdx) => sameAddr(staffEditor.sel, { idx, subIdx }),
      onCellClick: (idx, subIdx) => {
        staffEditor.sel = { idx, subIdx };
        staffEditor.message = '';
        renderStaffEditor();
      },
      onNoteDrag: (idx, ddy, startPitch, subIdx) => {
        const addr = { idx, subIdx };
        if (!dragRecorded) { staffEditor.undo.push(staffSnapshot(el)); staffEditor.redo = []; dragRecorded = true; }
        const pitch = clamp(startPitch + Math.round(-ddy / (view.h / 8)), STAFF_PITCH_MIN, STAFF_PITCH_MAX);
        setChainNote(el, addr, pitch, displayedStaffNote(el, cellAt(el, addr)).accidental);
        staffEditor.sel = addr;
        markDirty(); renderSvg(); renderStaffEditor();
      },
    });

    // Where a cell's note would go, horizontally: the head's spot in a plain
    // cell (see renderStaffCells' noteCx), a slot's centre in a tuplet.
    const boxOf = a => {
      if (a.idx >= cellBoxes.length) return null;
      const b = cellBoxes[a.idx];
      return a.subIdx != null ? b.subs[a.subIdx] : b;
    };
    const headX = a => {
      const b = boxOf(a);
      if (!b) return view.x + leadW + view.w - view.h * 0.3;
      return a.subIdx != null ? b.cx : b.x + Math.min(b.w, view.h * 0.45) / 2;
    };
    if (input) {
      const cx = headX(staffEditor.cursor);
      svg.appendChild(svgRect(cx - view.h * 0.2, view.y - view.h * 0.35, view.h * 0.4, view.h * 1.7, { cls: 'staff-editor-cursor', rx: 3 }));
      // In note input a click on the staff writes a note there, at the pitch
      // under the pointer (shown as a faint ghost head while hovering).
      const capture = svgRect(view.x + leadW, view.y - view.h, view.w, view.h * 3, { cls: 'staff-editor-capture' });
      const ghost = svgGroup({ cls: 'staff-editor-ghost' });
      const at = ev => {
        const { rect, scale } = svgMetricsFor(svg);
        const x = (ev.clientX - rect.left) / scale, y = (ev.clientY - rect.top) / scale;
        let addr = { idx: el.cells.length, subIdx: null };
        staffAddresses(el).forEach(a => { if (x >= boxOf(a).x) addr = a; });
        if (x < cellBoxes[0].x) addr = staffAddresses(el)[0];
        return { addr, pitch: clamp(Math.round((view.y + view.h - y) / (view.h / 8)), STAFF_PITCH_MIN, STAFF_PITCH_MAX) };
      };
      capture.addEventListener('mousemove', ev => {
        const { addr, pitch } = at(ev);
        while (ghost.firstChild) ghost.removeChild(ghost.firstChild);
        const cx = headX(addr), size = view.h * 0.65;
        drawLedgerLines(ghost, view, cx, pitch, noteheadHalfW(8, size) + size * 0.1);
        ghost.appendChild(svgText(noteheadCode(staffEditor.duration), cx, pitchToY(pitch, view), { cls: 'el-notehead-oval', anchor: 'middle', size }));
      });
      capture.addEventListener('mouseleave', () => { while (ghost.firstChild) ghost.removeChild(ghost.firstChild); });
      capture.addEventListener('click', ev => {
        const { addr, pitch } = at(ev);
        staffEditor.cursor = addr;
        writeAt('note', () => pitch);
      });
      svg.appendChild(capture);
      svg.appendChild(ghost);
    }

    staffEditorButtons.forEach(({ btn, b }) => { if (b.isOn) btn.classList.toggle('staff-editor-btn--on', !!b.isOn()); });
    document.getElementById('staff-editor-info').textContent =
      `${el.clef === 'bass' ? 'Bass' : 'Treble'} clef · ${keySignatureLabel(displayedKeySignature(el))} · ${el.numerator || 4}/${el.denominator || 4} · ${staffBarCount(el)} of ${STAFF_MAX_BARS} bars`;
    const where = staffPlaceLabel(el, input ? staffEditor.cursor : staffEditor.sel);
    document.getElementById('staff-editor-status').textContent = input
      ? `Note input · writing ${DURATION_NAMES[staffEditor.duration] || ''} notes · ${where}`
      : `Normal · ${where} · N to write notes`;
    const msg = document.getElementById('staff-editor-message');
    msg.textContent = staffEditor.message;
    msg.hidden = !staffEditor.message;
  }

  /* ---------- transpose box ---------- */
  // Above the edit box; rebuilt whenever the transposition or the sheet's key
  // changes. The heading and the sheet's key field sit above it in the
  // template, so typing a key doesn't rebuild (and unfocus) the field. Transposing only changes the view, so nothing here marks the
  // sheet as unsaved.
  const transposeBox = document.getElementById('transpose-box');
  function renderTransposeBox() {
    const t = transposeState;
    const key = parseKey(model.key);
    if (!key) t.semitones = 0;
    transposeBox.textContent = '';
    if (!key) {
      transposeBox.appendChild(mk('div', 'eb-hint', isViewer()
        ? 'This sheet has no key set, so it can’t be transposed.'
        : 'Set the sheet’s key above to transpose.'));
      return;
    }
    const apply = () => { renderTransposeBox(); renderSvg(); };

    const line = mk('div', 'tr-key-line');
    line.appendChild(mk('span', 'tr-key', `Key: ${transposedKeyName()} (${formatAmount(t.semitones)})`));
    const change = mk('button', 'eb-btn', t.pickerOpen ? 'Close' : 'Change');
    change.type = 'button';
    change.addEventListener('click', () => { t.pickerOpen = !t.pickerOpen; renderTransposeBox(); });
    line.appendChild(change);
    transposeBox.appendChild(line);

    if (t.pickerOpen) {
      const grid = mk('div', 'tr-keys');
      const shortSuffix = key.minor ? 'm' : '';
      for (let s = 0; s < 12; s++) {
        let d = (((s - key.semitone) % 12) + 12) % 12;
        if (d > 6) d -= 12; // the shorter way round; a tritone goes up
        const flats = d === 0 ? keyPrefersFlats(model.key)
          : t.flatsChosen ? t.flats : semitonePrefersFlats(s, key.minor);
        const b = mk('button', d === t.semitones ? 'eb-btn eb-btn--on' : 'eb-btn', noteName(s, flats) + shortSuffix);
        b.type = 'button';
        b.title = d === 0 ? 'Original key' : formatAmount(d);
        b.addEventListener('click', () => {
          t.semitones = d;
          if (d && !t.flatsChosen) t.flats = semitonePrefersFlats(s, key.minor);
          apply();
        });
        grid.appendChild(b);
      }
      transposeBox.appendChild(grid);
    }

    const acc = mk('div', 'eb-field tr-acc');
    acc.appendChild(mk('span', 'eb-label', 'Accidentals'));
    const seg = mk('span', 'eb-seg');
    [['♯', false, 'Sharps'], ['♭', true, 'Flats']].forEach(([label, flats, title]) => {
      const b = mk('button', t.semitones && t.flats === flats ? 'eb-btn eb-btn--on' : 'eb-btn', label);
      b.type = 'button';
      b.disabled = !t.semitones; // the original chords show exactly as written
      b.title = t.semitones ? title : `${title} (when transposed)`;
      b.addEventListener('click', () => { t.flats = flats; t.flatsChosen = true; apply(); });
      seg.appendChild(b);
    });
    acc.appendChild(seg);
    transposeBox.appendChild(acc);
  }

  /* ---------- toolbar wiring ---------- */
  document.getElementById('sheet-title').addEventListener('input', e => { model.title = e.target.value; markDirty(); renderSvg(); });
  document.getElementById('sheet-artist').addEventListener('input', e => { model.artist = e.target.value; markDirty(); renderSvg(); });
  document.getElementById('sheet-key').addEventListener('input', e => { model.key = e.target.value; markDirty(); renderTransposeBox(); renderStaffBuilderSvg(); renderSvg(); });

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

  document.getElementById('print-btn').addEventListener('click', () => window.print());

  /* ---------- share as PDF (phones) ---------- */
  // On a phone the viewer's button hands the sheet, as it looks now
  // (transposition included), to the OS share sheet as an A4 PDF -- Messages,
  // WhatsApp, Mail, AirDrop... Where the browser can't share files it prints.
  // The PDF is one full-page JPEG of the sheet drawn at ~240 dpi: the SVG is
  // inlined (computed styles + the MuseJazz fonts as data URIs, since an SVG
  // loaded as an image sees neither the page's CSS nor its fonts), drawn onto
  // a canvas, and wrapped in a minimal hand-written PDF.
  const SHARE_SCALE = 2.5;
  const SHARE_STYLE_PROPS = [
    'display', 'visibility', 'opacity', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity',
    'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'font-family',
    'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline',
  ];
  const SHARE_DROP = '.el-selection, .el-slot-active, .el-marquee, .el-resize-handle, .el-move-handle, .el-arrow-handle, .el-arrow-bow-handle';
  const viewerPrintBtn = document.getElementById('viewer-print-btn');
  const canShareFiles = (() => {
    try {
      return !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] }));
    } catch (err) { return false; }
  })();
  let shareFontCss = null;
  let shareBusy = false;

  async function loadShareFontCss() {
    if (shareFontCss) return shareFontCss;
    const faces = await Promise.all(['MuseJazzText', 'MuseJazz'].map(async name => {
      const buf = await (await fetch(`/static/fonts/${name}.otf`)).arrayBuffer();
      let bin = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return `@font-face{font-family:'${name}';src:url(data:font/otf;base64,${btoa(bin)}) format('opentype');}`;
    }));
    return (shareFontCss = faces.join(''));
  }

  function sheetSvgMarkup(fontCss) {
    const src = document.getElementById('sheet-svg');
    const clone = src.cloneNode(true);
    const srcEls = src.querySelectorAll('*');
    const cloneEls = clone.querySelectorAll('*');
    srcEls.forEach((el, i) => {
      const cs = getComputedStyle(el);
      cloneEls[i].setAttribute('style', SHARE_STYLE_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'));
    });
    // Same clean-up as the print stylesheet: no editing chrome, white paper.
    clone.querySelectorAll(SHARE_DROP).forEach(n => n.remove());
    clone.querySelectorAll('.el-chord-slot').forEach(n => { n.style.fill = 'none'; n.style.stroke = 'none'; });
    clone.querySelectorAll('.page-bg, .el-title-box-fill').forEach(n => { n.style.fill = '#fff'; n.style.stroke = 'none'; });
    clone.removeAttribute('id');
    clone.removeAttribute('class');
    clone.setAttribute('width', PAGE_W);
    clone.setAttribute('height', PAGE_H);
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = fontCss;
    clone.insertBefore(style, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }

  async function sheetJpegBytes() {
    const markup = sheetSvgMarkup(await loadShareFontCss());
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(PAGE_W * SHARE_SCALE);
      canvas.height = Math.round(PAGE_H * SHARE_SCALE);
      const ctx = canvas.getContext('2d');
      const draw = () => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      // WebKit can paint an SVG image before its embedded fonts are ready;
      // drawing a second time a moment later picks them up.
      draw();
      await new Promise(r => setTimeout(r, 150));
      draw();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
      return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // A one-page A4 PDF whose page is the JPEG, edge to edge (DCTDecode takes
  // the JPEG bytes as they are).
  function jpegToPdf({ bytes, w, h }) {
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let len = 0;
    const push = p => { const b = typeof p === 'string' ? enc.encode(p) : p; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n${body}\nendobj\n`); };
    const pw = 595.28, ph = 841.89;
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    push('%PDF-1.4\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
    offsets[4] = len;
    push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    push('\nendstream\nendobj\n');
    obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const xref = len;
    push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
    push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }

  function shareFileName() {
    const base = (model.title || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').trim() || 'Lead sheet';
    const key = transposeState.semitones ? transposedKeyName() : '';
    return key ? `${base} (${key}).pdf` : `${base}.pdf`;
  }

  async function sharePdfFile(file) {
    try {
      await navigator.share({ files: [file], title: model.title || 'Lead sheet' });
    } catch (err) {
      if (err.name === 'AbortError') return; // the share sheet was dismissed
      if (err.name === 'NotAllowedError') {
        // Building the PDF took longer than the browser lets a tap count as
        // "the user asked to share". It's ready now, so the next tap shares
        // straight away.
        viewerPrintBtn.textContent = 'Tap to share';
        return;
      }
      window.print();
    }
  }

  viewerPrintBtn.addEventListener('click', async () => {
    if (!canShareFiles) { window.print(); return; }
    if (sharePdf) { viewerPrintBtn.textContent = 'Share PDF'; sharePdfFile(sharePdf); return; }
    if (shareBusy) return;
    shareBusy = true;
    viewerPrintBtn.disabled = true;
    viewerPrintBtn.textContent = 'Preparing…';
    try {
      const blob = jpegToPdf(await sheetJpegBytes());
      sharePdf = new File([blob], shareFileName(), { type: 'application/pdf' });
      viewerPrintBtn.textContent = 'Share PDF';
      await sharePdfFile(sharePdf);
    } catch (err) {
      viewerPrintBtn.textContent = 'Share PDF';
      window.print();
    } finally {
      shareBusy = false;
      viewerPrintBtn.disabled = false;
    }
  });
  if (canShareFiles) {
    viewerPrintBtn.textContent = 'Share PDF';
    loadShareFontCss().catch(() => {});
  }

  // Entering the viewer (on load, or when a rotate/resize crosses the
  // breakpoint) drops any selection and closes the editing popups; leaving it
  // just brings the tools back.
  function applyViewerMode() {
    const on = isViewer();
    document.body.classList.toggle('lead-viewer', on);
    if (!on) return;
    if (staffEditor.el) closeStaffEditor(true);
    if (activeRhythmMenu) closeRhythmMenu();
    selectedIds.clear();
    activeSlot = null;
    marquee = null;
    transposeState.pickerOpen = true;
  }
  viewerMQ.addEventListener('change', () => { applyViewerMode(); renderTransposeBox(); renderSvg(); });
  applyViewerMode();

  const confirmModal = document.getElementById('confirm-modal');
  document.getElementById('delete-btn').addEventListener('click', () => {
    document.getElementById('confirm-text').textContent = `Delete "${model.title.trim() || 'Untitled'}"?`;
    confirmModal.hidden = false;
  });
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
