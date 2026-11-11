# Skill format

`SKILL.md` begins with only `name` and `description` frontmatter. The body must state the goal, required input, capability evidence, expert orchestration, and completion/failure behavior. Optional resources are ordinary Markdown files under `references/` and must be linked directly from the root.

Keep technical identifiers unchanged. Do not add manifests, sidecars, scripts, binaries, credentials, or direct `cli.invoke` calls. Local generation only proves that files were written; it does not prove static pass, upload, installation, compatibility, or runtime execution.
