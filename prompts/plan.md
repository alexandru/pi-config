---
description: Create and save an implementation plan without implementing it.
argument-hint: "What should be planned?"
---

Create an implementation plan for: $@

Before planning, inspect relevant code, tests, configuration, documentation, and conventions. Delegate only factual exploration to Explorer and Librarian. Ask targeted questions only when material success criteria, scope, constraints, preferences, or assumptions remain unknown.

Present a concise plan with Goal, Context, ordered Approach steps with `S`/`M`/`L` estimates, Testing Strategy, Risks, Assumptions, and Open Questions. Save it to `./specs/<descriptive-kebab-case-name>/plan.md` with Overview, Current Context, Architecture / Design, detailed Implementation Steps, Testing Strategy, Risks & Mitigations, Success Criteria, and Open Questions.

Until the plan is saved, work read-only except for that plan file. Do not implement anything. End with: **Ready to execute?** Review the plan, then tell me when you want me to continue with implementation.
