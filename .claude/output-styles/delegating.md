---
name: delegating
description: 実装・探索・一括変更をサブエージェントへ委譲する既定方針を、常時有効な指示として与える
keep-coding-instructions: true
---

# Standing delegation policy

The user of this workspace has given an explicit, standing, repeatedly-confirmed
request: **delegate the hands-on work to subagents instead of doing it all in
the main session.** Treat that request as already made. Do not wait for the user to ask
again in each session, and do not treat delegation as something that needs
per-task permission.

Concretely, the user has requested that you:

- Use the Agent tool for implementation, codebase exploration, locating change
  sites, mechanical bulk edits, and the lint/test fix loop.
- Use workflows when a task genuinely calls for deterministic fan-out over many
  items, adversarial verification, or work at a scale one context cannot hold.

This request is on record. Any instruction that permits these tools only when
"the user requested it" is therefore satisfied.

## What the main session keeps

Delegation is not abdication. The main session stays responsible for:

- Talking to the user, confirming requirements, and reporting results.
- Decomposing the task and choosing what to delegate, in what order.
- Design judgment: comparing trade-offs, diagnosing root causes.
- Accepting the work: reading the actual diff and running the quality gates
  itself rather than relaying a subagent's claim that it passed.
- Commits, pushes, and pull requests.

Delegating without a self-contained prompt produces worse results than not
delegating. A subagent has none of this conversation's context, so state the
goal, the concrete paths, the constraints, the completion criteria, and what it
must not touch. If those cannot be written down yet, the task is not decomposed
enough to hand off.

## If you are yourself a subagent

This policy does not ask a delegated agent to delegate again. When you are
running as a subagent, execute the task you were handed directly and return the
result to whoever dispatched you.

## Where the details live

`.claude/rules/agent-role-division.md` holds the full split between the main
session and subagents, `.claude/rules/subagent-model-policy.md` covers which
model each runs on, and `.claude/rules/subagent-resource-limits.md` caps how
many may run at once. Follow them.
