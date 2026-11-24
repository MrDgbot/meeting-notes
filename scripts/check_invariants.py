#!/usr/bin/env python3
"""Structural invariant linter encoding recurring mistakes from git history.

Each failure names the violated rule ID, file:line, and the exact fix.
Run directly: uv run --no-sync python scripts/check_invariants.py
"""
from __future__ import annotations

import ast
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DYNAMIC_DATA_MODULES = frozenset({
    "rsi_events.py",
    "rsi_vocab.py",
    "rsi_ambient.py",
    "voiceprints.py",
    "relations.py",
    "mcp_server.py",
    "insights.py",
})


@dataclass(frozen=True)
class Violation:
    rule: str
    path: str
    line: int
    message: str

    def format(self) -> str:
        return f"{self.path}:{self.line}: {self.rule} {self.message}"


def _is_attr(node: ast.AST, base: str, attr: str) -> bool:
    return (
        isinstance(node, ast.Attribute)
        and node.attr == attr
        and isinstance(node.value, ast.Name)
        and node.value.id == base
    )


def check_python_source(rel_path: str, src: str) -> list[Violation]:
    out: list[Violation] = []
    try:
        tree = ast.parse(src, filename=rel_path)
    except SyntaxError as e:
        return [Violation("INV000", rel_path, e.lineno or 1, f"Syntax error: {e.msg}")]

    fname = Path(rel_path).name
    is_test = rel_path.startswith("tests/")

    # INV001: No direct status writes outside meeting_state.py and store.py
    if not is_test and fname not in ("meeting_state.py", "store.py"):
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and _is_attr(node.func, "store", "update"):
                for kw in node.keywords:
                    if kw.arg == "status":
                        out.append(Violation(
                            "INV001", rel_path, node.lineno,
                            "Direct store.update(..., status=...) bypasses the meeting state machine. "
                            "Fix: call meeting_state.transition(mid, ms.<STATE>, reason=...).",
                        ))
            if isinstance(node, ast.Assign):
                for tgt in node.targets:
                    if (
                        isinstance(tgt, ast.Subscript)
                        and isinstance(tgt.value, ast.Name)
                        and tgt.value.id in ("meta", "m")
                        and isinstance(tgt.slice, ast.Constant)
                        and tgt.slice.value == "status"
                    ):
                        out.append(Violation(
                            "INV001", rel_path, node.lineno,
                            'Direct meta["status"] assignment bypasses meeting_state. '
                            "Fix: call meeting_state.transition(mid, ms.<STATE>, reason=...).",
                        ))

    # INV002: Dynamic store.DATA / store.MEETINGS resolution in RSI, relations, and MCP modules
    if not is_test and fname in DYNAMIC_DATA_MODULES:
        for stmt in tree.body:
            if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                val = stmt.value
                if val is not None:
                    for sub in ast.walk(val):
                        if _is_attr(sub, "store", "DATA") or _is_attr(sub, "store", "MEETINGS"):
                            out.append(Violation(
                                "INV002", rel_path, stmt.lineno,
                                "Module-level store.DATA/MEETINGS snapshot breaks MEETING_DATA test isolation. "
                                "Fix: compute paths inside a helper function at call time.",
                            ))
                            break

    # INV003 & INV004 & INV009: app.py route, cache invalidation, and single-source LIVE checks
    if not is_test and fname == "app.py":
        for stmt in tree.body:
            # INV009: forbid reintroducing parallel live_active dict
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.target.id == "live_active":
                out.append(Violation(
                    "INV009", rel_path, stmt.lineno,
                    "Parallel live_active dict drifts from LIVE. Fix: derive status via is_live_active(mid).",
                ))
            elif isinstance(stmt, ast.Assign):
                for tgt in stmt.targets:
                    if isinstance(tgt, ast.Name) and tgt.id == "live_active":
                        out.append(Violation(
                            "INV009", rel_path, stmt.lineno,
                            "Parallel live_active dict drifts from LIVE. Fix: derive status via is_live_active(mid).",
                        ))

            # INV003: FastAPI routes with {name} on speaker/person endpoints must use {name:path}
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for dec in stmt.decorator_list:
                    if (
                        isinstance(dec, ast.Call)
                        and isinstance(dec.func, ast.Attribute)
                        and dec.func.attr in ("get", "post", "put", "patch", "delete")
                        and dec.args
                        and isinstance(dec.args[0], ast.Constant)
                        and isinstance(dec.args[0].value, str)
                    ):
                        route = dec.args[0].value
                        if ("voiceprints" in route or "/people/" in route) and "{name}" in route:
                            out.append(Violation(
                                "INV003", rel_path, dec.lineno,
                                f"Route {route!r} rejects speaker/person names containing '/'. "
                                "Fix: use {name:path} instead of {name}.",
                            ))

                # INV004: No direct _search_cache/_suspect_cache clear/pop outside invalidate_derived_caches
                if stmt.name not in ("invalidate_derived_caches", "_suspects", "search"):
                    for sub in ast.walk(stmt):
                        if (
                            isinstance(sub, ast.Call)
                            and isinstance(sub.func, ast.Attribute)
                            and sub.func.attr in ("clear", "pop")
                            and isinstance(sub.func.value, ast.Name)
                            and sub.func.value.id in ("_search_cache", "_suspect_cache")
                        ):
                            out.append(Violation(
                                "INV004", rel_path, sub.lineno,
                                f"Direct {sub.func.value.id}.{sub.func.attr}() skips sibling derived caches. "
                                "Fix: call invalidate_derived_caches(mid, vocab_changed=...).",
                            ))

    # INV010: No direct store._lock access outside store.py
    if fname != "store.py":
        for node in ast.walk(tree):
            if _is_attr(node, "store", "_lock"):
                out.append(Violation(
                    "INV010", rel_path, node.lineno,
                    "Direct store._lock access couples callers to store internals. "
                    "Fix: use `with store.locked():`.",
                ))

    # INV005: No silent print-only def check() helper in tests/
    if is_test and fname.startswith("test_"):
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "check":
                has_enforcement = any(isinstance(sub, (ast.Assert, ast.Raise)) for sub in ast.walk(node))
                if not has_enforcement:
                    out.append(Violation(
                        "INV005", rel_path, node.lineno,
                        "Silent def check() without assert/raise causes pytest false greens. "
                        "Fix: raise AssertionError on failure or use plain pytest assert.",
                    ))

    return out


