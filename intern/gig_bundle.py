"""Bundles a gig's lyrics and lead sheets.

Lyrics: each song in the setlist gets its lyrics (written on the Lyrics
page, see lyrics.py) drawn as a page of the gig's lyrics PDF, in the key
it's played in (see lyrics_pdf.py). Songs without lyrics are listed on a
note page at the front, so the information travels with the file itself
rather than needing a separate UI warning.

Lead sheets are only drawn in the browser (static/leadsheet-editor.js), so
here we just work out which sheet each song uses and how far to transpose
it; the gig's lead-sheets page renders and merges them into the PDF.
"""

import chords
import leadsheets
import lyrics
import lyrics_pdf
import pdf_utils
import setlists
import song_links

SINGER_NAMES = {"signe": "Signe", "jonas": "Jonas", "duet": "Duet"}


def _played_key(row: dict, singer: str | None = None) -> str:
    """The key a setlist row is played in: its song key moved by its
    singer's transposition (or `singer`'s, when given)."""
    if singer is None:
        singer = row.get("singer") or ""
    offset = (row.get(singer) if singer else 0) or 0
    return chords.transpose_key(row.get("key") or "", offset)


def _lyrics_page(doc: dict, row: dict, singer: str | None = None) -> dict:
    """A lyrics doc as drawn for a gig, with a header like a lead sheet's:
    the key it's played in, how many semitones that is from the lyrics' own
    key ("semitones", shown as an arrow) and who sings it ("singer")."""
    if singer is None:
        singer = row.get("singer") or ""
    offset = (row.get(singer) if singer else 0) or 0
    doc_key, song_key = doc.get("key") or "", row.get("key") or ""
    semitones = _sheet_semitones(doc_key, song_key, offset)
    key = chords.transpose_key(song_key, offset) if song_key else chords.transpose_key(doc_key, semitones)
    return {
        "title": doc.get("title") or "",
        "artist": doc.get("artist") or "",
        "blocks": doc.get("blocks") or [],
        "key": key or doc_key,
        "semitones": semitones if key else 0,
        "singer": SINGER_NAMES.get(singer, ""),
    }


def _lyrics_finder():
    lyrics.auto_link()
    return song_links.row_finder(lyrics.list_lyrics())


def gig_filename(gig: dict, what: str) -> str:
    name = " ".join(part for part in (gig.get("date"), gig.get("venue")) if part) or "Gig"
    return f"{name} – {what}.pdf"


def build_lyrics_bundle(gig_id: str) -> tuple[bytes, list[str]]:
    """Returns (pdf_bytes, missing_titles): the lyrics of every song in the
    gig's setlist, in order. Raises KeyError if gig_id unknown."""
    gig = setlists.get_setlist(gig_id)
    find = _lyrics_finder()

    songs: list[dict] = []
    missing: list[str] = []
    for row in gig["songs"]:
        if row.get("type") != "song":
            continue
        doc = find(row)
        if doc is None:
            missing.append(row.get("title") or "")
            continue
        songs.append(_lyrics_page(doc, row))

    parts: list[bytes] = []
    if missing:
        parts.append(pdf_utils.note_page_pdf("Missing lyrics", missing))
    if songs:
        parts.append(lyrics_pdf.build(songs))
    if not parts:
        parts.append(pdf_utils.note_page_pdf("Not available", ["This gig has no songs yet."]))
    return pdf_utils.merge_pdfs(parts), missing


def _sheet_semitones(sheet_key: str, song_key: str, offset: int) -> int:
    """How far to transpose a sheet written in `sheet_key` so it reads in
    the singer's key (`song_key` moved by `offset`). Keys are compared by
    their relative major, so a sheet written in Fm for a song in Ab counts
    as already in the song's key. The result is the shorter way round
    (-5..+6); without both keys it's just the offset."""
    sheet, song = chords.read_key(sheet_key), chords.read_key(song_key)
    if not sheet or not song:
        return offset
    diff = (chords.major_pc(*song) + offset - chords.major_pc(*sheet)) % 12
    return diff - 12 if diff > 6 else diff


LEADSHEET_MODES = ("original", "transposed", "setlist")


