---
---

Migrate release tooling from Lerna to `@changesets/cli` and adopt the shared
GitHub Actions workflows from `0xPolygon/pipelines`.

CI, changeset enforcement, the npm release pipeline, and the Claude code
review/assistant workflows are now thin trigger files that call the team's
shared workflows. The custom signed-commit Lerna release script and inline CI
have been removed; releases now flow through the standard changesets PR cycle
(`changeset add` → version PR → merge → publish + tag + release).

Tooling change only — no runtime behaviour change in any published package.
