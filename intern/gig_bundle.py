"""Bundles a gig's lyrics: for each song in its setlist, look up the
matching master songbook page and merge the results into one PDF. Songs
with no match are listed on a note page prepended to the bundle, so the
information travels with the file itself rather than needing a separate
UI warning.

The equivalent lead-sheets bundle (once built from the old image-based
lead sheets) is retired for now -- see the "/gigs/{gig_id}/leadsheets"
route in app.py.
"""

from io import BytesIO

from pypdf import PdfReader, PdfWriter

import pdf_utils
import setlist
import setlists


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
