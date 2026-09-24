"""One-off migration: turn the old free-text key and transposition fields
into the structured values the app now expects (see the key helpers in
chords.py).

  key                  "Abm", "Hm", "Eb/Cm"     -> "G#m", "Bm", "Eb"
  signe / jonas / duet "Original", "0.5 op (C#m)", "2 ned" -> 0, +1, -4

Covers the repertoire and every song row of every gig. Values it can't read
are cleared and listed, as are transpositions whose key in parentheses
doesn't match the one the half-steps land on, so they can be fixed by hand.

Dry run by default (prints the report only); pass --write to save.
Running it again on already-migrated data changes nothing.

    python migrate_keys.py            # report
    python migrate_keys.py --write    # report and save
"""

import re
import sys

import chords
import data_store
import repertoire
import setlists

OFFSET_RE = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(op|ned)\b\s*(?:\((?P<paren>[^)]*)\))?", re.IGNORECASE)
parse_key = chords.read_key


def migrate_key(value, where: str, report: list[str]) -> str:
    if value in chords.KEYS or value == "":
        return value
    parsed = parse_key(value)
    if parsed is None:
        report.append(f"{where}: key {value!r} not recognised -> cleared")
        return ""
    return chords.key_name(*parsed)


def migrate_offset(value, key: str, where: str, report: list[str]):
    if value is None or isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        return None
    if text.lower().startswith("orig"):
        return 0
    match = OFFSET_RE.match(text)
    if not match:
        report.append(f"{where}: {text!r} not recognised -> cleared")
        return None
    steps = float(match.group(1).replace(",", "."))
    offset = round(steps * 2) * (1 if match.group(2).lower() == "op" else -1)
    if offset not in chords.OFFSET_RANGE:
        report.append(f"{where}: {text!r} is {offset:+d} half-steps, outside -6..+6 -> cleared")
        return None
    paren = parse_key(match.group("paren") or "")
    if key and paren:
        landed = chords.transpose_key(key, offset)
        if chords.parse_key(landed)[0] != paren[0]:
            report.append(
                f"{where}: {text!r} from {key} lands on {landed}, not {match.group('paren')} "
                f"-> kept as {offset:+d}, please check"
            )
    return offset


def migrate_song(song: dict, where: str, report: list[str]) -> bool:
    before = {f: song.get(f) for f in ("key", *repertoire.OFFSET_FIELDS)}
    song["key"] = migrate_key(song.get("key") or "", where, report)
    for field in repertoire.OFFSET_FIELDS:
        song[field] = migrate_offset(song.get(field), song["key"], f"{where} [{field}]", report)
    return before != {f: song.get(f) for f in before}


def main(write: bool) -> None:
    report: list[str] = []
    changed = 0

    songs = data_store.load_json(repertoire.REPERTOIRE_PATH, default=[])
    for song in songs:
        changed += migrate_song(song, f"Repertoire '{song.get('title')}'", report)

    gigs = data_store.load_json(setlists.SETLISTS_PATH, default=[])
    for gig in gigs:
        for row in gig.get("songs", []):
            if row.get("type") == "break":
                continue
            changed += migrate_song(row, f"Gig {gig.get('date')} {gig.get('venue')} '{row.get('title')}'", report)

    print("\n".join(report) or "Nothing to report.")
    print(f"\n{changed} song rows to change.")
    if write and changed:
        data_store.save_json(repertoire.REPERTOIRE_PATH, songs)
        repertoire.export_public()
        data_store.save_json(setlists.SETLISTS_PATH, gigs)
        print("Saved.")
    elif changed:
        print("Dry run -- pass --write to save.")


if __name__ == "__main__":
    main("--write" in sys.argv[1:])
