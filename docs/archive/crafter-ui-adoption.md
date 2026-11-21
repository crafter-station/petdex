# Crafter UI adoption

Source: https://ui.crafter.run/r/action-button.json, from the production ZIP downloaded on 2026-09-07 (Crafter UI b3a5bc5). Editable source is owned by this repository.

Adopted ActionButton and Spinner into src/components/ui. The existing Petdex Button and global theme are retained. Spinner's cn import uses Petdex's existing utility instead of adding the cn package. Biome formatting follows this repository.

SubmissionCard now passes its existing withdrawal transition to ActionButton's pending and pendingLabel props. The component centralizes disabling, the pending label, spinner, and aria-busy. The existing handler, destructive confirmation, backend mutation, and class names remain in place.

Validation: focused server-render tests pass (2 tests, 8 assertions); whole-project TypeScript check passes. No production submission was withdrawn to exercise this UI change.
