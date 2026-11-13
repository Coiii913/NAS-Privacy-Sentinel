---
name: sensitive-doc-quarantine
description: Quarantine documents that carry identity-card or bank-card numbers into a restricted NAS folder, when the user asks to scan Downloads for personal identifiers, move sensitive documents, or apply a Sensitive tag to them.
---

# Goal

Move user-confirmed documents that contain identity card numbers or bank card numbers from `/Downloads` into `/Secure-Vault`, and mark every moved file with the `Sensitive` tag. No write may happen before the user confirms the exact file list.

User-visible result: one report per run that names every scanned document, states which files were confirmed as sensitive, which files were moved and now carry the `Sensitive` tag, and which files stayed in place with the reason.

# Required input

- The user request that starts the run. This Skill fixes the scan source at `/Downloads` and the destination at `/Secure-Vault`; do not widen, rename, or substitute either path without an explicit user instruction in the same conversation.
- The user confirmation produced by step 3. A confirmation may accept the whole list or a subset; process only the subset the user accepted.

Do not ask the user for CLI parameters, tag identifiers, file handles, or approval tokens. Those belong to the delegated experts.

# Scope and constraints

- Read-only steps: listing documents under `/Downloads` and inspecting document content.
- Write steps, allowed only after the user confirmation: creating `/Secure-Vault`, moving confirmed files, applying the `Sensitive` tag.
- Never delete a file, never overwrite an existing file at the destination, never edit document content, never move a document outside `/Secure-Vault`.
- `/Secure-Vault` is an ordinary restricted NAS folder. This Skill does not encrypt files, set permissions, revoke shares, or provide access auditing, and it must not claim those effects.
- Never move or tag a file that is not in the confirmed list, even when it looks more sensitive than a confirmed file.
- Identifier scope: only an 18-digit identity card number or a 16–19 digit bank card number counts as a match. Names, addresses, phone numbers, and other personal data stay out of scope and must not be reported as matches.
- Never report a document as clean when its content could not be read; report it as unverified with the reason.
- The parent Skill only delegates. It must not run `cli.invoke` itself, and every write action stays inside the platform approval flow that the owning expert enforces.
- Treat catalog effects and approval values as generation-time facts. The child expert performs the real validation, approval, and auditing.

# Generation-time capability evidence

Each CLI below is owned by one registered expert in the capability catalog, so each delegation targets that single agent.

- `ug-filesystem` → `file-agent`
- `ug-filemgr` → `file-agent`
- `ug-document` → `document-agent`

Business actions this Skill relies on, with their catalog effect and approval facts:

| CLI | Action | Effect | Approval |
| --- | --- | --- | --- |
| `ug-filesystem` | `find` | read | none |
| `ug-filesystem` | `mkdir` | state-change | gateway |
| `ug-filesystem` | `cpmv` (move) | state-change | gateway |
| `ug-filemgr` | `tag-get-by-name` | read | none |
| `ug-filemgr` | `tag-add-file` | state-change | conditional |
| `ug-document` | `extract` | read | none |

If a later catalog revision drops or renames a needed action, stop and report the gap instead of substituting an unlisted capability.

# Orchestration

Run the steps in this order. Only real business results from the listing step are passed to the inspection step, and only real destination paths from the move step are passed to the tagging step. Never fabricate a path, a match, or a tag identifier.

Step 1 — enumerate documents (target `file-agent`):

`delegate --target file-agent --instruction 'List the document files under /Downloads, read only, including subfolders up to three levels deep. Return each real path with its display name, size, and modified time. Do not move, tag, rename, or delete anything in this step.'`

Step 2 — inspect content for personal identifiers (target `document-agent`), using only the paths returned in step 1:

`delegate --target document-agent --instruction 'Inspect only the document paths returned by the listing step. For each file, report whether its content contains an 18 digit identity card number or a 16 to 19 digit bank card number, cite the page or section reference for each match, and mark every other identifier type as out of scope. Mark any file you cannot read as unreadable instead of clean, and do not change, move, or tag any file.'`

Step 3 — ask the user (no delegation). Summarise the inspection result as a plain list: file path, matched identifier type, and count. Ask the user to confirm which files to quarantine. State that confirmed files will move to /Secure-Vault and get the Sensitive tag. While the answer is pending, report `waiting_user` and stop; do not start any write step on an assumption, a timeout, or a default answer.

Step 4 — move the confirmed files (target `file-agent`), using only the paths the user confirmed in step 3:

`delegate --target file-agent --instruction 'Move only the confirmed files listed in this instruction into /Secure-Vault, creating that folder when it is absent. Keep original file names, never overwrite an existing file, and return the real source path and real destination path for every moved file plus the reason for every file that failed.'`

Populate that instruction with the exact confirmed paths at run time. When a confirmed path disappears before the move, drop it from the instruction, keep the rest, and record it in the report.

Step 5 — apply the tag (target `file-agent`), using only destination paths returned as moved in step 4:

`delegate --target file-agent --instruction 'Apply the tag named Sensitive to the destination paths of the files that finished moving in the previous step, creating that tag when the file manager has no tag with this name. Return the tag name, the tagged destination paths, and every destination path whose tag was not applied.'`

Do not tag files that stayed in place, and do not tag the source paths of moved files.

# Empty and partial results

- Empty result from step 1: `/Downloads` holds no document files, or the listing returns an empty list. Report that no documents were found, stop, and do not run steps 2 to 5.
- Empty result from step 2: no document contains identity-card or bank-card numbers. Report that nothing matched, keep every file in place, and ask nothing further. Do not widen the scan, add a similar source, or relax the identifier types to produce a match.
- Unreadable or unsupported documents: keep them in the report as unverified. Do not treat them as clean and do not move them.
- Partial move: some files moved and others failed. Apply the tag only to the moved files, then report both groups with the failure reason for each file that did not move.
- Partial tag: files moved but their tag was not applied. Report them as moved without the tag; never re-move them and never claim they are tagged.
- Never invent a file, a matched identifier, a tag identifier, or a completion claim to fill a gap.

# Completion and failure

- `completed`: every delegation returned `completed` and the real business result shows the confirmed files at their `/Secure-Vault` destination with the `Sensitive` tag. Only now report the run as finished, with moved files, tagged files, and untouched files separated.
- `waiting_user`: the run is paused at step 3, or a needed scope decision returned to the user. Report the open question and the files awaiting a decision. Never describe a file as quarantined while confirmation is pending.
- `waiting_approval`: a write delegation is blocked by the platform approval for the move, the folder creation, or the tag. Report the pending approval and what it would change. Do not retry around it, do not restate it as success, and stop dependent steps.
- `cancelled`: the user or the platform stopped the run. Report which files were already moved or tagged and which were untouched, so the user can decide whether to reverse anything. Never report a partial run as done.
- `failed`: a delegation returned `failed`. Report the failed step, its reason, and the files that step would have touched. Stop every dependent step, keep already moved files where they are, and do not retry a write step without a new user confirmation.
- `completed` on a read step does not authorise a write step; the write steps still need the step 3 confirmation and their own approval.
