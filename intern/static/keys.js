/* Song keys and singer transpositions, shared by the repertoire page and the
 * setlist editor. Mirrors the key helpers in chords.py: a song's key is one
 * of 24 fixed spellings, and each singer's transposition is a whole number
 * of half-steps from it (-6..+6, 0 = original, null = not set).
 */
(function () {
  const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
  const KEYS = MAJOR_KEYS.concat(MINOR_KEYS);
  const OFFSETS = [];
  for (let n = -6; n <= 6; n++) OFFSETS.push(n);

  function transposeKey(key, semitones) {
    if (!key) return '';
    const minor = MINOR_KEYS.includes(key);
    const list = minor ? MINOR_KEYS : MAJOR_KEYS;
    const pc = list.indexOf(key);
    if (pc < 0) return '';
    return list[(((pc + semitones) % 12) + 12) % 12];
  }

  // Stored in half-steps but shown in whole tones, the way the singers say
  // it: +1 half-step reads "+0.5 (C#m)", -2 "-1 (Eb)", 0 "Original (F)";
  // without the parenthesis when the song has no key. Same text as
  // chords.offset_label.
  function offsetLabel(offset, key) {
    if (offset === null || offset === undefined || offset === '') return '';
    const n = Number(offset);
    const tones = n / 2;
    const text = n === 0 ? 'Original' : (n > 0 ? `+${tones}` : `${tones}`);
    return key ? `${text} (${transposeKey(key, n)})` : text;
  }

  // A select's string value back to what's stored: null or a number.
  function parseOffset(value) {
    return value === '' || value === null || value === undefined ? null : parseInt(value, 10);
  }

  function makeKeySelect(value) {
    const select = document.createElement('select');
    select.className = 'key-select';
    select.appendChild(new Option('', ''));
    [['Major', MAJOR_KEYS], ['Minor', MINOR_KEYS]].forEach(([label, keys]) => {
      const group = document.createElement('optgroup');
      group.label = label;
      keys.forEach(k => group.appendChild(new Option(k, k)));
      select.appendChild(group);
    });
    select.value = KEYS.includes(value) ? value : '';
    return select;
  }

  // (Re)fills an offset select for `key`, keeping its current value.
  function fillOffsetSelect(select, key, value) {
    const current = value !== undefined ? value : parseOffset(select.value);
    select.textContent = '';
    select.appendChild(new Option('', ''));
    OFFSETS.forEach(n => select.appendChild(new Option(offsetLabel(n, key), String(n))));
    select.value = current === null || current === undefined ? '' : String(current);
  }

  function makeOffsetSelect(value, key) {
    const select = document.createElement('select');
    select.className = 'offset-select';
    fillOffsetSelect(select, key, value);
    return select;
  }

  window.Keys = {
    KEYS, MAJOR_KEYS, MINOR_KEYS, OFFSETS,
    transposeKey, offsetLabel, parseOffset,
    makeKeySelect, makeOffsetSelect, fillOffsetSelect,
  };
})();
