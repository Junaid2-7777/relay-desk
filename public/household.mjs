import { calendarConflictChoice, reviewNeeded } from '../shared/brief-order.mjs';

const activity = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
});
const bookingInputTime = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZone: 'Asia/Kolkata'
});

export const when = timestamp => activity.format(new Date(timestamp));

function bookingInputValue(timestamp) {
  if (!timestamp) return { date: '', time: '' };
  const parts = Object.fromEntries(bookingInputTime.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}`
  };
}

export function money(amountMinor, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency, maximumFractionDigits: 2, minimumFractionDigits: 0
  }).format(amountMinor / 100);
}

export function addText(parent, tag, text) {
  const child = document.createElement(tag);
  child.textContent = text;
  parent.append(child);
  return child;
}

export function action(parent, label, callback) {
  const button = addText(parent, 'button', label);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

export function fact(list, name, text) {
  const title = document.createElement('dt');
  const value = document.createElement('dd');
  title.textContent = name;
  value.textContent = text;
  list.append(title, value);
}

const issues = {
  'visit-permission': 'Review access to check and book the visit.',
  'slot-unavailable': 'A free visit within your window is unavailable.',
  'reservation-unknown': 'Checking whether the provider booked the visit.',
  'calendar-pending': 'The provider confirmed the visit. The calendar entry is pending.',
  'bill-permission': 'Review access to check the bill and see which payments are covered.',
  'invoice-unavailable': 'The biller has no current invoice for this account. Check again when one is available.',
  'bill-deferred': 'You chose to leave this invoice unpaid.',
  'payment-unknown': 'Checking whether the payment went through.',
  'payment-pending': 'The biller accepted the payment. Settlement is pending.',
  'receipt-permission': 'Allow a check of this exact record when you are ready.',
  'receipt-pending': 'Waiting for the required receipt from the issuer.',
  'receipt-unavailable': 'The issuer could not be reached. Check your errands again to retry.',
  'evidence-needed': 'The practice desk has no source for this issuer. Keep the errand open and check with the issuer directly.'
};

export function statusLabel(record) {
  if (record.status === 'stopped') return 'Tracking stopped';
  if (record.kind === 'visit') {
    if (record.issue === 'calendar-conflict') return 'Visit booked · calendar conflict';
    if (record.reservation) return 'Provider confirmed';
    return 'Waiting for a visit';
  }
  if (record.kind === 'bill') {
    if (record.issue === 'bill-review') return 'Needs your review';
    if (record.status === 'verified') return 'Bill settled';
    if (record.status === 'accepted') return 'Payment accepted';
    return record.issue === 'bill-deferred' ? 'Left unpaid' : 'Bill open';
  }
  if (record.kind === 'refund') return record.status === 'verified' ? 'Refund verified' : 'Waiting for credit';
  if (record.kind === 'receipt') return record.status === 'verified' ? 'Receipt verified' : 'Waiting for evidence';
  return 'Open';
}

function permissions(record) {
  if (record.receiptPlan) {
    const { issuer, subject, available } = record.receiptPlan;
    return available ? [['receipt', 'Issuer receipt', `Read receipt records for ${subject} from ${issuer}.`]] : [];
  }
  if (record.visit) {
    const window = `${when(record.visit.windowStart)} to ${when(record.visit.windowEnd)} IST`;
    return [
      ['freeBusy', 'Calendar availability', `Read only busy intervals during ${window}.`],
      ['slots', 'Provider availability', `Read offered times for ${record.visit.service} from ${record.owner}.`],
      ['reserve', 'Free booking', `Reserve one free slot during ${window}.`],
      ['calendar', 'Calendar entry', 'Add and verify the calendar entry for the confirmed reservation.']
    ];
  }
  return [
    ['invoice', 'Invoice and receipts', `Read ${record.bill.invoiceId} and its payment receipts.`],
    ['payment', 'Bill payment', `Pay this invoice to ${record.owner} once, up to ${money(record.capMinor, record.bill.currency)}.`]
  ];
}

const activeAt = (grant, deskTime) => grant?.status === 'allowed' && Date.parse(grant.expiresAt) > Date.parse(deskTime);

function renderAccess(panel, record, run, deskTime) {
  const entries = permissions(record);
  if (!entries.length) return;
  const details = document.createElement('details');
  details.className = 'source evidence';
  addText(details, 'summary', 'Permissions');
  for (const [operation, label, description] of entries) {
    const grant = record.grants[operation];
    const active = activeAt(grant, deskTime);
    const section = document.createElement('section');
    section.className = 'permission';
    addText(section, 'h4', label);
    addText(section, 'p', description);
    const access = {
      allowed: active ? `Allowed until ${when(grant?.expiresAt)} IST` : 'Access expired',
      withdrawn: 'Access withdrawn',
      declined: 'Access declined'
    };
    addText(section, 'p', access[grant?.status] ?? 'Access available for seven days');
    const row = document.createElement('div');
    row.className = 'actions';
    const choose = (prefix, choice) => action(row, `${prefix} ${label.toLowerCase()}`, event =>
      run('household-access', { operation, choice, revision: record.revision }, event.currentTarget));
    if (active) choose('Withdraw', 'withdrawn');
    else {
      choose('Allow', 'allowed');
      if (grant?.status !== 'declined') choose('Decline', 'declined');
    }
    section.append(row);
    details.append(section);
  }
  panel.append(details);
}

function renderBill(panel, list, record, run, deskTime) {
  const { invoice, previousInvoice, capMinor, bill, payment, settlement, approval, grants } = record;
  const reviewing = reviewNeeded(record) && invoice;
  const terms = reviewing ? document.createElement('dl') : list;
  if (reviewing) {
    list.classList.add('bill-amounts');
    terms.className = 'facts invoice-terms';
    panel.append(terms);
  }
  if (previousInvoice && previousInvoice.revision !== invoice?.revision) {
    fact(list, invoice ? 'Previous invoice' : 'Last seen invoice', money(previousInvoice.amountMinor, previousInvoice.currency));
  }
  if (invoice) fact(list, 'Current invoice', money(invoice.amountMinor, invoice.currency));
  fact(list, 'Standing limit', money(capMinor, bill.currency));
  if (invoice) {
    fact(terms, 'Invoice', `${invoice.invoiceId} · revision ${invoice.revision}`);
    fact(terms, 'Payee', `${invoice.payeeLabel} · ${invoice.payee}`);
  }
  if (reviewing) {
    const canReview = activeAt(grants.invoice, deskTime);
    const canPay = canReview && activeAt(grants.payment, deskTime) &&
      invoice.payee === bill.payee && invoice.currency === bill.currency;
    const approved = canPay && activeAt(approval, deskTime) && approval.grantRevision === grants.payment.revision &&
      ['invoiceId', 'revision', 'payee', 'currency', 'amountMinor'].every(field => approval[field] === invoice[field]);
    if (approved) {
      addText(panel, 'p', 'One-time payment approved. Check your errands to apply it.');
    } else if (!canReview) {
      addText(panel, 'p', 'Allow invoice and receipt access in Permissions to review this bill.');
    } else {
      const choices = document.createElement('div');
      choices.className = 'actions bill-actions';
      if (canPay) {
        addText(panel, 'p', `Pay once for this revision. Future bills keep the ${money(capMinor, bill.currency)} limit.`);
        action(choices, `Pay ${money(invoice.amountMinor, invoice.currency)} once`, event =>
          run('bill-choice', { choice: 'approve', revision: record.revision }, event.currentTarget, true)).className = 'primary';
      } else {
        addText(panel, 'p', 'Review bill payment access in Permissions to approve this invoice.');
      }
      action(choices, 'Leave unpaid', event =>
        run('bill-choice', { choice: 'defer', revision: record.revision }, event.currentTarget));
      panel.append(choices);
    }
  }
  if (payment) fact(list, 'Payment reference', payment.paymentRef);
  if (settlement) fact(list, 'Settled', `${when(settlement.settledAt)} IST`);
}

function renderVisitConflict(panel, record, run, deskTime) {
  const choice = calendarConflictChoice(record);
  if (choice === 'handle') addText(panel, 'p', 'You chose to contact the provider about rescheduling.');
  if (choice === 'watch') addText(panel, 'p', 'You chose to keep checking the booked time.');
  addText(panel, 'p', 'Your confirmed visit and the overlapping calendar commitment stay in place.');

  const needed = [['slots', 'provider availability'], ['freeBusy', 'calendar availability']]
    .filter(([operation]) => !activeAt(record.grants[operation], deskTime)).map(([, label]) => label);
  if (needed.length) {
    addText(panel, 'p', `Allow ${needed.join(' and ')} in Permissions to review this overlap.`);
    return;
  }

  addText(panel, 'p', choice === 'watch'
    ? 'At the next check, Relay can add this visit if the time frees up and calendar access is allowed.'
    : 'If you keep checking, Relay can add this visit when the time frees up and calendar access is allowed.');
  const actions = document.createElement('div');
  actions.className = 'actions';
  const choose = (label, selection) => action(actions, label, event =>
    run('visit-choice', { choice: selection, revision: record.revision }, event.currentTarget));
  if (choice !== 'handle') choose('I’ll contact the provider', 'handle');
  if (choice !== 'watch') choose('Keep checking this time', 'watch');
  panel.append(actions);
}

export function renderHousehold(panel, list, record, run, deskTime) {
  const showOwner = record.owner && !(record.bill && reviewNeeded(record) && record.invoice?.payeeLabel === record.owner);
  if (showOwner) fact(list, 'Responsible for this errand', record.owner);
  if (record.reservation) {
    fact(list, 'Booked for', `${when(record.reservation.start)} IST`);
    fact(list, 'Provider confirmation', record.reservation.id);
  }
  if (record.calendarEvent) fact(list, 'Calendar entry', 'Confirmed in the practice calendar');
  if (record.conflict) fact(list, 'Calendar conflict', `${when(record.conflict.start)} IST`);
  if (record.status !== 'stopped') {
    if (record.issue === 'calendar-conflict') renderVisitConflict(panel, record, run, deskTime);
    else if (record.issue === 'calendar-pending' && record.conflictChoice?.choice === 'handle' &&
             record.conflictChoice.reservationId === record.reservation?.id) {
      addText(panel, 'p', 'You chose to contact the provider about rescheduling.');
    } else if (issues[record.issue]) addText(panel, 'p', issues[record.issue]);
  }
  if (record.bill) renderBill(panel, list, record, run, deskTime);
  if (record.receiptPlan) {
    const { issuer, subject, type, status } = record.receiptPlan;
    fact(list, 'Issuer', issuer);
    fact(list, 'Record reference', subject);
    fact(list, 'Required proof', `${type} · ${status}`);
    if (record.receiptProof) {
      fact(list, 'Matching receipt', record.receiptProof.id);
      fact(list, 'Issued', `${when(record.receiptProof.occurredAt)} IST`);
    }
    if (record.receiptCheck?.checkedAt) fact(list, 'Last successful check', `${when(record.receiptCheck.checkedAt)} IST`);
    if (record.receiptCheck?.lastEventAt) fact(list, 'Last issuer event', `${when(record.receiptCheck.lastEventAt)} IST`);
  }
  if (record.status !== 'stopped') renderAccess(panel, record, run, deskTime);
}

export function renderPracticeSetup(panel, record, sources, run, onEdit) {
  const editingVisit = record.visitPlanEditable === true;
  const editing = editingVisit || Boolean(record.receiptPlan);
  const checkedItem = editingVisit ? 'visit' : 'receipt';
  const suggestion = editingVisit ? { ...record.visit, capability: 'visit' } : record.receiptPlan ?? record.practicePlan ?? {};
  const details = document.createElement('details');
  details.className = 'source evidence';
  const summary = addText(details, 'summary', editing ? `Edit ${checkedItem} check` : 'Set up a practice check');
  addText(details, 'p', editingVisit
    ? 'Changing the provider, service, reference or booking window requires fresh permissions.' : editing
    ? 'Changing the issuer or record reference requires fresh permission to read it.'
    : 'Confirm the details. You can review each permission after saving.');
  const form = document.createElement('form');
  form.noValidate = true;
  form.className = 'setup';
  const select = document.createElement('select');
  select.id = `capability-${record.id}`;
  addText(select, 'option', 'Watch for a receipt').value = 'receipt';
  addText(select, 'option', 'Reserve a free slot').value = 'visit';
  select.value = suggestion.capability ?? 'receipt';
  const fields = document.createElement('div');
  const submit = addText(form, 'button', editing ? `Save ${checkedItem} check` : 'Save agreed check');
  submit.type = 'submit';
  form.prepend(fields);
  if (!editing) {
    const typeLabel = addText(form, 'label', 'What should Relay do?');
    typeLabel.htmlFor = select.id;
    form.prepend(typeLabel, select);
  }
  const common = [['issuer', 'Issuer identifier'], ['subject', 'Record reference']];
  const variants = {
    receipt: [['type', 'Record type'], ['status', 'Required status']],
    visit: [['service', 'Service identifier']]
  };
  const bookingWindows = [['windowStart', 'Earliest'], ['windowEnd', 'Latest']];
  const initialCapability = select.value;
  const drafts = new Map();
  const formValues = () => Object.fromEntries(new FormData(form));
  let visibleCapability;
  function appendField(parent, name, label, type, value) {
    const tag = addText(parent, 'label', label);
    const input = document.createElement('input');
    input.id = `setup-${name}-${record.id}`;
    input.name = name;
    input.type = type;
    if (type === 'time') input.step = 'any';
    if (type === 'text') input.maxLength = 100;
    input.required = true;
    input.value = value;
    tag.htmlFor = input.id;
    parent.append(input);
    if (type !== 'text') {
      const readback = addText(parent, 'output', input.value);
      readback.className = 'booking-value';
      readback.setAttribute('aria-hidden', 'true');
      input.addEventListener('input', () => { readback.textContent = input.value; });
    }
  }
  function showFields() {
    visibleCapability = select.value;
    fields.replaceChildren();
    if (select.value === 'receipt' && sources.length) {
      addText(fields, 'p', sources.map(source => `${source.label} (${source.issuer})`).join(' · '));
    }
    for (const [name, label] of [...common, ...variants[select.value]]) {
      appendField(fields, name, label, 'text', suggestion[name] ?? (name === 'type' ? 'receipt' : ''));
    }
    if (select.value === 'visit') {
      for (const [name, label] of bookingWindows) {
        const { date, time } = bookingInputValue(suggestion[name]);
        appendField(fields, `${name}Date`, `${label} date`, 'date', date);
        appendField(fields, `${name}Time`, `${label} time (IST)`, 'time', time);
      }
    }
    const saved = drafts.get(visibleCapability);
    if (!saved) {
      const values = formValues();
      drafts.set(visibleCapability, { initial: JSON.stringify(values), values });
      return;
    }
    for (const [name, value] of Object.entries(saved.values)) {
      const input = form.elements.namedItem(name);
      input.value = value;
      if (input.type !== 'text') input.dispatchEvent(new Event('input'));
    }
  }
  select.addEventListener('change', () => {
    drafts.get(visibleCapability).values = formValues();
    showFields();
  });
  showFields();
  const discard = action(form, 'Discard changes', () => {
    drafts.clear();
    select.value = initialCapability;
    showFields();
    updateDraftState();
    details.open = false;
    summary.focus();
  });
  function updateDraftState() {
    drafts.get(visibleCapability).values = formValues();
    const dirty = select.value !== initialCapability || [...drafts.values()].some(draft => JSON.stringify(draft.values) !== draft.initial);
    discard.hidden = !dirty;
    onEdit(dirty, details);
  }
  discard.hidden = true;
  form.addEventListener('input', updateDraftState);
  form.addEventListener('change', updateDraftState);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = formValues();
    if (select.value === 'visit') {
      for (const [name] of bookingWindows) {
        const date = values[`${name}Date`];
        const time = values[`${name}Time`];
        const normalizedTime = time?.length === 5 ? `${time}:00` : time;
        delete values[`${name}Date`];
        delete values[`${name}Time`];
        values[name] = date && normalizedTime ? `${date}T${normalizedTime}+05:30` : '';
      }
    }
    run('setup', { ...values, capability: select.value, revision: record.revision }, submit);
  });
  details.append(form);
  panel.append(details);
}
