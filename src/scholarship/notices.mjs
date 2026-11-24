import { evidenceInstant, kolkataDay, zonedInstant } from '../../shared/evidence-time.mjs';
import { foldScholarshipCase } from './authority.mjs';

const scopeFields = ['scheme', 'academicYear', 'cohort', 'geography'];
const stages = ['application', 'defect', 'L1', 'L2'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const calendarDate = value => typeof value === 'string' && value.length === 10 &&
  Number.isFinite(zonedInstant(`${value}T00:00Z`));
const scopeMatches = (left, right) => scopeFields.every(field => text(left?.[field]) && left[field] === right?.[field]);

function validateNotice(notice, scope, sources, day) {
  if (!object(notice) || !text(notice.id) || !text(notice.source)) return 'invalid-notice';
  const source = Object.hasOwn(sources, notice.source) && sources[notice.source];
  if (!source) return 'unregistered-source';
  const nativeDay = notice.kind === 'release' ? notice.publishedOn : notice.capturedOn;
  if (!calendarDate(nativeDay) || !calendarDate(notice.availableOn) || notice.availableOn < nativeDay) return 'invalid-availability';
  if (notice.kind === 'release' && (!calendarDate(notice.issuedOn) || notice.issuedOn > nativeDay)) return 'invalid-revision';
  if (notice.availableOn > day) return 'not-yet-available';
  if (!scopeMatches(notice.scope, scope) || !scopeMatches(notice.scope, source.scope)) return 'wrong-scope';
  if (!text(notice.issuer) || notice.issuer !== source.issuer || notice.kind !== source.kind ||
      (notice.kind === 'release' && notice.issuer !== scope.issuer)) return 'wrong-issuer';
  if (!['release', 'capture'].includes(source.kind) || !['archived', 'synthetic'].includes(source.origin) ||
      !text(notice.locator) || (source.origin === 'archived' && (!text(notice.url) || !notice.url.startsWith('https://'))) ||
      (source.origin === 'synthetic' && notice.url !== null) || !object(notice.dates) || !Object.keys(notice.dates).length) {
    return 'invalid-notice';
  }
  for (const [stage, date] of Object.entries(notice.dates)) {
    if (!stages.includes(stage) || !source.stages?.includes(stage)) return 'wrong-stage';
    if (!calendarDate(date)) return 'invalid-date';
  }
  return null;
}

function evidence(notice, stage, sources) {
  return {
    id: notice.id, date: notice.dates[stage], issuer: notice.issuer, origin: sources[notice.source].origin,
    issuedOn: notice.kind === 'release' ? notice.issuedOn : null,
    publishedOn: notice.kind === 'release' ? notice.publishedOn : null,
    capturedOn: notice.kind === 'capture' ? notice.capturedOn : null,
    availableOn: notice.availableOn, url: notice.url, locator: notice.locator
  };
}

function resolveField(stage, notices, sources) {
  const revisions = new Map();
  const captures = [];
  for (const notice of notices) {
    if (!Object.hasOwn(notice.dates, stage)) continue;
    const record = evidence(notice, stage, sources);
    if (notice.kind === 'capture') {
      captures.push(record);
    } else {
      if (!revisions.has(notice.issuedOn)) revisions.set(notice.issuedOn, []);
      revisions.get(notice.issuedOn).push(record);
    }
  }

  let confirmed = null;
  let review = null;
  const history = [];
  for (const revision of [...revisions.keys()].sort()) {
    const records = revisions.get(revision);
    if (new Set(records.map(record => record.date)).size > 1) {
      review = { code: 'field-conflict', day: revision, evidence: records };
    } else {
      if (confirmed) history.push(confirmed);
      confirmed = { date: records[0].date, evidence: records };
      review = null;
    }
  }

  let corroboration = [];
  if (!review && captures.length) {
    const issuedOn = confirmed?.evidence[0].issuedOn;
    const current = captures.filter(record => !issuedOn || record.capturedOn >= issuedOn)
      .sort((left, right) => left.capturedOn.localeCompare(right.capturedOn));
    if (!confirmed && current.length) {
      const first = current.filter(record => record.capturedOn === current[0].capturedOn);
      if (new Set(first.map(record => record.date)).size === 1) {
        confirmed = { date: first[0].date, evidence: first };
      }
    }
    const disagreement = current.find(record => record.date !== confirmed?.date);
    if (disagreement) {
      const published = issuedOn ? confirmed.evidence : [];
      review = { code: 'capture-disagreement', day: disagreement.capturedOn, evidence: [...published, ...current] };
    } else if (confirmed) {
      const primaryIds = new Set(confirmed.evidence.map(record => record.id));
      corroboration = current.filter(record => !primaryIds.has(record.id));
    }
  }
  return { date: confirmed?.date ?? null, evidence: confirmed?.evidence ?? [], history, corroboration, review };
}

function resolveNotices(scope, sources, notices, day) {
  const available = [];
  const ignored = [];
  const acceptedIds = new Set();
  for (const notice of notices) {
    const reason = validateNotice(notice, scope, sources, day);
    if (reason) {
      ignored.push({ id: notice?.id ?? null, reason });
    } else if (acceptedIds.has(notice.id)) {
      ignored.push({ id: notice.id, reason: 'duplicate' });
    } else {
      acceptedIds.add(notice.id);
      available.push(notice);
    }
  }
  const milestones = Object.fromEntries(stages.map(stage => [stage, resolveField(stage, available, sources)]));
  return { milestones, ignored };
}

function followup(stage, milestone, caseState, day) {
  const proof = stage === 'L1' ? caseState.instituteProof : caseState.districtProof;
  if (proof) return { date: null, status: 'verified', proof };
  if (!caseState.filing) return { date: null, status: 'unfiled', proof: null };
  const { date, review } = milestone;
  let status = 'unconfirmed';
  if (caseState.review || review) status = 'review';
  else if (date) status = date < day ? 'overdue' : date === day ? 'due' : 'upcoming';
  return { date, status, proof: null };
}

export function replayNoticeCheckpoint({ scope, sources, notices, asOf, caseScope, receipts }) {
  const instant = zonedInstant(asOf);
  if (!Number.isFinite(instant)) throw new TypeError('Supply a replay checkpoint with a real date and explicit timezone.');
  if (!scopeMatches(scope, scope) || !text(scope.issuer) || !object(sources) || !Array.isArray(notices) || !Array.isArray(receipts)) {
    throw new TypeError('Supply the exact notice scope, source register, notice records and synthetic case receipts.');
  }
  const day = kolkataDay(instant);
  const { milestones, ignored } = resolveNotices(scope, sources, notices, day);
  const caseState = foldScholarshipCase(caseScope, receipts.filter(receipt => {
    const recordedAt = evidenceInstant(receipt?.recordedAt);
    return !Number.isFinite(recordedAt) || recordedAt <= instant;
  }));
  return {
    day, milestones, ignored,
    case: caseState,
    followups: Object.fromEntries(['L1', 'L2'].map(stage => [stage, followup(stage, milestones[stage], caseState, day)]))
  };
}
