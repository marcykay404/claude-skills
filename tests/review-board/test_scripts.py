#!/usr/bin/env python3
"""Tests for review-board's scripts. Run: python3 tests/review-board/test_scripts.py"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent.parent / "skills" / "review-board"
sys.path.insert(0, str(SKILL / "scripts"))
import build_board  # noqa: E402
import round_report  # noqa: E402

CASES = json.loads((HERE / "state-cases.json").read_text())["cases"]
T = lambda m: f"2026-01-01T08:{m:02d}:00.000Z"


def case_data(c):
    """Turn a compact state case into (responses, decisions, messages) for item X1."""
    resp = {"X1": {**c["responses"], "at": T(c["responses"]["at"])}} if "responses" in c else {}
    dec = {}
    if "decisions" in c:
        d = dict(c["decisions"], text="Decision")
        d["at"] = T(d["at"])
        if "seen" in d:
            d["seen"] = T(d["seen"])
        dec["X1"] = d
    msgs = []
    for m in c.get("messages", []):
        m = dict(m, item="X1", text="note", at=T(m["at"]))
        if "seen" in m:
            m["seen"] = T(m["seen"])
        msgs.append(m)
    return resp, dec, msgs


BOARD = {"title": "Test", "groups": [{"key": "X", "title": "Group"}],
         "items": [{"id": "X1", "group": "X", "severity": "important", "title": "Question", "rec": "Do this",
                    "options": [{"key": "a", "label": "A", "recommended": True}, {"key": "b", "label": "B"}]}]}


class StateParity(unittest.TestCase):
    def test_every_case(self):
        for c in CASES:
            with self.subTest(c["name"]):
                resp, dec, msgs = case_data(c)
                self.assertEqual(round_report.states(BOARD, resp, dec, msgs)["X1"], c["expect"])


class BuildBoard(unittest.TestCase):
    def check(self, board):
        return build_board.validate(json.loads(json.dumps(board)))

    def test_example_is_valid(self):
        errors, warnings = self.check(json.loads((SKILL / "assets/example-board.json").read_text()))
        self.assertEqual((errors, warnings), ([], []))

    def test_wrong_types_give_errors_not_crashes(self):
        bad = [
            [],
            {"title": "T", "groups": "A", "items": "x"},
            {"title": "T", "groups": [{"key": "A", "title": "G"}], "items": [{"id": 7, "group": "A", "severity": "detail", "title": "Q", "rec": "R"}]},
            {"title": "T", "groups": [{"key": "A", "title": "G"}], "items": [{"id": "A1", "group": "A", "severity": "detail", "title": "Q", "rec": "R", "options": ["x", "y"]}]},
            {"title": "T", "groups": [{"key": "A", "title": "G"}], "items": ["not an item"]},
        ]
        for b in bad:
            with self.subTest(b=str(b)[:60]):
                errors, _ = self.check(b)
                self.assertTrue(errors)

    def test_unknown_keys_warn_with_a_hint(self):
        b = json.loads(json.dumps(BOARD)); b["items"][0]["isnew"] = True
        errors, warnings = self.check(b)
        self.assertEqual(errors, [])
        self.assertTrue(any("isNew" in w for w in warnings))

    def test_recommended_rules(self):
        b = json.loads(json.dumps(BOARD)); b["items"][0]["options"][1]["recommended"] = True
        self.assertTrue(self.check(b)[0])
        b["items"][0]["multi"] = True
        self.assertEqual(self.check(b)[0], [])

    def test_reserved_option_key(self):
        b = json.loads(json.dumps(BOARD)); b["items"][0]["options"][1]["key"] = "later"
        self.assertTrue(any("reserved" in e for e in self.check(b)[0]))

    def test_changed_needs_changed_at_and_is_normalized(self):
        b = json.loads(json.dumps(BOARD)); b["items"][0]["changed"] = "Rewritten"
        self.assertTrue(self.check(b)[0])
        b["items"][0]["changedAt"] = "2026-01-01T08:00:00Z"
        errors, _ = build_board.validate(b)
        self.assertEqual(errors, [])
        self.assertEqual(b["items"][0]["changedAt"], "2026-01-01T08:00:00.000Z")

    def test_empty_group_warns(self):
        b = json.loads(json.dumps(BOARD)); b["groups"].append({"key": "Y", "title": "Empty"})
        self.assertTrue(any("no items" in w for w in self.check(b)[1]))

    def test_script_escapes_closing_tags(self):
        b = json.loads(json.dumps(BOARD)); b["items"][0]["title"] = "</script><img src=x onerror=alert(1)>"
        out = build_board.build(b)
        self.assertNotIn("</script><img", out)


class RoundReport(unittest.TestCase):
    def run_report(self, files, *extra):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "board.json").write_text(json.dumps(BOARD))
            for rel, body in files.items():
                p = d / "export" / rel; p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(body))
            return subprocess.run([sys.executable, str(SKILL / "scripts/round_report.py"), str(d / "board.json"), str(d / "export"), *extra],
                                  capture_output=True, text=True)

    def test_tolerates_bad_documents(self):
        r = self.run_report({
            "messages/m1.json": {"id": "m1", "data": {"by": "owner", "text": "no item", "at": T(1)}},
            "messages/probe.json": {"id": "probe", "data": {"item": "_probe", "by": "claude", "text": "probe", "at": T(1)}},
            "responses/Z9.json": {"id": "Z9", "data": {"answer": "a", "at": T(1)}},
        })
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("without an item id were ignored", r.stdout)
        self.assertIn("responses for item ids not on the board: Z9", r.stdout)
        self.assertNotIn("_probe", r.stdout)

    def test_since_without_value(self):
        r = self.run_report({}, "--since")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("needs an ISO time", r.stdout + r.stderr)

    def test_decide_later_reaches_claude_with_seen(self):
        r = self.run_report({"responses/X1.json": {"id": "X1", "data": {"answer": "later", "at": T(1)}}})
        needs = r.stdout.split("## Needs Claude now")[1].split("## Your turn")[0]
        self.assertIn("X1", needs)
        self.assertIn(f"seen: {T(1)}", needs)
        self.assertIn("parked: true", needs)

    def test_recorded_later_is_quiet(self):
        r = self.run_report({"responses/X1.json": {"id": "X1", "data": {"answer": "later", "at": T(1)}},
                             "decisions/X1.json": {"id": "X1", "data": {"text": "Parked", "at": T(5), "seen": T(1), "parked": True}, "version": 3}})
        self.assertIn("Nothing.", r.stdout.split("## Needs Claude now")[1].split("##")[0])

    def test_existing_decision_version_is_printed(self):
        r = self.run_report({"responses/X1.json": {"id": "X1", "data": {"answer": "b", "at": T(6)}},
                             "decisions/X1.json": {"id": "X1", "data": {"text": "A", "at": T(5), "seen": T(1)}, "version": 4}})
        self.assertIn("version 4", r.stdout)
        self.assertIn("differs from the recommendation", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
