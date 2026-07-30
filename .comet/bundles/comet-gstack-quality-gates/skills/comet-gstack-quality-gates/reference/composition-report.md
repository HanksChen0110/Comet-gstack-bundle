# Composition Report

## Workflow Contract

- Kind: comet-five-phase-overlay
- Nodes: 8
- Required Skill Calls: 7
- Output Schemas: comet.intake.v1, comet.design.v1, comet.plan.v1, comet.execution-evidence.v1, comet.handoff.v1, comet.review.v1, comet.verify.v1, comet.archive.v1, gstack.design.autoplan-review.v1, gstack.execute.segment-review.v1, gstack.subagent.handoff-review.v1, gstack.review.codex-adversarial.v1, gstack.verify.ordered-quality-gates.v1, gstack.archive.health-score.v1
- Wrapper classification: delegate-complete

## Source Skills

- comet-open
- comet-design
- autoplan
- comet-build
- review
- subagent-driven-development
- requesting-code-review
- codex
- comet-verify
- verification-gate
- qa
- comet-archive
- health

## Composition Steps

- step-1: comet-open (atomic)
- step-2: comet-design (atomic)
- step-3: autoplan (atomic)
- step-4: comet-build (atomic)
- step-5: review (atomic)
- step-6: subagent-driven-development (atomic)
- step-7: requesting-code-review (atomic)
- step-8: codex (atomic)
- step-9: comet-verify (atomic)
- step-10: verification-gate (atomic)
- step-11: qa (atomic)
- step-12: comet-archive (atomic)
- step-13: health (atomic)

## Resolved Skills

- autoplan: available
- review: available
- codex: available
- verification-gate: available
- qa: available
- health: available
- comet-open: available
- comet-design: available
- comet-build: available
- subagent-driven-development: available
- requesting-code-review: available
- comet-verify: available
- comet-archive: available

## Preferences

- Preference mode: not configured
- Preference hash: none
