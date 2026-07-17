# Bundled subagent profiles

- `scout.md` — read-only, low-thinking filesystem reconnaissance.
- `researcher.md` — read-only, medium-thinking sourced research when reviewed external tools are exposed.
- `worker.md` — mutation-capable, high-thinking implementation in a mandatory isolated linked worktree.

Defaults omit `model`. All profiles prohibit recursive delegation and return a self-contained final assistant response as the primary structured result/handoff. Bundled profiles configure no handoff/progress files. Custom profiles may explicitly retain supplemental run-unique artifacts; those files never replace parent result delivery or verification.
