# claude-skills

Skills for Claude, kept here as the source of truth: each one with its instructions, bundled files and tests.

| Skill | What it does |
|---|---|
| [review-board](#review-board) | Work through a long critique or a pile of open decisions on an interactive page instead of in chat. |

## review-board

**Work through a long critique or a pile of open decisions on a page, instead of in chat.**

Claude turns its questions into a board of items, each with a recommendation. You answer at your own pace, on your phone or laptop, and Claude reads your answers straight from the page. It replies in each item's thread, asks follow-ups when an answer is ambiguous, records decisions, and applies them to your document when everything is settled.

<p align="center">
  <img src="docs/review-board/images/01-overview.png" alt="A review board after one round: status line, what changed since your last visit, state tabs and collapsed items" width="820">
</p>

<table>
  <tr>
    <td width="33%" valign="top">
      <img src="docs/review-board/images/03-answering.png" alt="Answering an item: options, Something else, I have a question, Decide later"><br>
      <b>One tap to answer.</b> Pick an option, give a different decision, ask a question, or park it. Every answer saves at once and undoes the same way.
    </td>
    <td width="33%" valign="top">
      <img src="docs/review-board/images/02-follow-up.png" alt="Claude asks a follow-up with one-tap replies"><br>
      <b>Claude asks instead of guessing.</b> An ambiguous answer comes back as a follow-up with one-tap replies.
    </td>
    <td width="33%" valign="top">
      <img src="docs/review-board/images/07-phone-dark.png" alt="The board on a phone in dark mode"><br>
      <b>Phone or laptop, light or dark.</b> Answers sync, so you can start on one device and finish on another.
    </td>
  </tr>
</table>

**How it works:**
1. Claude writes the items as data.
2. A script validates them and builds the page from a fixed template, so every board looks the same and no HTML is written per review.
3. After each pass, Claude reads the answers, records decisions, asks follow-ups and rewrites items that earlier answers have changed.

→ [Design and usage guide](docs/review-board/README.md) · [The skill](skills/review-board/SKILL.md)

**Where it works:** the board is a claude.ai Artifact with a database, so the skill needs the Artifact and ArtifactData tools. It has been used and tested in Claude Code sessions on claude.ai (web and app). The local Claude Code CLI can publish artifacts too, but whether those pages get a database there isn't documented, so treat local use as untested.

## Installing a skill in Claude Code

Claude Code (the CLI, and the Code tab of the desktop app) loads any skill folder placed in a skills directory. No packaging is needed.

```bash
git clone https://github.com/marcykay404/claude-skills.git
mkdir -p ~/.claude/skills
cp -R claude-skills/skills/review-board ~/.claude/skills/
```

- `~/.claude/skills/` makes the skill available in every project.
- `<project>/.claude/skills/` makes it available in one project, and can be committed with that project.

To update, pull the repository and copy the folder again. Claude applies a skill when your request matches its description, or you can ask for it by name (`/review-board`).

## Layout

```
skills/
└── <skill-name>/       what gets installed
    ├── SKILL.md        instructions, and the description Claude uses to decide when to apply the skill
    ├── assets/         files the skill uses in its output (templates, examples)
    ├── scripts/        deterministic helpers the skill runs
    ├── references/     detail loaded only when needed
    └── evals/          model test cases: one folder per case, with its prompt, inputs and checks
tests/
└── <skill-name>/       fast tests of the scripts and the page, no model involved
docs/
└── <skill-name>/       guides and screenshots for people, and the sample data behind them
```

## Testing

**Fast tests** check the scripts and drive the real page in a browser against a fake in-memory database. They need Python 3, Node and Playwright with Chromium, and no account:

```bash
python3 tests/review-board/test_scripts.py
node tests/review-board/test_page.js            # or: node tests/review-board/test_page.js "quick reply"
```

They cover the item states (from one shared table, so the page and `round_report.py` must agree), saving, undo, failed and retried writes, unsent drafts, loading and read-only modes, keyboard use, phone layout, and board validation.

**Model evals** run Claude on realistic requests, with and without the skill, and grade the results. They are real, billed model runs:

```bash
cd skills/review-board
claude plugin eval . --allow-tools Write,Edit,Bash --scaffold
```

`claude plugin eval` has no Artifact tools, so each case tells Claude to save the publish call, database writes and chat reply to files instead, and the graders read those.

**Screenshots** in `docs/` are generated from the sample board: `node docs/review-board/sample/shoot.js`.
