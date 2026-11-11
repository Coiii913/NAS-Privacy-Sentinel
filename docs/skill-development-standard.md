# Uliya Skill Development Standard

This guide is for third-party developers creating orchestration Skills for NAS workflows. Start with the user's desired result, then confirm that every required operation exists in the [public capability catalog](../references/cli-capabilities.md). The machine-readable source is `data/capability-catalog.json`.

## Core concepts

- A Skill is a Markdown entry point describing a user-facing workflow.
- A capability domain groups related NAS operations.
- A CLI capability is a published operation family; an Action is one operation within it.
- A registered expert performs the real NAS work after delegation.

## Four-step workflow

1. Write a clear user goal, not a list of implementation steps.
2. Confirm the domain, CLI capabilities, Actions, data effects, approval needs, and completion evidence in the catalog.
3. Write `SKILL.md` with required input, capability evidence, expert orchestration, and completion/failure handling.
4. Run the controlled checker, review diagnostics, and build a versioned release without overwriting an existing version.

Use only capabilities present in the catalog. If a required step has no matching capability, state that it is unsupported; never infer support from a product name or UI label.
