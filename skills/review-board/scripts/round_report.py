#!/usr/bin/env python3
"""Summarize a review board's state for Claude, from an export of its database.

Usage:
    python3 round_report.py board.json EXPORT_DIR [--since ISO]

EXPORT_DIR is the out_dir given to ArtifactData list calls for the
collections responses, decisions and messages. Each document is a JSON file
shaped {"id": ..., "data": {...}, "version": ...} under EXPORT_DIR/<collection>/.

Applies the same state rules as the page (see states() and
references/data-model.md). Prints what needs Claude now, with the owner's
answer and new messages in full, the `seen` value to stamp on each decision
or follow-up, and the version of any existing decision (for if_version);
then compact lists of the other states.
"""
import json
import sys
from pathlib import Path

GENERAL = "_general"
PROBE = "_probe"
FIXED = {"accept": "Accept recommendation", "change": "Something else",
         "discuss": "I have a question", "later": "Decide later"}


def load(export, coll):
    """Return [(doc_id, body, version)] for one exported collection."""
    d = Path(export) / coll
    out = []
    if d.is_dir():
        for f in sorted(d.glob("*.json")):
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                print(f"warning: {f} is not valid JSON; skipped", file=sys.stderr)
                continue
            body = doc.get("data", doc) if isinstance(doc, dict) else {}
            if isinstance(body, dict):
                out.append((str(doc.get("id", f.stem)), body, doc.get("version")))
    return out


def _at(x):
    return str(x.get("at") or "") if isinstance(x, dict) else ""


def _seen(x):
    return str(x.get("seen") or x.get("at") or "") if isinstance(x, dict) else ""


class Board:
    """The board's state, computed with the same rules as the page."""

    def __init__(self, responses, decisions, messages):
        self.responses = responses            # id -> body
        self.decisions = decisions            # id -> body
        self.messages = [m for m in messages if isinstance(m, dict) and isinstance(m.get("item"), str)]

    def msgs(self, iid):
        return sorted((m for m in self.messages if m["item"] == iid), key=_at)

    def last_owner(self, iid):
        # A cleared answer is not activity: the item simply goes back to Your turn.
        t = _at(self.responses.get(iid)) if self.has_answer(iid) else ""
        for m in self.msgs(iid):
            if m.get("by") == "owner" and _at(m) > t:
                t = _at(m)
        return t

    def last_owner_msg(self, iid):
        t = ""
        for m in self.msgs(iid):
            if m.get("by") == "owner" and _at(m) > t:
                t = _at(m)
        return t

    def last_claude(self, iid):
        t = _at(self.decisions.get(iid))
        for m in self.msgs(iid):
            if m.get("by") == "claude" and _at(m) > t:
                t = _at(m)
        return t

    def pending_ask(self, iid):
        ask = None
        for m in self.msgs(iid):
            if m.get("by") == "claude" and m.get("asks"):
                ask = m
        o = self.last_owner(iid)
        return ask if ask and not (o and o > _seen(ask)) else None

    def has_answer(self, iid):
        a = (self.responses.get(iid) or {}).get("answer")
        return bool(a) if isinstance(a, list) else a not in (None, "")

    def state(self, iid):
        if self.pending_ask(iid):
            return "your_turn"
        d, o = self.decisions.get(iid), self.last_owner(iid)
        if d and not (o and o > _seen(d)):
            return "parked" if d.get("parked") else "decided"
        if self.has_answer(iid):
            r = self.responses[iid]
            if r.get("answer") == "later" and not (self.last_owner_msg(iid) > _at(r)):
                return "parked"
            return "with_claude"
        return "with_claude" if o else "your_turn"

    def needs_claude(self, iid):
        """With Claude, or a fresh 'Decide later' that Claude hasn't recorded as parked yet."""
        st = self.state(iid)
        if st == "with_claude":
            return True
        r, d = self.responses.get(iid) or {}, self.decisions.get(iid)
        return st == "parked" and r.get("answer") == "later" and not (d and _seen(d) >= _at(r))


def states(board, responses, decisions, messages):
    """{item id: state} for every item. Used by the parity tests."""
    b = Board(responses, decisions, messages)
    return {it["id"]: b.state(it["id"]) for it in board["items"]}


