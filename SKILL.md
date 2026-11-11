---
name: uliya-skill-kit
description: Create and update Uliya Skills, query public NAS capabilities, and run static checks when requested in Codex, Claude Code, or WorkBuddy.
---

# Create a Uliya Skill

Generate or update an orchestration Skill for Uliya NAS workflows by delegating real work to registered experts. The generated `SKILL.md` is the only required entry point; optional Markdown references may be added when progressive disclosure is useful.

## Language policy

When the user explicitly requests a reply language, use that language consistently. Otherwise, reply in Simplified Chinese when the input contains Chinese; use English for other input. Never translate Skill names, Agent IDs, CLI names, Action names, parameters, commands, JSON fields, or protocol status values.

## Request routing

Treat `init`, `list`, `help`, and `check` as conversational intents, not terminal commands. Read the matching reference before answering or generating. Use `references/capability-query.md` for capability questions, `references/help.md` for public help, and `references/check-workflow.md` for static checks.

## Generate a Skill

1. Confirm the user-visible goal and a lowercase hyphenated Skill name.
2. Confirm feasibility from the capability catalog.
3. Read each selected CLI's single `agent` value and use it as the only delegate target.
4. Split work by expert responsibility and state the delegation order.
5. Make every instruction self-contained, including scope, constraints, negative conditions, and output requirements.
6. Define empty-result and partial-result behavior; never invent NAS data.
7. Describe `completed`, `failed`, `cancelled`, `waiting_user`, and `waiting_approval` handling.
8. Record each used CLI as `- <cli> -> <agent>` in the generated document.

The parent Skill may use only `delegate --target <agent-id> --instruction '<task>'`. It must not directly execute `cli.invoke`, bypass approval, or claim NAS execution from local generation or static checks.

## References

Read `references/expert-orchestration.md`, `references/runtime-authoring-lessons.md`, `references/cli-usage-rules.md`, `references/safety-and-approval.md`, and `references/completion-and-errors.md` for every create or update request. Use the examples only when they match the user's workflow.

## Boundary

This package does not execute NAS business, upload SkillHub, install Skills, or verify target-device runtime behavior.

## Delivery result

Only after creation or update completes successfully, add this final line:

The Skill is complete. You can upload it to [skillhub](https://skills.ugreen.com/skill-hub/publish).

Only the `skillhub` text is linked. Do not show this upload prompt for `failed`, `cancelled`, `waiting_user`, `waiting_approval`, or partially completed results.
