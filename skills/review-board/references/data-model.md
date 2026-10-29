# Review board data model

## Contents
1. `board.json`: what you write
2. Database collections: what the page and you store
3. Item states: how the page and `round_report.py` classify items
4. `ArtifactData` call examples

## 1. `board.json`

```json
{
  "title": "Checkout Spec Review",
  "subtitle": "Review of docs/checkout_spec.md, revision 1.",
  "round": "Round 2",
  "how": "optional replacement for the 'How this works' text",
  "groups": [ { "key": "A", "title": "Foundations", "blurb": "Decide these first." } ],
  "items": [ { "id": "A1", "group": "A", "severity": "blocker", "title": "…", "issue": "…", "rec": "…" } ]
}
```

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Becomes the page `<title>` and heading. |
| `key` | no | Identifies the board in the browser's storage ("Since your last visit", unsent drafts). Defaults to `title`. Set it if you might rename the board. |
| `subtitle` | no | One line of context, such as what is being reviewed. |
| `round` | no | Shown before the status line, for example "Round 2", once the owner has answered something. Update it each round. |
| `how` | no | Overrides the default "How this works" text. |
| `groups[].key` | yes | A short letter. It appears in item IDs and in the section navigation. |
| `groups[].title`, `blurb` | title required | |
| `items[].id` | yes | Unique, never reused. It must not start with `_`. |
| `items[].group` | yes | Must match a group key. |
| `items[].severity` | yes | `blocker`, `important` or `detail`. |
| `items[].title` | yes | The question, in a few words. |
| `items[].issue` | no | The problem, in one to three sentences. |
| `items[].rec` | yes | Your recommendation. It is the summary line until the item is answered. |
| `items[].options` | no | `[{ "key", "label", "recommended"? }]`, at least two, at most one `recommended` unless `multi`. The keys `accept`, `change`, `discuss` and `later` are reserved. |
| `items[].multi` | no | `true` lets the user pick several options. The answer is then an array of keys. |
| `items[].ref` | no | A pointer back to the source. |
| `items[].isNew` | no | Shows a "New" mark until the owner first acts on the item. Requires `changedAt`. |
| `items[].changed` | no | One line saying what changed and why. Shown only if the owner answered before `changedAt`. |
| `items[].changedAt` | with `changed`/`isNew` | UTC ISO time of the rewrite. `build_board.py` normalizes it to millisecond precision. |

`build_board.py` rejects missing or wrongly typed fields and warns about unknown keys, which are usually typos such as `isnew` or `changed_at`. Never remove an item once the board is published; withdraw it with a decision instead.

Answers available to the owner:
- **Items with options:** the options (recommended first), then "Something else…", "I have a question…" and "Decide later".
- **Items without options:** "Accept recommendation", "Something else…" (stored as `change`), "I have a question…" (stored as `discuss`) and "Decide later" (stored as `later`).
- Every choice saves as soon as it is clicked. Clicking the selected choice again, or "Clear answer", removes it, which is the same for every answer.
- After "Something else…" or "I have a question…", the comment box opens under the buttons and prompts for a comment. If the owner leaves no comment, `round_report.py` flags it, and you ask with `asks: true`.

## 2. Database collections
The artifact's database holds three collections. The page subscribes to each one once.

| Collection / doc | Written by | Body |
|---|---|---|
| `responses/<itemId>` | page (owner) | `{ "answer": "<optionKey or accept/change/discuss/later>" or [keys] or null, "at": ISO }` |
| `messages/<auto or chosen id>` | page (owner) and Claude | `{ "item": "<itemId or _general>", "by": "owner" or "claude", "text": "…", "at": ISO, "asks"?: true, "quick"?: [{ "label": "…", "answer"?: "<key>" }] }` |
| `decisions/<itemId>` | Claude | `{ "text": "one-sentence decision", "at": ISO, "seen": ISO, "parked"?: true }` |

- `_general` is the item ID for the "Anything else?" thread.
- `seen` is the owner's latest activity time that you had read when you wrote, which `round_report.py` prints per item. Put it on every decision and every `asks` message. The page compares the owner's activity against `seen`, never against your own `at`, so an answer changed while you were working is never hidden, and the clocks on different machines don't matter.
- `asks: true` turns a Claude message into a follow-up. The item returns to Your turn until the owner replies or answers.
- `quick` adds one-tap reply buttons. Tapping one posts the label as the owner's message. If the entry has `answer`, it also sets the owner's response to that key.
- Name Claude message documents `c-<itemId>-<YYYYMMDDHHMMSS>`, so they are unique and sort sensibly.
- Never write `responses/*` or messages with `by: "owner"`.

## 3. Item states (the page and `round_report.py` agree)
Definitions:
- **Owner activity** is the latest `at` among the owner's response and the owner's messages.
- **Pending ask** is the latest Claude message with `asks: true`, provided there's no owner activity after its `seen` (or its `at` if it has no `seen`).

The state is the first rule that matches:
1. There is a pending ask → **Your turn** (a follow-up).
2. There is a decision, and no owner activity after its `seen` → **Decided**, or **Parked** if `parked`.
3. The owner has an answer → **Parked** if the answer is `later` and they haven't commented since giving it, otherwise **With Claude**.
4. The owner has only messages → **With Claude**.
5. Otherwise → **Your turn**.

Consequences:
- When the owner comments on a decided or parked item, it goes back to With Claude. On the page, a settled item takes new input only after the owner presses Reopen.
- A fresh "Decide later" shows as Parked on the page, and `round_report.py` still lists it under Needs Claude, so you can record it as a parked decision.
- To make the owner look again, post an `asks` message. Don't delete their answer.

## 4. `ArtifactData` examples

Export one collection for a round (repeat for `decisions` and `messages`):
```
ArtifactData action=list url=<board url> collection=responses query={"limit":1000} out_dir=<scratchpad>/export-r2
```

Record decisions and replies in batches of at most 50 writes (and at most 1 MiB). Documents that already exist need `if_version`, which the export files carry as `version`:
```
ArtifactData action=batch url=<board url> writes=[
  {"op":"set","collection":"decisions","doc_id":"A1","data":{"text":"Guest checkout; offer an account after payment.","at":"2026-10-28T09:00:00.000Z","seen":"2026-10-28T08:01:00.000Z"}},
  {"op":"set","collection":"messages","doc_id":"c-A1-20261028090000","data":{"item":"A1","by":"claude","text":"Recorded. B2 now covers local payment methods.","at":"2026-10-28T09:00:00.000Z"}},
  {"op":"set","collection":"messages","doc_id":"c-A2-20261028090000","data":{"item":"A2","by":"claude","text":"Singapore and Malaysia noted. Should Australia follow in phase 2?","at":"2026-10-28T09:00:00.000Z","seen":"2026-10-28T08:02:00.000Z","asks":true,"quick":[{"label":"Phase 2"},{"label":"Out of scope"}]}}
]
```

Update an existing decision:
```
{"op":"set","collection":"decisions","doc_id":"A1","data":{…},"if_version":<version from the export>}
```

Limits to keep in mind:
- a document can be at most 256 KiB;
- an artifact's database holds at most 25,000 documents;
- a `list` returns at most 1,000 documents per call, so page with `query.cursor` when told there are more;
- the page itself is built for up to a few hundred items and a few thousand messages.

Boards normally stay far below all of these.
