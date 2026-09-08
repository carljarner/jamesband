"""Bundles a gig's lead sheets: for each song in its setlist, look up the
matching Lead Sheets library entry, transpose it to the gig's chosen key,
and merge the results into one PDF. Songs with no library match (or not
yet tagged) are listed on a note page prepended to the bundle, so the
information travels with the file itself rather than needing a separate
UI warning.
"""

import chords
import pdf_utils
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