def build_leadsheet_plan(
    gig_id: str, mode: str = "setlist", picks: dict[int, str] | None = None, with_lyrics: bool = False
) -> dict:
    """What the gig's lead-sheet PDF holds, in setlist order: each song's
    sheet with the transposition to draw it at, plus the songs that have no
    sheet and anything worth checking, for a note page at the front.
    mode "original" draws every sheet in its own key, "transposed" in the
    key it's played in, and "setlist" also puts the setlist page first.
    Each page says which set its song is in ("set": 1, 2, ..., numbered
    like the setlist page, which skips empty sets), so the setlist PDF can
    put a "Set 1", "Set 2", ... page before each set's sheets.
    "songs" lists every song in order, with or without a sheet, for the
    gig's live mode.
    `picks` (the gig page's Custom option) limits the PDF to those setlist
    rows -- index into gig["songs"] -> singer to transpose for, overriding
    the setlist's -- and leaves the setlist page out.
    `with_lyrics` (for live mode) adds each song's lyrics too: "lyrics" in
    "songs" indexes into the plan's "lyrics" (None without any).
    Raises KeyError if gig_id is unknown."""
    original = mode == "original"
    gig = setlists.get_setlist(gig_id)
    leadsheets.auto_link()
    find_sheet = song_links.row_finder(leadsheets.list_leadsheets())
    find_lyrics = _lyrics_finder() if with_lyrics else None
    lyrics_docs: list[dict] = []

    pages: list[dict] = []
    # Every song in setlist order, sheet or not, for live mode's sidebar:
    # "page" indexes into pages (None without a sheet).
    songs: list[dict] = []
    missing: list[str] = []
    notes: list[str] = []
    # The setlist page: every song (with or without a sheet) and the key
    # it's played in, split into sets at the pauses.
    sets: list[list[dict]] = [[]]
    for index, row in enumerate(gig["songs"]):
        if row.get("type") == "break":
            sets.append([])
            continue
        if row.get("type") != "song":
            continue
        if picks is not None and index not in picks:
            continue
        title = row.get("title") or ""
        singer = picks[index] if picks is not None else row.get("singer") or ""
        sets[-1].append({"title": title, "key": _played_key(row, singer)})
        set_number = sum(1 for songs in sets if songs)
        sheet = find_sheet(row)
        songs.append({
            "title": title, "key": sets[-1][-1]["key"], "set": set_number,
            "page": None if sheet is None else len(pages),
        })
        if find_lyrics:
            doc = find_lyrics(row)
            songs[-1]["lyrics"] = None if doc is None else len(lyrics_docs)
            if doc is not None:
                lyrics_docs.append(_lyrics_page(doc, row, singer))
        if sheet is None:
            missing.append(title)
            continue
        if original:
            pages.append({"sheet": sheet, "semitones": 0, "flats": False, "label": title, "singer": "", "set": set_number})
            continue

        offset = row.get(singer) if singer else 0
        if offset is None:
            notes.append(f"{title}: no {SINGER_NAMES.get(singer, singer)} transposition set -- original key")
            offset = 0
        song_key = row.get("key") or ""
        sheet_key = sheet.get("key") or ""
        semitones = _sheet_semitones(sheet_key, song_key, offset)

        sheet_read, song_read = chords.read_key(sheet_key), chords.read_key(song_key)
        if sheet_read and song_read and chords.major_pc(*sheet_read) != chords.major_pc(*song_read):
            drawn = chords.key_name(sheet_read[0] + semitones, sheet_read[1])
            notes.append(
                f"{title}: the sheet is in {sheet_key} but the repertoire says {song_key} -- drawn in {drawn}"
            )
        elif not sheet_read and offset:
            notes.append(f"{title}: the sheet has no key set, so it isn't transposed")
            semitones = 0

        flats = False
        if sheet_read:
            flats = chords.prefers_flats(sheet_read[0] + semitones, sheet_read[1]) if semitones else False
        who = SINGER_NAMES.get(singer, "")
        label = f"{title} — {who} {chords.offset_label(offset, song_key)}".strip() if who else title
        pages.append({
            "sheet": sheet, "semitones": semitones, "flats": flats, "label": label, "singer": who, "set": set_number,
        })

    plan = {
        "pages": pages,
        "songs": songs,
        "sets": [songs for songs in sets if songs] if mode == "setlist" and picks is None else [],
        "missing": missing,
        "notes": notes,
        "filename": gig_filename(gig, f"lead sheets{' (original keys)' if original else ''}"),
    }
    if with_lyrics:
        plan["lyrics"] = lyrics_docs
    return plan
