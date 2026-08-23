# ADR-0005 — Dates are calendar dates, not instants

- **Status:** Accepted (2026-08-22)

## Decision

Transaction dates and budget months are **calendar dates**: `YYYY-MM-DD` strings, stored as
SQLite `TEXT`, carried as branded `CalendarDate` / `BudgetMonth` types. Budget months are always
day `01`.

**No `Date` object is constructed inside `packages/shared/date.ts` or `packages/budget-engine`.**
Day and month arithmetic is integer arithmetic (days-from-civil). `date-fns` is permitted only
in `apps/web`, for display formatting, enforced by a lint restriction on imports.

## Why this is a hard rule rather than a convention

A `Date` is an instant. Turning "the 22nd" into an instant requires a timezone, and turning it
back requires the *same* timezone. Any mismatch moves the date by one day, and a transaction
that jumps to the previous month silently changes a budget.

This is not hypothetical. The oracle does it: API-created rows are stamped with the **server's
UTC date** while UI-created rows are stamped with the **browser's local date**, so a single plan
can hold two rows created hours apart bearing different "today"s (R59, R22). A starting balance
was observed dated *tomorrow* from the user's point of view.

## "Today" has exactly one definition

Resolved once, from the **plan's IANA timezone**, and passed into the engine as an argument.
Never `new Date()` inside a calculation, never the server's locale, never UTC.

This matters beyond entry: a weekly target's demand decays as the month elapses (R30), so a
cached value goes stale at midnight **with no edit** — and midnight is a different instant for a
plan in Auckland than one in Los Angeles.

## Consequences

- String comparison is date comparison; `YYYY-MM-DD` sorts correctly. No comparator needed.
- Golden fixtures for anything date-dependent must pin `today` explicitly, or they pass on the
  day recorded and fail every day after.
- Date validation is strict: `2026-02-30` throws rather than rolling over to March, which is
  what `new Date()` would have done.
