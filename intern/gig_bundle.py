"""Bundles a gig's lead sheets or lyrics: for each song in its setlist, look
up the matching source (Lead Sheets library entry, or master songbook page)
and merge the results into one PDF. Songs with no match are listed on a note
page prepended to the bundle, so the information travels with the file
itself rather than needing a separate UI warning.
"""

from io import BytesIO

from pypdf import PdfReader, PdfWriter

import chords
import pdf_utils
import setlist
import setlists


def build_leadsheets_bundle(gig_id: str) -> tuple[bytes, list[str]]:
    """Returns (pdf_bytes, missing_titles). Raises KeyError if gig_id unknown."""
    gig = setlists.get_setlist(gig_id)

    missing: list[str] = []
    parts: list[bytes] = []

    for row in gig["songs"]:
        if row.get("type") != "song":
            continue
        title = row.get("title") or ""
        slug = chords.slugify(title)
        song = chords.get_song(slug)
        if not song or not song.get("tagged"):
            missing.append(title)
            continue

        target = row.get(row.get("singer") or "") or ""
        semitones = chords.semitones_for_target_key(song["key"], target) if target.strip() else 0
        parts.append(chords.transpose_song(slug, semitones))

    if missing:
        parts.insert(0, pdf_utils.note_page_pdf("Not available", missing))
    if not parts:
        parts.append(pdf_utils.note_page_pdf("Not available", ["This gig has no songs yet."]))

    return pdf_utils.merge_pdfs(parts), missing


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
