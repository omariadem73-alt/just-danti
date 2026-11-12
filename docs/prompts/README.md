# Prompts

The agent is two layers: a **speaker** (talks to the caller) and a **reasoner** (runs the tools).
If you use a single assistant, merge the reasoner's TOOLS / NEW APPOINTMENT / CANCELLATION /
CHANGING sections into the speaker and drop the STATUS protocol.

Rules learned the hard way:
1. Never use `{{variables}}` for practice facts. The reasoner does not receive them. Write the facts as plain text.
2. Search both prompts for `[` and replace every `[PLACEHOLDER]` before saving.
3. Business rules (opening hours, closures, booking horizon) live in the API, not in the prompt.
4. Quoted lines in the prompt are intent, not scripts. Only the three EXACT WORDING items are fixed.
