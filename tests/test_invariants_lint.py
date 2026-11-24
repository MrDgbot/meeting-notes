"""Prove each structural lint rule (INV001-INV009) catches the exact historical bug it guards."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import check_invariants as inv  # noqa: E402


def test_repo_passes_all_structural_invariants():
    violations = inv.scan_repo(ROOT)
    assert violations == [], "\n".join(v.format() for v in violations)


def test_every_rule_catches_its_historical_regression():
    # INV001: direct status write bypassing meeting_state.transition()
    v1 = inv.check_python_source("app.py", 'store.update(mid, status="queued")\n')
    assert any(v.rule == "INV001" and "transition" in v.message for v in v1)

    # INV002: module-level store.DATA snapshot breaking MEETING_DATA isolation
    v2 = inv.check_python_source("rsi_events.py", 'RSI_DIR = store.DATA / "rsi"\n')
    assert any(v.rule == "INV002" and "helper function" in v.message for v in v2)

    # INV003: single-segment {name} route returning 404 for "产品/张三" (fixed in 84cb9b6)
    v3 = inv.check_python_source("app.py", '@app.delete("/api/rsi/voiceprints/{name}")\ndef f(name: str): pass\n')
    assert any(v.rule == "INV003" and "{name:path}" in v.message for v in v3)

    # INV004: scattered cache clear forgetting sibling caches (fixed in 84cb9b6)
    v4 = inv.check_python_source("app.py", 'def mutate():\n    _suspect_cache.clear()\n')
    assert any(v.rule == "INV004" and "invalidate_derived_caches" in v.message for v in v4)

    # INV005: print-only check() causing pytest false green (fixed in 0300edf)
    v5 = inv.check_python_source("tests/test_sample.py", 'def check(cond, msg):\n    print(cond, msg)\n')
    assert any(v.rule == "INV005" and "AssertionError" in v.message for v in v5)

    # INV006: SVG <text> in ICONS clipped by Chrome 12px min font-size (fixed in 98d59a8)
    v6 = inv.check_js_source("static/js/utils.js", 'export const ICONS = {\n  back: "<text x=12>15</text>",\n};\n')
    assert any(v.rule == "INV006" and "<path>" in v.message for v in v6)

    # INV007: select padding shorthand overlapping dropdown chevron (fixed in 98d59a8)
    v7 = inv.check_css_source("static/style.css", ".psil { height: 28px; padding: 0 6px; }\n")
    assert any(v.rule == "INV007" and "padding-right >= 24px" in v.message for v7 in [v7] for v in v7)

    # INV008: direct #modal.hidden guard missing #cmdk palette (fixed in f354628)
    v8 = inv.check_js_source("static/js/player.js", 'if (!$("#modal").hidden) return;\n')
    assert any(v.rule == "INV008" and "isOverlayOpen" in v.message for v in v8)

    # INV009: reintroducing parallel live_active dict (eliminated in Step 1)
    v9 = inv.check_python_source("app.py", "live_active: dict[str, bool] = {}\n")
    assert any(v.rule == "INV009" and "is_live_active" in v.message for v in v9)

    # INV010: reaching into private store._lock outside store.py (eliminated in Step 4)
    v10 = inv.check_python_source("meeting_state.py", "with store._lock:\n    pass\n")
    assert any(v.rule == "INV010" and "store.locked()" in v.message for v in v10)
