"""Bundles a gig's lyrics and lead sheets.

Lyrics: for each song in its setlist, look up the matching master songbook
page and merge the results into one PDF. Songs with no match are listed on
a note page prepended to the bundle, so the information travels with the
file itself rather than needing a separate UI warning.

Lead sheets are only drawn in the browser (static/leadsheet-editor.js), so
here we just work out which sheet each song uses and how far to transpose
it; the gig's lead-sheets page renders and merges them into the PDF.
"""

from io import BytesIO

from pypdf import PdfReader, PdfWriter

import chords
import leadsheets
import pdf_utils
import setlist
import setlists

SINGER_NAMES = {"signe": "Signe", "jonas": "Jonas", "duet": "Duet"}


def build_lyrics_bundle(gig_id: str) -> tuple[bytes, list[str]]:
    """Returns (pdf_bytes, missing_titles). Raises KeyError if gig_id unknown."""
    gig = setlists.get_setlist(gig_id)

    missing: list[str] = []
    parts: list[bytes] = []

    songbook = setlist.get_songbook()
    master_path = setlist.get_master_pdf_path()
    if songbook and master_path.exists():
        aliases = setlist.get_aliases()
        pages_by_title = {song["title"]: song["pages"] for song in songbook["songs"]}
        reader = PdfReader(str(master_path))

        for row in gig["songs"]:
            if row.get("type") != "song":
                continue
            title = row.get("title") or ""
            pages = pages_by_title.get(aliases.get(title, title))
            if not pages:
                missing.append(title)
                continue
            writer = PdfWriter()
            for page_num in pages:
                writer.add_page(reader.pages[page_num])
            buf = BytesIO()
            writer.write(buf)
            parts.append(buf.getvalue())
    else:
        missing = [row.get("title") or "" for row in gig["songs"] if row.get("type") == "song"]

    if missing:
        parts.insert(0, pdf_utils.note_page_pdf("Missing lyrics", missing))
    if not parts:
        parts.append(pdf_utils.note_page_pdf("Not available", ["No lyrics available for this gig."]))

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


def build_leadsheet_plan(gig_id: str) -> dict:
    """What the gig's lead-sheet PDF holds, in setlist order: each song's
    sheet with the transposition to draw it at, plus the songs that have no
    sheet and anything worth checking, for a note page at the front.
    Raises KeyError if gig_id is unknown."""
    gig = setlists.get_setlist(gig_id)
    leadsheets.auto_link()
    by_song = leadsheets.links()
    by_title = {sheet["title"].strip().casefold(): sheet for sheet in leadsheets.list_leadsheets()}

    pages: list[dict] = []
    missing: list[str] = []
    notes: list[str] = []
    # The setlist page: every song (with or without a sheet) and the key
    # it's played in, split into sets at the pauses.
    sets: list[list[dict]] = [[]]
    for row in gig["songs"]:
        if row.get("type") == "break":
            sets.append([])
            continue
        if row.get("type") != "song":
            continue
        title = row.get("title") or ""
        singer = row.get("singer") or ""
        played_offset = (row.get(singer) if singer else 0) or 0
        sets[-1].append({"title": title, "key": chords.transpose_key(row.get("key") or "", played_offset)})
        if row.get("repertoire_id"):
            sheet = by_song.get(row["repertoire_id"])
        else:
            sheet = by_title.get(title.strip().casefold())
        if sheet is None:
            missing.append(title)
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
        pages.append({"sheet": sheet, "semitones": semitones, "flats": flats, "label": label, "singer": who})

    name = " ".join(part for part in (gig.get("date"), gig.get("venue")) if part) or "Gig"
    return {
        "pages": pages,
        "sets": [songs for songs in sets if songs],
        "missing": missing,
        "notes": notes,
        "filename": f"{name} – lead sheets.pdf",
    }
