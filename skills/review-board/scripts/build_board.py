#!/usr/bin/env python3
"""Build a publishable review board page from a board.json file.

Usage:
    python3 build_board.py board.json out.html

Validates the board, then fills the template in ../assets/board-template.html.
The output is an HTML fragment ready for the Artifact tool. Rebuild and
republish to the same artifact to update a published board.
"""
import html
import json
import re
import sys
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "board-template.html"
SEVERITIES = {"blocker", "important", "detail"}
RESERVED_KEYS = {"accept", "change", "discuss", "later"}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$")
ISO_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$")
BOARD_KEYS = {"title", "subtitle", "round", "how", "key", "groups", "items"}
GROUP_KEYS = {"key", "title", "blurb"}
ITEM_KEYS = {"id", "group", "severity", "title", "issue", "rec", "options", "multi", "ref",
             "isNew", "changed", "changedAt"}
OPTION_KEYS = {"key", "label", "recommended"}


def normalize_iso(value):
    """Return the time as YYYY-MM-DDTHH:MM:SS.mmmZ, so string comparisons order correctly."""
    m = ISO_RE.match(str(value))
    if not m:
        return None
    frac = (m.group(2) or ".000")[1:4].ljust(3, "0")
    return f"{m.group(1)}.{frac}Z"


def is_text(v):
    return isinstance(v, str) and v.strip() != ""


def validate(board):
    """Return (errors, warnings). Normalizes changedAt in place."""
    errors, warnings = [], []
    if not isinstance(board, dict):
        return ["the file must hold one JSON object"], []
    for k in sorted(set(board) - BOARD_KEYS):
        warnings.append(f"board: unknown key {k!r} is ignored")
    if not is_text(board.get("title")):
        errors.append("board.title is required")
    for k in ("subtitle", "round", "how", "key"):
        if k in board and not isinstance(board[k], str):
            errors.append(f"board.{k} must be text")
    groups, items = board.get("groups"), board.get("items")
    if not isinstance(groups, list) or not groups:
        errors.append("board.groups must be a list with at least one group")
        groups = []
    if not isinstance(items, list) or not items:
        errors.append("board.items must be a list with at least one item")
        items = []

    gkeys = set()
    for g in groups:
        if not isinstance(g, dict):
            errors.append(f"group {g!r}: must be an object"); continue
        k = g.get("key")
        if not isinstance(k, str) or not ID_RE.match(k):
            errors.append(f"group {k!r}: key must be short letters or digits")
        elif k in gkeys:
            errors.append(f"group {k}: duplicate key")
        else:
            gkeys.add(k)
        if not is_text(g.get("title")):
            errors.append(f"group {k}: title is required")
        for extra in sorted(set(g) - GROUP_KEYS):
            warnings.append(f"group {k}: unknown key {extra!r} is ignored")

    ids, used_groups = set(), set()
    for it in items:
        if not isinstance(it, dict):
            errors.append(f"item {it!r}: must be an object"); continue
        iid = it.get("id")
        where = f"item {iid if isinstance(iid, str) else repr(iid)}"
        if not isinstance(iid, str) or not ID_RE.match(iid):
            errors.append(f"{where}: id must be text made of letters and digits, not starting with _")
        elif iid in ids:
            errors.append(f"{where}: duplicate id (never reuse an id for a different question)")
        else:
            ids.add(iid)
        for extra in sorted(set(it) - ITEM_KEYS):
            hint = {"isnew": "isNew", "changed_at": "changedAt", "recommendation": "rec",
                    "description": "issue", "reference": "ref"}.get(extra.lower())
            warnings.append(f"{where}: unknown key {extra!r} is ignored" + (f" (did you mean {hint!r}?)" if hint else ""))
        if it.get("group") not in gkeys:
            errors.append(f"{where}: group {it.get('group')!r} is not in board.groups")
        else:
            used_groups.add(it["group"])
        if it.get("severity") not in SEVERITIES:
            errors.append(f"{where}: severity must be one of {sorted(SEVERITIES)}")
        for field in ("title", "rec"):
            if not is_text(it.get(field)):
                errors.append(f"{where}: {field} is required text")
        for field in ("issue", "ref", "changed"):
            if field in it and not isinstance(it[field], str):
                errors.append(f"{where}: {field} must be text")
        if "multi" in it and not isinstance(it["multi"], bool):
            errors.append(f"{where}: multi must be true or false")
        opts = it.get("options")
        if opts is not None:
            if not isinstance(opts, list) or len(opts) < 2 or not all(isinstance(o, dict) for o in opts):
                errors.append(f"{where}: options must be a list of at least 2 objects with key and label")
            else:
                keys = [o.get("key") for o in opts]
                if len(set(map(str, keys))) != len(keys):
                    errors.append(f"{where}: option keys must be unique")
                for o in opts:
                    if not isinstance(o.get("key"), str) or not is_text(o.get("label")):
                        errors.append(f"{where}: every option needs a text key and label")
                    elif o["key"] in RESERVED_KEYS:
                        errors.append(f"{where}: option key {o['key']!r} is reserved for the built-in answers")
                    for extra in sorted(set(o) - OPTION_KEYS):
                        warnings.append(f"{where}: option {o.get('key')!r}: unknown key {extra!r} is ignored")
                recs = sum(1 for o in opts if o.get("recommended"))
                if recs > 1 and not it.get("multi"):
                    errors.append(f"{where}: only one option can be recommended (several are allowed only with multi: true)")
        elif it.get("multi"):
            errors.append(f"{where}: multi needs options")
        ca = it.get("changedAt")
        if ca is not None:
            norm = normalize_iso(ca)
            if not norm:
                errors.append(f"{where}: changedAt must be UTC ISO, e.g. 2026-01-31T09:00:00.000Z")
            else:
                it["changedAt"] = norm
        if (it.get("changed") or it.get("isNew")) and not ca:
            errors.append(f"{where}: set changedAt when marking an item changed or new, so the page knows whether the owner has seen it")
    for k in sorted(gkeys - used_groups):
        warnings.append(f"group {k}: has no items, so it won't appear")
    return errors, warnings


def build(board):
    tpl = TEMPLATE.read_text(encoding="utf-8")
    data = json.dumps(board, ensure_ascii=False, separators=(",", ":"))
    data = data.replace("</", "<\\/").replace("<!--", "<\\!--")
    out = tpl.replace("__BOARD_TITLE__", html.escape(board["title"]), 1)
    return out.replace("__BOARD_DATA__", data, 1)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    try:
        board = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"{src} is not valid JSON: {e}")
    errors, warnings = validate(board)
    for w in warnings:
        print("warning:", w)
    if errors:
        print("Board has problems:")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    dst.write_text(build(board), encoding="utf-8")
    items = board["items"]
    blockers = sum(1 for i in items if i["severity"] == "blocker")
    print(f"Built {dst} — {len(items)} items in {len(board['groups'])} groups, {blockers} blockers.")


if __name__ == "__main__":
    main()
