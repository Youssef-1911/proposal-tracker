"""
Business rules for proposal requests, ported 1:1 from the frontend's src/domain
(metrics.js, proposals.js, permissions.js, workflow.js, tracker.js).

Pure functions over plain views (no ORM, no FastAPI), so the same code runs for the API
and for the shared contract scenarios in /contracts. Dates are ISO strings like the
frontend ("today" = Africa/Cairo calendar date); timestamps are aware datetimes.
"""
