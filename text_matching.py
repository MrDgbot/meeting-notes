"""Punctuation-insensitive text normalization, contextual span search, and safe chunking."""
from __future__ import annotations

import re
import unicodedata

_NON_WORD_CHAR_RE = re.compile(r"[\W_]")
_SENTENCE_END_CHARS = frozenset("。！？.!?")
_CLAUSE_END_CHARS = frozenset("，、；;,")

# Abbreviations whose trailing '.' must not act as a sentence-end split point.
_ABBREV_WORDS = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
    "no", "inc", "ltd", "corp", "co", "st", "fig", "vol", "vs", "etc", "approx",
    "e.g", "i.e", "a.m", "p.m", "u.s", "u.s.a", "ph.d",
})

# Prefix/title abbreviations that should stay attached to the following token when possible.
_PREFIX_ABBREV_WORDS = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "no", "e.g", "i.e", "vs", "fig", "vol", "st",
})


def spoken_normalize(text: str) -> tuple[str, list[int]]:
    """NFKC-normalize and lowercase text, stripping punctuation/whitespace.

    Returns (normalized_text, orig_indices) where orig_indices[i] is the index
    in the original string corresponding to normalized_text[i].
    """
    src = text or ""
    norm_chars: list[str] = []
    orig_indices: list[int] = []
    n = len(src)
    i = 0
    while i < n:
        j = i + 1
        while j < n and unicodedata.category(src[j]).startswith("M"):
            j += 1
        cluster = unicodedata.normalize("NFKC", src[i:j]).lower()
        for ch in cluster:
            if not _NON_WORD_CHAR_RE.fullmatch(ch):
                norm_chars.append(ch)
                orig_indices.append(i)
        i = j
    return "".join(norm_chars), orig_indices


def contextual_span(
    haystack: str,
    needle: str,
    hint_idx: int | None = None,
) -> tuple[int, int] | None:
    """Locate needle in haystack ignoring punctuation, whitespace, case, and NFKC width.

    Returns exact (orig_start, orig_end) slice indices in haystack, or None if not found.
    When multiple matches exist, selects the one closest to hint_idx.
    """
    norm_hay, idx_map = spoken_normalize(haystack)
    norm_needle, _ = spoken_normalize(needle)
    if not norm_hay or not norm_needle:
        return None

    spans: list[tuple[int, int]] = []
    n_hay = len(haystack)
    needle_len = len(norm_needle)
    pos = 0
    while True:
        hit = norm_hay.find(norm_needle, pos)
        if hit < 0:
            break
        orig_start = idx_map[hit]
        orig_end = idx_map[hit + needle_len - 1] + 1
        while orig_end < n_hay and unicodedata.category(haystack[orig_end]).startswith("M"):
            orig_end += 1
        spans.append((orig_start, orig_end))
        pos = hit + 1

    if not spans:
        return None
    if hint_idx is None:
        return spans[0]

    def _dist(span: tuple[int, int]) -> tuple[int, int, int]:
        s, e = span
        if s <= hint_idx <= e:
            d = 0
        else:
            d = min(abs(s - hint_idx), abs(e - hint_idx))
        return (d, abs(s - hint_idx), s)

    return min(spans, key=_dist)


def _is_latin_word_char(ch: str) -> bool:
    return ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9") or ch == "_"


def _is_token_char(ch: str) -> bool:
    return _is_latin_word_char(ch) or ch == "."


def _token_before_dot(text: str, dot_idx: int) -> str:
    i = dot_idx - 1
    while i >= 0 and _is_token_char(text[i]):
        i -= 1
    return text[i + 1 : dot_idx]


def _is_safe_sentence_end(text: str, punct_idx: int) -> bool:
    ch = text[punct_idx]
    if ch != ".":
        return True
    prev_ch = text[punct_idx - 1] if punct_idx > 0 else ""
    next_ch = text[punct_idx + 1] if punct_idx + 1 < len(text) else ""
    # Decimal / version numbers like 3.14 or v1.2, or dotted internals like e.g. / foo.bar
    if prev_ch.isdigit() and next_ch.isdigit():
        return False
    if next_ch and (_is_latin_word_char(next_ch) or next_ch == "."):
        return False
    tok = _token_before_dot(text, punct_idx).lower()
    if not tok:
        return False
    if tok in _ABBREV_WORDS:
        return False
    # Acronyms / single-letter initials such as U.S.A. or A.
    if "." in tok or len(tok) == 1:
        return False
    return True


def _is_after_prefix_abbrev(text: str, space_idx: int) -> bool:
    if space_idx <= 0 or text[space_idx - 1] != ".":
        return False
    tok = _token_before_dot(text, space_idx - 1).lower()
    return tok in _PREFIX_ABBREV_WORDS or ("." in tok and all(len(part) == 1 for part in tok.split(".") if part))


def _find_split_point(text: str, pos: int, limit: int) -> int:
    # 1. Sentence boundaries
    for idx in range(limit - 1, pos, -1):
        if text[idx] in _SENTENCE_END_CHARS and _is_safe_sentence_end(text, idx):
            end = idx + 1
            if text[pos:end].strip():
                return end

    # 2. Clause boundaries
    for idx in range(limit - 1, pos, -1):
        if text[idx] in _CLAUSE_END_CHARS:
            # Do not split decimal commas like 1,000
            prev_ch = text[idx - 1] if idx > 0 else ""
            next_ch = text[idx + 1] if idx + 1 < len(text) else ""
            if text[idx] == "," and prev_ch.isdigit() and next_ch.isdigit():
                continue
            end = idx + 1
            if text[pos:end].strip():
                return end

    # 3. Whitespace boundaries (avoid splitting right after prefix abbreviations if an earlier space exists)
    fallback_ws: int | None = None
    for idx in range(limit, pos, -1):
        if idx < len(text) and text[idx].isspace():
            if text[pos:idx].strip():
                if not _is_after_prefix_abbrev(text, idx):
                    return idx
                if fallback_ws is None:
                    fallback_ws = idx
    if fallback_ws is not None:
        return fallback_ws

    # 4. Safe fallback without breaking Latin words, decimals, acronyms, or abbreviations
    if limit < len(text) and _is_token_char(text[limit - 1]) and _is_token_char(text[limit]):
        k = limit - 1
        while k > pos and _is_token_char(text[k - 1]):
            k -= 1
        if k > pos and text[pos:k].strip():
            return k

    return limit


def split_text_safe(text: str, max_chars: int) -> list[str]:
    """Split text into chunks of at most max_chars without breaking tokens or abbreviations."""
    if max_chars <= 0:
        raise ValueError(f"max_chars must be positive, got {max_chars!r}")
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    n = len(text)
    pos = 0
    while pos < n:
        while pos < n and text[pos].isspace():
            pos += 1
        if pos >= n:
            break
        if n - pos <= max_chars:
            tail = text[pos:].rstrip()
            if tail:
                chunks.append(tail)
            break
        limit = pos + max_chars
        split_at = _find_split_point(text, pos, limit)
        if split_at <= pos:
            split_at = limit
        piece = text[pos:split_at].strip()
        if piece:
            chunks.append(piece)
        pos = split_at
    return chunks