_CSS_RULE_RE = re.compile(r"([^{}@]+)\{([^{}]+)\}")
_PAD_SHORTHAND_RE = re.compile(r"(?:^|;)\s*padding\s*:\s*([^;!}]+)")
_PAD_RIGHT_RE = re.compile(r"(?:^|;)\s*padding-right\s*:\s*([^;!}]+)")


def _px_val(tok: str) -> float | None:
    tok = tok.strip()
    if tok == "0":
        return 0.0
    m = re.match(r"^(\d+(?:\.\d+)?)px$", tok)
    return float(m.group(1)) if m else None


def check_css_source(rel_path: str, src: str) -> list[Violation]:
    out: list[Violation] = []
    # Strip CSS comments while preserving line count
    cleaned = re.sub(r"/\*[\s\S]*?\*/", lambda m: "\n" * m.group(0).count("\n"), src)
    for m in _CSS_RULE_RE.finditer(cleaned):
        selector = m.group(1).strip()
        body = m.group(2)
        if not re.search(r"(?:^|[\s,>])(?:select\b|select\.|\.psil\b|\.home-sel\b)", selector):
            continue
        pad_right: float | None = None
        for pm in _PAD_SHORTHAND_RE.finditer(body):
            parts = pm.group(1).split()
            if len(parts) == 1:
                pad_right = _px_val(parts[0])
            elif len(parts) in (2, 3, 4):
                pad_right = _px_val(parts[1])
        for prm in _PAD_RIGHT_RE.finditer(body):
            pad_right = _px_val(prm.group(1))
        if pad_right is not None and pad_right < 22.0:
            line = cleaned.count("\n", 0, m.start()) + 1
            out.append(Violation(
                "INV007", rel_path, line,
                f"Selector {selector!r} sets select padding-right to {pad_right:g}px (<22px), overlapping dropdown chevron. "
                "Fix: set padding-right >= 24px.",
            ))
    return out


def check_js_source(rel_path: str, src: str) -> list[Violation]:
    out: list[Violation] = []
    fname = Path(rel_path).name

    # INV006: No <text> elements inside SVG icon map in utils.js
    if fname == "utils.js":
        in_icons = False
        for i, ln in enumerate(src.splitlines(), 1):
            code = ln.split("//", 1)[0]
            if "export const ICONS = {" in code:
                in_icons = True
            elif in_icons and code.strip() == "};":
                in_icons = False
            elif in_icons and "<text" in code:
                out.append(Violation(
                    "INV006", rel_path, i,
                    "SVG <text> inside ICONS breaks under browser minimum font-size settings. "
                    "Fix: draw digits as vector <path> glyphs.",
                ))

    # INV008: No direct #modal .hidden checks outside ui.js / palette.js dialog lifecycle
    if rel_path.startswith("static/js/") and fname not in ("ui.js", "palette.js"):
        for i, ln in enumerate(src.splitlines(), 1):
            if re.search(r'#modal["\']\s*\).*\.hidden', ln):
                out.append(Violation(
                    "INV008", rel_path, i,
                    "Direct #modal.hidden check misses #cmdk and future dialogs. "
                    "Fix: import and call isOverlayOpen() from ./ui.js.",
                ))
    return out


def scan_repo(root: Path = ROOT) -> list[Violation]:
    violations: list[Violation] = []
    for p in sorted(root.glob("*.py")):
        violations.extend(check_python_source(p.name, p.read_text(encoding="utf-8")))
    for p in sorted((root / "tests").glob("test_*.py")):
        violations.extend(check_python_source(f"tests/{p.name}", p.read_text(encoding="utf-8")))
    for p in sorted((root / "static").glob("*.css")):
        violations.extend(check_css_source(f"static/{p.name}", p.read_text(encoding="utf-8")))
    for p in [root / "static" / "app.js", *sorted((root / "static" / "js").glob("*.js"))]:
        if p.exists():
            rel = str(p.relative_to(root))
            violations.extend(check_js_source(rel, p.read_text(encoding="utf-8")))
    return violations


def main() -> int:
    violations = scan_repo(ROOT)
    if violations:
        for v in violations:
            print(v.format(), file=sys.stderr)
        print(f"Found {len(violations)} invariant violation(s).", file=sys.stderr)
        return 1
    print("All structural invariants passed (INV001-INV010).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
