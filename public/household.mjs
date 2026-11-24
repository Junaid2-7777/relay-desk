import { reviewNeeded } from '../shared/brief-order.mjs';

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
  'calendar-conflict': 'The provider confirmed the visit. Your calendar has an overlapping commitment.',
  'bill-permission': 'Review access to check the bill and see which payments are covered.',
  'bill-deferred': 'You chose to leave this invoice unpaid.',
  'payment-unknown': 'Checking whether the payment went through.',
  'payment-pending': 'The biller accepted the payment. Settlement is pending.',
  'receipt-permission': 'Allow a check of this exact record when you are ready.',
  'receipt-pending': 'Waiting for the required receipt from the issuer.',
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
  if (previousInvoice) fact(list, 'Previous invoice', money(previousInvoice.amountMinor, previousInvoice.currency));
  if (invoice) {
    fact(list, 'Current invoice', money(invoice.amountMinor, invoice.currency));
    fact(list, 'Invoice', `${invoice.invoiceId} · revision ${invoice.revision}`);
    fact(list, 'Payee', `${invoice.payeeLabel} · ${invoice.payee}`);
  }
  fact(list, 'Standing limit', money(capMinor, bill.currency));
  if (reviewNeeded(record) && invoice) {
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
      choices.className = 'actions';
      if (canPay) {
        addText(panel, 'p', `A one-time payment applies to this invoice revision. Your standing limit stays at ${money(capMinor, bill.currency)}.`);
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

export function renderHousehold(panel, list, record, run, deskTime) {
  if (record.owner) fact(list, 'Responsible for this errand', record.owner);
  if (record.reservation) {
    fact(list, 'Booked for', `${when(record.reservation.start)} IST`);
    fact(list, 'Provider confirmation', record.reservation.id);
  }
  if (record.calendarEvent) fact(list, 'Calendar entry', 'Confirmed in the practice calendar');
  if (record.conflict) fact(list, 'Calendar conflict', `${when(record.conflict.start)} IST`);
  if (record.status !== 'stopped' && record.issue && issues[record.issue]) addText(panel, 'p', issues[record.issue]);
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
  const editing = Boolean(record.receiptPlan);
  const suggestion = record.receiptPlan ?? record.practicePlan ?? {};
  const details = document.createElement('details');
  details.className = 'source evidence';
  const summary = addText(details, 'summary', editing ? 'Edit receipt check' : 'Set up a practice check');
  addText(details, 'p', editing
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
  const submit = addText(form, 'button', editing ? 'Save receipt check' : 'Save agreed check');
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
  }
  select.addEventListener('change', showFields);
  showFields();
  const formValues = () => JSON.stringify([select.value, ...new FormData(form)]);
  const initial = formValues();
  const discard = action(form, 'Discard changes', () => {
    select.value = suggestion.capability ?? 'receipt';
    showFields();
    updateDraftState();
    details.open = false;
    summary.focus();
  });
  function updateDraftState() {
    const dirty = formValues() !== initial;
    discard.hidden = !dirty;
    onEdit(dirty, details);
  }
  discard.hidden = true;
  form.addEventListener('input', updateDraftState);
  form.addEventListener('change', updateDraftState);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
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
