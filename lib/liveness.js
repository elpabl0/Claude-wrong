import { loadConfig, daysBetween } from './config.js';

/**
 * Is the machinery still running?
 *
 * Every scheduled job here can fail silently. A routine stops firing because a
 * subscription lapsed, a workflow breaks on a dependency, a token expires - and
 * the site carries on serving yesterday's numbers looking perfectly healthy.
 * The failure mode of an unattended system is not a crash, it is a quiet stall
 * that nobody notices for three weeks.
 *
 * So liveness is computed from the record itself and published on the front
 * page, where it is visible to anyone rather than only to whoever reads the
 * logs. If the market has stopped, the market says so.
 *
 * Deliberately derived from committed artefacts, not from a heartbeat the
 * monitoring writes itself: a heartbeat proves the heartbeat is running.
 */

const HOUR = 3600 * 1000;

export function liveness(market, { now = new Date() } = {}) {
  const config = market.config ?? loadConfig();
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const checks = [];

  const add = (id, label, ok, detail, severity = 'stalled') =>
    checks.push({ id, label, ok, detail, severity: ok ? 'ok' : severity });

  // Questions are written weekly. More than eight days without a batch means the
  // authoring run has stopped.
  //
  // Canaries are excluded deliberately. They are written daily, so counting them
  // would hold this check green for ever and hide the weekly batch having
  // stopped - the monitoring would be masking the exact failure it exists to
  // catch. A check that cannot go red is not a check.
  const authored = market.questions.filter((q) => (q.lane ?? q.question.lane ?? 'standard') !== 'canary');
  const newest = authored.length
    ? authored.map((q) => q.question.created_utc).sort().at(-1)
    : null;
  if (!newest) {
    add('authoring', 'Questions written', false, 'No question has ever been written.', 'never-run');
  } else {
    const age = daysBetween(newest.slice(0, 10), today);
    add('authoring', 'Questions written', age <= 8, age <= 8
      ? `Last batch ${age} day(s) ago.`
      : `Last batch was ${age} days ago; questions are written weekly, so the authoring run has stopped.`);
  }

  // Rounds are cleared by a job running every six hours. A round more than twelve
  // hours past its close has not been picked up.
  const overdueRounds = market.roundsAwaitingClear.filter(
    ({ round }) => nowMs - Date.parse(round.closes_utc) > 12 * HOUR,
  );
  add('clearing', 'Rounds cleared', overdueRounds.length === 0,
    overdueRounds.length === 0
      ? `${market.roundsAwaitingClear.length} round(s) waiting, all within the six-hour cycle.`
      : `${overdueRounds.length} round(s) closed more than twelve hours ago and still not cleared: ${overdueRounds.map((r) => `${r.question.id}/${r.round.id}`).join(', ')}.`);

  // A question past its resolution date plus the grace period should have
  // resolved or voided. Still open means the resolver is not running.
  const stuck = market.awaitingResolution.filter(
    (q) => daysBetween(q.question.resolution_date, today) > config.resolution.grace_period_days,
  );
  add('resolution', 'Questions resolved', stuck.length === 0,
    stuck.length === 0
      ? 'Nothing is past its grace period.'
      : `${stuck.length} question(s) are past their resolution date plus the ${config.resolution.grace_period_days}-day grace period and have neither resolved nor voided: ${stuck.map((q) => q.question.id).join(', ')}.`);

  // The canary is the only check here that exercises the WHOLE path - authored,
  // opened, sealed, cleared, resolved, settled - inside a single day. Every other
  // check tests one stage and takes between eight days and three months to fire.
  // A canary that has not resolved in 48 hours means something in that chain is
  // broken, without having to wait for a real question to find out.
  const canaries = market.questions.filter((q) => (q.lane ?? q.question.lane) === 'canary');
  const resolvedCanaries = canaries.filter((q) => q.resolution);
  const newestResolved = resolvedCanaries.length
    ? resolvedCanaries.map((q) => q.resolution.resolved_utc ?? q.question.resolution_date).sort().at(-1)
    : null;
  if (!canaries.length) {
    add('canary', 'Daily canary', false, 'No canary question has ever been written; the pipeline has no daily end-to-end test.', 'never-run');
  } else {
    const age = daysBetween(String(newestResolved ?? '1970-01-01').slice(0, 10), today);
    add('canary', 'Daily canary', newestResolved !== null && age <= 2,
      newestResolved === null
        ? `${canaries.length} canary question(s) written, none resolved yet.`
        : age <= 2
          ? `Last canary resolved ${age} day(s) ago; the full path works end to end.`
          : `No canary has resolved in ${age} days. Something between authoring and settlement is broken.`);
  }

  // Did the canary rounds actually CLEAR?
  //
  // Deliberately measured from closed rounds rather than from open ones, because
  // "is a round currently quiet" can only fail while a round is open - and the
  // daily watchdog samples at 16:40, after the 15:00 close, so it never could.
  // Three canaries ran, none cleared, and the stalled-market alarm closed itself
  // as recovered every day: a check that can only fail during a window nothing
  // observes is not a check.
  //
  // A canary that resolves but never clears is the more dangerous failure of the
  // two, because everything around it looks healthy. The question is written, the
  // round runs, the source is read, an outcome is recorded - and no price was
  // ever discovered, which is the only thing the market exists to do.
  const closedCanaries = canaries
    .flatMap((q) => (q.clearings ?? []).map((c) => ({ id: q.question.id, closed: c.closed_utc ?? c.cleared_utc ?? '', cleared: c.cleared, reason: c.reason })))
    .sort((a, b) => (a.closed < b.closed ? -1 : 1));
  const recent = closedCanaries.slice(-3);
  const clearedCount = recent.filter((c) => c.cleared).length;

  if (recent.length) {
    add('canary_clears', 'Canary rounds clear', clearedCount > 0,
      clearedCount > 0
        ? `${clearedCount} of the last ${recent.length} canary round(s) cleared.`
        : `None of the last ${recent.length} canary round(s) cleared: ${recent.at(-1).reason ?? 'no reason recorded'}. ` +
          'A canary that resolves but never clears looks healthy from every other angle while discovering no price at all.');
  }

  // Seats trade daily when a round is open. An open round with no commitments
  // and less than half its window left means nobody is showing up.
  const quiet = market.openRounds.filter(({ round }) => {
    const opened = Date.parse(round.opens_utc);
    const closes = Date.parse(round.closes_utc);
    return round.commitment_count === 0 && nowMs > opened + (closes - opened) / 2;
  });
  add('participation', 'Seats trading', quiet.length === 0,
    quiet.length === 0
      ? 'Open rounds have orders, or are early in their window.'
      : `${quiet.length} open round(s) are past halfway with no orders at all.`,
    'quiet');

  const stalled = checks.filter((c) => !c.ok);
  return {
    checked_utc: now.toISOString(),
    ok: stalled.length === 0,
    // "never-run" is a market that has not started; "stalled" is one that has stopped.
    state: stalled.length === 0 ? 'running' : stalled.some((c) => c.severity === 'never-run') ? 'not-started' : 'stalled',
    checks,
    stalled,
  };
}
