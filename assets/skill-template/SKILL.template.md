---
name: replace-with-skill-name
description: replace-with-user-visible-result-and-trigger
---

# Goal

Describe the user-visible result and the supported scope.

# Required input

Collect only information required by the parent workflow. Do not pre-collect private parameters owned by a child expert.

# Capability evidence

For each selected capability, record `- <cli> -> <agent>` using the catalog's single `agent` value.

# Expert orchestration

Delegate self-contained instructions with `delegate --target replace-with-agent-id --instruction 'replace-with-task'`. State the order and which real result is passed to the next step.

# Completion and failure

Handle `completed`, `failed`, `cancelled`, `waiting_user`, and `waiting_approval` explicitly. Stop dependent steps when their required result is unavailable. Report empty or partial results accurately.
