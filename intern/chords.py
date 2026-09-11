"""Chord name parsing, transposition, and slug helpers -- shared by the
lead sheet builder (leadsheets.py) and, in principle, anything else that
needs to understand or shift a chord symbol.
"""

import re

ROOTS = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"]
# Black keys get both spellings (charts are handwritten in either); natural
# keys don't need a flat/sharp alias (no B#, no Fb).
FLAT_OF_SHARP = {"A#": "Bb", "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab"}
SHARP_OF_FLAT = {flat: sharp for sharp, flat in FLAT_OF_SHARP.items()}

ROOT_SPELLINGS = []
for _note in ROOTS:
    ROOT_SPELLINGS.append(_note)
    if _note in FLAT_OF_SHARP:
        ROOT_SPELLINGS.append(FLAT_OF_SHARP[_note])

QUALITIES = ["", "m", "7", "m7", "m7b5", "maj7", "dim", "sus2", "sus4", "6"]

CHORD_LABELS = [f"{root}{quality}" for quality in QUALITIES for root in ROOT_SPELLINGS]

_QUALITY_PATTERN = "|".join(sorted((q for q in QUALITIES if q), key=len, reverse=True))
_ROOT_PATTERN = "|".join(sorted(ROOT_SPELLINGS, key=len, reverse=True))
CHORD_NAME_RE = re.compile(
    rf"^(?P<root>{_ROOT_PATTERN})(?P<quality>{_QUALITY_PATTERN})?(?:/(?P<bass>{_ROOT_PATTERN}))?$"
)


class ChordError(Exception):
    """Raised for chord parsing or transposition problems."""


def parse_chord(name: str) -> tuple[str, str, str | None]:
    match = CHORD_NAME_RE.match(name.strip())
    if not match:
        raise ChordError(f"Can't parse chord name '{name}'.")
    return match.group("root"), match.group("quality") or "", match.group("bass")


def _pitch_class(note: str) -> int:
    return ROOTS.index(SHARP_OF_FLAT.get(note, note))


def transpose_note(note: str, semitones: int) -> str:
    new_sharp = ROOTS[(_pitch_class(note) + semitones) % 12]
    was_flat = note in SHARP_OF_FLAT
    if was_flat and new_sharp in FLAT_OF_SHARP:
        return FLAT_OF_SHARP[new_sharp]
    return new_sharp


def transpose_chord_name(name: str, semitones: int) -> str:
    root, quality, bass = parse_chord(name)
    new_name = f"{transpose_note(root, semitones)}{quality}"
    if bass:
        new_name += f"/{transpose_note(bass, semitones)}"
    return new_name


def semitones_for_target_key(from_key: str, to_key: str) -> int:
    from_root, _, _ = parse_chord(from_key)
    to_root, _, _ = parse_chord(to_key)
    return (_pitch_class(to_root) - _pitch_class(from_root)) % 12


def slugify(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.strip().lower()).strip("-")
    if not slug:
        raise ChordError("Title can't be empty.")
    return slug
