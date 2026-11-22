const activity = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
});

export const when = timestamp => activity.format(new Date(timestamp));

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

export const reviewNeeded = record => record.status !== 'stopped' &&
  (record.issue === 'bill-review' || record.issue === 'calendar-conflict');

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

function renderAccess(panel, record, run, deskTime) {
  const entries = permissions(record);
  if (!entries.length) return;
  const details = document.createElement('details');
  details.className = 'source evidence';
  addText(details, 'summary', 'Permissions');
  for (const [operation, label, description] of entries) {
    const grant = record.grants[operation];
    const active = grant?.status === 'allowed' && Date.parse(grant.expiresAt) > Date.parse(deskTime);
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

function renderBill(panel, list, record, run) {
  const { invoice, previousInvoice, capMinor, bill, payment, settlement } = record;
  if (previousInvoice) fact(list, 'Previous invoice', money(previousInvoice.amountMinor, previousInvoice.currency));
  if (invoice) {
    fact(list, 'Current invoice', money(invoice.amountMinor, invoice.currency));
    fact(list, 'Invoice', `${invoice.invoiceId} · revision ${invoice.revision}`);
    fact(list, 'Payee', `${invoice.payeeLabel} · ${invoice.payee}`);
  }
  fact(list, 'Standing limit', money(capMinor, bill.currency));
  if (reviewNeeded(record) && invoice) {
    const approved = record.approval?.status === 'allowed';
    addText(panel, 'p', approved
      ? 'One-time payment approved. Check your errands to apply it.'
      : `A one-time payment applies to this invoice revision. Your standing limit stays at ${money(capMinor, bill.currency)}.`);
    if (!approved) {
      const choices = document.createElement('div');
      choices.className = 'actions';
      action(choices, `Pay ${money(invoice.amountMinor, invoice.currency)} once`, event =>
        run('bill-choice', { choice: 'approve', revision: record.revision }, event.currentTarget, true)).className = 'primary';
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
  if (record.bill) renderBill(panel, list, record, run);
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
  }
  if (record.status !== 'stopped') renderAccess(panel, record, run, deskTime);
}

export function renderPracticeSetup(panel, record, sources, run) {
  const details = document.createElement('details');
  details.className = 'source evidence';
  addText(details, 'summary', 'Set up a practice check');
  addText(details, 'p', 'Confirm the details. You can review each permission after saving.');
  const form = document.createElement('form');
  form.noValidate = true;
  form.className = 'setup';
  const typeLabel = addText(form, 'label', 'What should Relay do?');
  const select = document.createElement('select');
  select.id = `capability-${record.id}`;
  typeLabel.htmlFor = select.id;
  addText(select, 'option', 'Watch for a receipt').value = 'receipt';
  addText(select, 'option', 'Reserve a free slot').value = 'visit';
  select.value = record.practicePlan.capability;
  const fields = document.createElement('div');
  const submit = addText(form, 'button', 'Save agreed check');
  submit.type = 'submit';
  form.prepend(typeLabel, select, fields);
  const common = [['issuer', 'Issuer identifier'], ['subject', 'Record reference']];
  const variants = {
    receipt: [['type', 'Record type'], ['status', 'Required status']],
    visit: [['service', 'Service identifier'], ['windowStart', 'Earliest time (IST)', 'datetime-local'],
      ['windowEnd', 'Latest time (IST)', 'datetime-local']]
  };
  function showFields() {
    fields.replaceChildren();
    if (select.value === 'receipt' && sources.length) {
      addText(fields, 'p', sources.map(source => `${source.label} (${source.issuer})`).join(' · '));
    }
    for (const [name, label, type = 'text'] of [...common, ...variants[select.value]]) {
      const tag = addText(fields, 'label', label);
      const input = document.createElement('input');
      input.id = `setup-${name}-${record.id}`;
      input.name = name;
      input.type = type;
      input.maxLength = 100;
      input.required = true;
      input.value = record.practicePlan[name] ?? (name === 'type' ? 'receipt' : '');
      tag.htmlFor = input.id;
      fields.append(input);
    }
  }
  select.addEventListener('change', showFields);
  showFields();
  form.addEventListener('submit', event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    for (const name of ['windowStart', 'windowEnd']) {
      if (values[name]) values[name] += values[name].length === 16 ? ':00+05:30' : '+05:30';
    }
    run('setup', { ...values, capability: select.value, revision: record.revision }, submit);
  });
  details.append(form);
  panel.append(details);
}
