---
description: Review uncommitted changes, a commit, a branch, or a pull request.
argument-hint: "[commit|branch|PR]"
---

Review changes specified by `$@`; default to all uncommitted changes. For no argument, inspect unstaged and staged diffs and untracked files. For a commit, inspect that commit; for a branch, compare it with `HEAD`; for a pull request, retrieve its context and diff.

Read every changed file in full and applicable project instructions before drawing conclusions. Focus on demonstrable bugs, security issues, broken error handling, unintended behavior changes, and clear convention violations. Investigate uncertainty with Explorer or Librarian before reporting it. Review only changed code, cite file paths and line numbers, state the concrete failure scenario, and calibrate severity. Do not add praise or style-only findings.
