---
tags: [skill-creator]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

everything on the checkout review board is decided now. please update checkout_spec.md with all the decisions and keep a record of what we decided and why. board: https://claude.ai/artifact/CHKOUT-DEMO

Input files: board.json, checkout_spec.md, export

---
Test-harness rules. These replace real side effects, so follow them exactly:
- **Do not call the Artifact or ArtifactData tools,** or any MCP or GitHub tools. This is a test, and those tools would change a real account.
- Where you would publish an artifact, save the exact call you would make to `outputs/publish.json` instead: `{"action", "file_path", "capabilities", "icon", "description", ...}`, plus a note of any other Artifact calls you would make first. Put the published HTML file itself in `outputs/`.
- Where you would read the artifact's database, use the `export/` folder if there is one: it holds what `ArtifactData` `list` calls would have saved.
- Where you would write to the artifact's database, save the writes to `outputs/writes.json` instead, as the `writes` array of a batch call.
- Save every other file you produce (board.json, notes and so on) into `outputs/`, and the exact reply you would send in chat to `outputs/reply.md`.