def main(argv):
    since = ""
    if "--since" in argv:
        i = argv.index("--since")
        if i + 1 >= len(argv):
            sys.exit("--since needs an ISO time, for example --since 2026-01-31T09:00:00.000Z")
        since = argv[i + 1]
        del argv[i:i + 2]
    if len(argv) != 2:
        print(__doc__)
        sys.exit(2)
    board = json.loads(Path(argv[0]).read_text(encoding="utf-8"))
    items = board["items"]
    by_id = {i["id"]: i for i in items}
    resp_docs, dec_docs, msg_docs = (load(argv[1], c) for c in ("responses", "decisions", "messages"))
    responses = {k: v for k, v, _ in resp_docs}
    decisions = {k: v for k, v, _ in dec_docs}
    dec_version = {k: ver for k, _, ver in dec_docs}
    b = Board(responses, decisions, [v for _, v, _ in msg_docs])

    def label(it, a):
        opts = {o["key"]: o["label"] for o in it.get("options") or []}
        rec = next((o["key"] for o in it.get("options") or [] if o.get("recommended")), "accept")
        one = lambda k: (opts.get(k) or FIXED.get(k) or str(k)) + (" [recommended]" if k == rec else "")
        return ", ".join(one(k) for k in a) if isinstance(a, list) else one(a)

    groups = {s: [] for s in ("with_claude", "your_turn", "decided", "parked")}
    for it in items:
        groups[b.state(it["id"])].append(it)
    needs = [it for it in items if b.needs_claude(it["id"])]

    print(f"# {board['title']}: round report")
    print(f"{len(items)} items. Needs Claude: {len(needs)}. Your turn: {len(groups['your_turn'])}. "
          f"Decided: {len(groups['decided'])}. Parked: {len(groups['parked'])}.")
    print("Stamp every decision and follow-up below with its `seen` value. "
          "Write in batches of at most 50; pass if_version when a decision already exists.")

    print("\n## Needs Claude now")
    if not needs:
        print("Nothing.")
    for it in needs:
        iid = it["id"]
        cutoff = max(b.last_claude(iid), since)
        r = responses.get(iid) or {}
        print(f"\n### {iid}: {it['title']} [{it['severity']}]")
        print(f"- seen: {b.last_owner(iid)}")
        if b.has_answer(iid):
            print(f"- Answer: {label(it, r.get('answer'))}")
            if r.get("answer") == "later":
                print("- Note: 'Decide later'. Record decisions/<id> with parked: true unless a comment asks for more.")
            elif r.get("answer") in ("change", "discuss") and not any(
                    m.get("by") == "owner" and _at(m) >= _at(r) for m in b.msgs(iid)):
                print("- Note: no comment yet. Ask what they have in mind (asks: true); don't guess.")
            else:
                rec = next((o for o in it.get("options") or [] if o.get("recommended")), None)
                ans = r.get("answer")
                if rec and not isinstance(ans, list) and ans in {o["key"] for o in it["options"]} and ans != rec["key"]:
                    print(f"- Note: differs from the recommendation ({rec['label']}).")
        for m in b.msgs(iid):
            if m.get("by") == "owner" and _at(m) > cutoff:
                print(f"- Owner ({_at(m)}): {m.get('text', '')}")
        if iid in decisions:
            print(f"- Previous decision (version {dec_version.get(iid)}): {decisions[iid].get('text')}")

    gen = [m for m in b.msgs(GENERAL) if m.get("by") == "owner" and _at(m) > max(b.last_claude(GENERAL), since)]
    if gen:
        print(f"\n## General notes (seen: {b.last_owner(GENERAL)})")
        for m in gen:
            print(f"- Owner ({_at(m)}): {m.get('text', '')}")

    print("\n## Your turn (waiting on the owner)")
    asks = [it["id"] for it in groups["your_turn"] if b.pending_ask(it["id"])]
    fresh = [it["id"] for it in groups["your_turn"] if not b.pending_ask(it["id"])]
    if asks:
        print("Follow-ups asked: " + ", ".join(asks))
    if fresh:
        print("Unanswered: " + ", ".join(fresh))
    if not groups["your_turn"]:
        print("Nothing.")
    print("\n## Decided\n" + (", ".join(it["id"] for it in groups["decided"]) or "None."))
    print("\n## Parked\n" + (", ".join(it["id"] for it in groups["parked"]) or "None."))

    known = set(by_id) | {GENERAL, PROBE}
    for name, ids in (("responses", responses), ("decisions", decisions),
                      ("messages", {m["item"] for m in b.messages})):
        unknown = sorted(set(ids) - known)
        if unknown:
            print(f"\nNote: {name} for item ids not on the board: {', '.join(unknown)}")
    skipped = len(msg_docs) - len(b.messages)
    if skipped:
        print(f"\nNote: {skipped} message document(s) without an item id were ignored.")


if __name__ == "__main__":
    main(sys.argv[1:])
