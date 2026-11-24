import { zonedInstant } from '../shared/evidence-time.mjs';

export class PlannerProposalError extends Error {
  constructor() {
    super('The planner returned an invalid proposal.');
    this.name = 'PlannerProposalError';
  }
}

const proposalFields = ['goal', 'checkDate', 'practicePlan'];
const receiptFields = ['capability', 'issuer', 'subject', 'type', 'status'];
const visitFields = ['capability', 'issuer', 'subject', 'service', 'windowStart', 'windowEnd'];
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const overpreciseFraction = /\.\d{4}/u;
const identifierPattern = /^[a-z0-9][a-z0-9._:-]{0,99}$/iu;
const maximumWindow = 31 * 24 * 60 * 60 * 1000;

function isPlain(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDataField(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
}

function requireShape(value, fields) {
  if (!isPlain(value) || Reflect.ownKeys(value).length !== fields.length || !fields.every(key => isDataField(value, key))) {
    throw new PlannerProposalError();
  }
}

function validDay(value) {
  if (typeof value !== 'string' || !dayPattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function identifier(value) {
  if (value === null || value === '') return '';
  if (typeof value !== 'string' || !identifierPattern.test(value.trim())) throw new PlannerProposalError();
  return value.trim();
}

function windowTime(value) {
  if (value === null || value === '') return '';
  if (!Number.isFinite(zonedInstant(value)) || overpreciseFraction.test(value)) throw new PlannerProposalError();
  return value;
}

function practicePlan(value) {
  if (value === null) return null;
  if (!isPlain(value) || !isDataField(value, 'capability')) throw new PlannerProposalError();

  if (value.capability === 'receipt') {
    requireShape(value, receiptFields);
    return {
      capability: 'receipt', issuer: identifier(value.issuer), subject: identifier(value.subject),
      type: identifier(value.type), status: identifier(value.status)
    };
  }
  if (value.capability === 'visit') {
    requireShape(value, visitFields);
    const windowStart = windowTime(value.windowStart);
    const windowEnd = windowTime(value.windowEnd);
    if (windowStart && windowEnd) {
      const span = zonedInstant(windowEnd) - zonedInstant(windowStart);
      if (span <= 0 || span > maximumWindow) throw new PlannerProposalError();
    }
    return {
      capability: 'visit', issuer: identifier(value.issuer), subject: identifier(value.subject),
      service: identifier(value.service), windowStart, windowEnd
    };
  }
  throw new PlannerProposalError();
}

export function validatePlannerProposal(value) {
  try {
    requireShape(value, proposalFields);
    const { goal, checkDate } = value;
    if (typeof goal !== 'string' || goal.length > 4000 || !goal.trim() ||
        (checkDate !== null && !validDay(checkDate))) throw new PlannerProposalError();
    return { goal: goal.trim(), checkDate, practicePlan: practicePlan(value.practicePlan) };
  } catch {
    throw new PlannerProposalError();
  }
}
