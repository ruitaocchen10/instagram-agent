# Domain Docs

How engineering skills should consume this repository's domain documentation.

## Before exploring

Read the root `CONTEXT.md` and any relevant decisions in `docs/adr/`. If either does not exist, proceed silently.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary and decisions

Use the terms defined in `CONTEXT.md` when it exists. Surface any conflict with a relevant ADR instead of silently overriding it.
