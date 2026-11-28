"""Connecting per-song documents (lead sheets, lyrics) to songs.

A doc can be connected to one repertoire song ("repertoire_id"), and a song
to at most one doc of each kind. The key's three states: absent -- never
decided, so auto_link() may connect it by title; None -- not connected to a
repertoire song; an id -- connected. With repertoire_id None, "new_song"
may instead hold the title of a song from an upcoming setlist that isn't in
the repertoire yet (see upcoming_new_songs); once that song joins the
repertoire, auto_link() moves the doc over to it. "link_auto" marks a
connection made by title matching rather than picked by hand.
"""

from typing import Callable

import repertoire
import setlists


def fold(title) -> str:
    return str(title or "").strip().casefold()


def upcoming_new_songs() -> list[dict]:
    """Songs on upcoming setlists that aren't in the repertoire, once per
    title (ignoring case), soonest gig first. A row whose title matches a
    repertoire song counts as that song, even if it was never linked to it.
    Each carries the song fields of its soonest row, so it can be copied
    onto another setlist: [{title, artist, year, key, signe, jonas, duet,
    indstilling, gigs: [{id, date, venue}]}]."""
    upcoming, _ = setlists.split_upcoming_past(setlists.list_setlists())
    known = {fold(song.get("title")) for song in repertoire.list_songs()}
    by_title: dict[str, dict] = {}
    for gig in upcoming:
        for row in gig.get("songs", []):
            if row.get("type") != "song" or row.get("repertoire_id"):
                continue
            folded = fold(row.get("title"))
            if not folded or folded in known:
                continue
            entry = by_title.get(folded)
            if entry is None:
                entry = by_title[folded] = {field: row.get(field) for field in repertoire.FIELDS}
                entry["title"] = row["title"].strip()
                entry["artist"] = row.get("artist") or ""
                entry["gigs"] = []
            if not entry["artist"] and row.get("artist"):
                entry["artist"] = row["artist"]
            if not any(g["id"] == gig["id"] for g in entry["gigs"]):
                entry["gigs"].append({"id": gig["id"], "date": gig.get("date", ""), "venue": gig.get("venue", "")})
    return list(by_title.values())


def links(docs: list[dict]) -> dict[str, dict]:
    """{repertoire song id: its doc} for every connected song."""
    return {d["repertoire_id"]: d for d in docs if d.get("repertoire_id")}


def new_song_links(docs: list[dict]) -> dict[str, dict]:
    """{folded new-song title: its doc} for every doc connected to one."""
    return {fold(d["new_song"]): d for d in docs if d.get("new_song")}


def apply_link(
    doc: dict, docs: list[dict], repertoire_id: str | None, new_song: str | None, kind: str
) -> None:
    """Connect `doc` by hand to a repertoire song, or to a new song (by
    title), or to nothing when both are empty. `docs` are all docs of its
    kind, to check the song isn't taken; `kind` names them in the error."""
    repertoire_id = str(repertoire_id or "").strip() or None
    new_song = str(new_song or "").strip() or None
    if repertoire_id:
        if not any(song["id"] == repertoire_id for song in repertoire.list_songs()):
            raise ValueError("That repertoire song doesn't exist.")
        other = links(docs).get(repertoire_id)
        new_song = None
    elif new_song:
        other = new_song_links(docs).get(fold(new_song))
    else:
        other = None
    if other and other["id"] != doc["id"]:
        raise ValueError(f"That song is already connected to the {kind} '{other['title']}'.")
    doc["repertoire_id"] = repertoire_id
    doc.pop("link_auto", None)
    if new_song:
        doc["new_song"] = new_song
    else:
        doc.pop("new_song", None)


def _find_match(title: str, candidates: list[dict], all_titles: list[str]) -> dict | None:
    """The song a doc titled `title` should connect to, the way the setlist
    editor auto-connects lyrics (findAutoConnections): an exact title
    (ignoring case) first; else a title containing the other, but only when
    that's unambiguous both ways -- one candidate song, and no other
    unconnected doc that would match it too."""
    folded = title.casefold()
    exact = [song for song in candidates if song["title"].strip().casefold() == folded]
    if len(exact) == 1:
        return exact[0]

    def contains(a: str, b: str) -> bool:
        a, b = a.casefold(), b.casefold()
        return bool(a and b) and (a in b or b in a)

    loose = [song for song in candidates if contains(song["title"].strip(), title)]
    if len(loose) != 1:
        return None
    rivals = [t for t in all_titles if contains(loose[0]["title"].strip(), t)]
    return loose[0] if len(rivals) == 1 else None


def auto_link(docs: list[dict], save: Callable[[dict], None]) -> None:
    """Connect every doc whose connection was never decided to the song
    with the same title, if there is exactly one free one: a repertoire song
    first, else a new song from an upcoming setlist. A doc connected to a
    new song moves to the repertoire song once one has that title. Docs
    with no match stay undecided, so a song added later still can.
    `save` stores a doc that changed."""
    songs = repertoire.list_songs()
    taken = {d["repertoire_id"] for d in docs if d.get("repertoire_id")}
    free_songs = [song for song in songs if song["id"] not in taken]

    for doc in docs:
        if not doc.get("new_song"):
            continue
        song = next((s for s in free_songs if fold(s["title"]) == fold(doc["new_song"])), None)
        if song is None:
            continue
        doc["repertoire_id"] = song["id"]
        del doc["new_song"]
        free_songs.remove(song)
        save(doc)

    undecided = [d for d in docs if "repertoire_id" not in d]
    if not undecided:
        return
    taken_new = {fold(d["new_song"]) for d in docs if d.get("new_song")}
    free_new = [song for song in upcoming_new_songs() if fold(song["title"]) not in taken_new]
    undecided_titles = [d["title"] for d in undecided]
    for doc in undecided:
        song = _find_match(doc["title"], free_songs, undecided_titles)
        if song is not None:
            doc["repertoire_id"] = song["id"]
            free_songs.remove(song)
        else:
            song = _find_match(doc["title"], free_new, undecided_titles)
            if song is None:
                continue
            doc["repertoire_id"] = None
            doc["new_song"] = song["title"]
            free_new.remove(song)
        doc["link_auto"] = True
        save(doc)
