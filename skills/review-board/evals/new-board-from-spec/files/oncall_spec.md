# Pager: on-call rotation tool, draft spec v0.3

## Goal
Pager makes sure the right engineer is woken up when production breaks, and nobody burns out.

## Users
Engineers, team leads, and maybe managers. Possibly support staff too.

## Rotations
- Each team has a weekly rotation. Handover happens Monday morning.
- People can swap shifts with each other.
- Leads approve swaps, or maybe swaps are automatic if both people agree.
- There is a primary and a secondary on-call.

## Alerts
- Alerts come from our monitoring system and from customers emailing support.
- High-severity alerts page the primary by phone call, SMS and push notification.
- If the primary doesn't respond, escalate to the secondary, then the lead.
- Low-severity alerts can wait until business hours.
- Alerts should be deduplicated.

## Fairness
- Nobody should be on call more than their fair share.
- People get time off in lieu after a busy night.
- Holidays are handled.

## Reporting
- Monthly report of pages per person and time to acknowledge.
- Managers can see everything.

## Integrations
- Slack, our monitoring system, the HR system for holidays, and calendars.

## Non-functional
- Must be very reliable. Must work if our main cloud region is down.
- Should be cheap.

## Timeline
MVP in six weeks with two engineers.
