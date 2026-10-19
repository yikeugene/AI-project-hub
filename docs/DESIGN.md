# Workbench design notes

## Subject and job

A private developer's control room, not a team project-management suite. The primary reading sequence is **what deserves attention → where I left off → what to do next**. Evidence and user intention must remain visibly different.

## Tokens

- Page: `#F5F7FB` (cool workspace)
- Surface: `#FFFFFF` (working document)
- Primary ink: `#202B40`
- Action accent: `#4F46C8`
- Boundaries: `#E3E8F0`
- Typography: locally available Segoe UI Variable / Segoe UI / Microsoft JhengHei; no font network dependency.

## Layout

```text
Navigation       Page heading                     Quick add / scan
                 Compact numeric summary (real counts only)
                 Project worktable                Next focus
                 Search / filter / group          Reasons + blockers
                 Names, stage, Git, next action   Resume checkpoint
```

The project worktable is the main visual, rather than a dashboard made of oversized equal cards. Project names and next actions get hierarchy; repository paths are secondary and selectable. A calm consistent accent identifies actions, not arbitrary project categories.

The initial design was reviewed against the brief: decorative activity charts and completion percentages were deliberately removed. Commit counts cannot establish progress, and an empty production workspace should invite discovery instead of displaying fictitious numbers. Number summaries are directly labeled and do not need a plot. There is no multi-series chart or categorical visualization palette to validate in this release.

## Interaction rules

- Real empty onboarding; seeded examples live only in a separate verification database.
- Memory changes never vanish silently on poll or navigation.
- Status always has text, not color alone.
- Clear labels, keyboard focus, dialog dismissal and confirmation for consequential actions.
- Proposed imported state is previewed; failed operations remain visible and actionable.
- No automatic animation, external imagery, gradients or fake trend lines.
- Test desktop and narrow views with real backend data before release.
