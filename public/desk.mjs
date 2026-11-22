import { action, addText, fact, renderHousehold, reviewNeeded, statusLabel } from './household.mjs';

const element = id => document.getElementById(id);
const intake = element('intake');
const review = element('review');
const noteInput = element('note');
const goalInput = element('goal');
const checkInput = element('check-date');
const errands = element('errands');
const errorMessage = element('intake-error');
const statusMessage = element('intake-status');
const checkpointButton = element('checkpoint');
const checkpointStatus = element('checkpoint-status');
const format = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
});
const activityFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
});
let records = [];
let reviewedNote;
let saveRequestId;
let deskTime;
let householdMode = false;
let checking = false;
const openEdits = new Set();
const localDrafts = new Map();

const dateLabel = value => format.format(new Date(value));

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('The desk could not be reached. Check that Relay Desk is running and try again.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function validate(fields, message) {
  for (const [field, errorText] of fields) {
    field.removeAttribute('aria-invalid');
    const invalid = field.required ? !field.value.trim() : field.validity.badInput;
    if (!invalid) continue;
    field.setAttribute('aria-invalid', 'true');
    message.textContent = errorText;
    field.focus();
    return false;
  }
  return true;
}

function renderRefund(panel, record, update, errorMessage, setBusy) {
  const details = document.createElement('details');
  details.className = 'source evidence';
  addText(details, 'summary', 'Refund evidence and access');
  if (record.evidence.length) {
    const receipt = record.evidence[0];
    addText(details, 'p', `Posted credit ${receipt.reference} · ${activityFormat.format(new Date(receipt.postedAt))}`);
  }
  const sources = [
    ['merchant', 'Shop thread', 'Read messages about this return.'],
    ['credits', 'Incoming credits', 'Read incoming credits linked to this return on the practice ledger.']
  ];
  const buttons = [];
  const active = grant => grant?.status === 'allowed' && Date.parse(grant.expiresAt) > Date.parse(deskTime);
  const run = async (endpoint, body, current) => {
    errorMessage.textContent = '';
    buttons.forEach(button => { button.disabled = true; });
    setBusy(true);
    try {
      const result = await request(`/api/errands/${record.id}/${endpoint}`, { method: 'POST', body });
      update(result);
    } catch (error) {
      errorMessage.textContent = error.message;
      buttons.forEach(button => { button.disabled = false; });
      setBusy(false);
      current.focus();
    }
  };

  for (const [key, label, scope] of sources) {
    const grant = record.refundAccess[key];
    const section = document.createElement('section');
    section.className = 'permission';
    addText(section, 'h4', label);
    addText(section, 'p', scope);
    const availability = {
      allowed: active(grant) ? `Allowed until ${activityFormat.format(new Date(grant.expiresAt))} IST` : 'Access expired',
      declined: 'Access declined',
      withdrawn: 'Access withdrawn'
    };
    addText(section, 'p', availability[grant?.status] ?? 'Access available for seven days');
    const checked = record.checks[key];
    if (checked) {
      addText(section, 'p', `Last checked ${activityFormat.format(new Date(checked.checkedAt))} IST`);
      if (checked.lastEventAt) addText(section, 'p', `Last event ${activityFormat.format(new Date(checked.lastEventAt))} IST`);
    }
    if (key === 'merchant' && record.merchantEvent) {
      addText(section, 'p', record.merchantEvent.type === 'promise' ? 'Shop promised the refund.' : 'Shop updated the return.');
    }
    const row = document.createElement('div');
    row.className = 'actions';
    const choose = (text, choice) => buttons.push(action(row, text, event =>
      run('refund-access', { source: key, choice, revision: record.revision }, event.currentTarget)));
    if (active(grant)) choose(`Withdraw ${label.toLowerCase()} access`, 'withdrawn');
    else {
      choose(`Allow ${label.toLowerCase()} access`, 'allowed');
      if (grant?.status !== 'declined') choose(`Decline ${label.toLowerCase()} access`, 'declined');
    }
    section.append(row);
    details.append(section);
  }
  panel.append(details);
  if (record.status !== 'verified' && Object.values(record.refundAccess).some(active)) {
    buttons.push(action(panel, 'Check refund sources', event => run('check-refund', {}, event.currentTarget)));
  }
}

function renderErrand(record) {
  const card = element('errand-template').content.firstElementChild.cloneNode(true);
  const part = name => card.querySelector(`[data-${name}]`);
  const { id, goal, note, kind, checkDate, merchantDeadline } = record;
  card.id = `errand-${id}`;
  card.dataset.revision = record.revision;
  part('goal').textContent = goal;
  part('goal').tabIndex = -1;
  part('goal').id = `goal-${id}`;
  card.setAttribute('aria-labelledby', part('goal').id);
  part('note').textContent = note;
  part('status').textContent = statusLabel(record);
  card.classList.toggle('review-needed', reviewNeeded(record));
  if (record.status === 'verified') card.querySelector('.ring').classList.add('verified');
  fact(part('facts'), 'Your check date', checkDate ? dateLabel(checkDate) : 'Choose when to check');
  if (kind === 'refund') {
    fact(part('facts'), 'Merchant deadline', merchantDeadline ? dateLabel(merchantDeadline) : 'Unknown');
  }
  const replaceCard = (result, showEvidence = false) => {
    records = records.map(item => item.id === id ? result : item);
    if (householdMode) showErrands();
    else card.replaceWith(renderErrand(result));
    const updated = element(card.id);
    if (showEvidence) {
      const panel = updated.querySelector('[data-evidence] details');
      panel.open = true;
      panel.querySelector('summary').focus();
    } else {
      updated.querySelector('h3').focus();
    }
  };
  if (record.refund) {
    fact(part('facts'), 'Return reference', record.refund.reference);
    renderRefund(part('evidence'), record, result => replaceCard(result, true), part('error'), busy => {
      part('edit').disabled = busy;
      part('draft').disabled = busy;
    });
  }
  if (record.visit || record.bill) {
    const panel = part('evidence');
    const source = part('note').closest('details');
    source.open = false;
    panel.after(source);
    const run = async (endpoint, body, current, advance = false) => {
      part('error').textContent = '';
      panel.disabled = true;
      part('edit').disabled = true;
      part('draft').disabled = true;
      try {
        const result = await request(`/api/errands/${id}/${endpoint}`, { method: 'POST', body });
        replaceCard(result, endpoint === 'household-access');
        if (advance) await checkErrands(id);
      } catch (error) {
        part('error').textContent = error.message;
        panel.disabled = false;
        part('edit').disabled = false;
        part('draft').disabled = false;
        current.focus();
      }
    };
    renderHousehold(panel, part('facts'), record, run, deskTime);
  }
  if (localDrafts.has(id)) part('extra').append(localDrafts.get(id));
  part('edit').addEventListener('click', () => {
    openEdits.add(id);
    checkpointButton.disabled = true;
    part('edit').disabled = true;
    part('draft').disabled = true;
    part('evidence').disabled = true;
    part('error').textContent = '';
    const form = element('edit-template').content.firstElementChild.cloneNode(true);
    const editedGoal = form.querySelector('[data-edit-goal]');
    const editedDate = form.querySelector('[data-edit-date]');
    editedGoal.id = `edit-goal-${id}`;
    editedDate.id = `edit-date-${id}`;
    form.querySelector('[data-goal-label]').htmlFor = editedGoal.id;
    form.querySelector('[data-date-label]').htmlFor = editedDate.id;
    editedGoal.value = goal;
    editedDate.value = checkDate ?? '';
    form.querySelector('[data-cancel]').addEventListener('click', () => {
      form.remove();
      if (localDrafts.has(id)) part('extra').append(localDrafts.get(id));
      part('error').textContent = '';
      part('edit').disabled = false;
      part('draft').disabled = false;
      part('evidence').disabled = false;
      openEdits.delete(id);
      checkpointButton.disabled = checking || Boolean(openEdits.size);
      part('edit').focus();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      part('error').textContent = '';
      if (!validate([[editedGoal, 'Enter a goal.'], [editedDate, 'Choose a valid check date.']], part('error'))) return;
      const fields = form.querySelector('fieldset');
      fields.disabled = true;
      try {
        const result = await request(`/api/errands/${id}`, {
          method: 'PUT',
          body: { goal: editedGoal.value, checkDate: editedDate.value, revision: record.revision }
        });
        openEdits.delete(id);
        checkpointButton.disabled = checking || Boolean(openEdits.size);
        replaceCard(result);
      } catch (error) {
        part('error').textContent = error.message;
        fields.disabled = false;
        editedGoal.focus();
      }
    });
    part('extra').replaceChildren(form);
    editedGoal.focus();
  });
  part('draft').addEventListener('click', async () => {
    if (localDrafts.has(id)) {
      localDrafts.get(id).querySelector('textarea').focus();
      return;
    }
    part('error').textContent = '';
    const draftButton = part('draft');
    draftButton.disabled = true;
    part('edit').disabled = true;
    try {
      const { text } = await request(`/api/errands/${id}/draft`, { method: 'POST' });
      const panel = document.createElement('div');
      panel.className = 'draft';
      const label = document.createElement('label');
      const draft = document.createElement('textarea');
      draft.id = `draft-${id}`;
      draft.rows = 5;
      draft.value = text;
      label.htmlFor = draft.id;
      label.textContent = 'Local follow-up draft';
      panel.append(label, draft);
      localDrafts.set(id, panel);
      part('extra').replaceChildren(panel);
      draft.focus();
    } catch (error) {
      part('error').textContent = error.message;
    } finally {
      draftButton.disabled = false;
      part('edit').disabled = false;
    }
  });
  return card;
}

function showErrands() {
  if (records.length) {
    const prior = new Map([...errands.querySelectorAll('article')].map(card => [card.id, card]));
    const cards = records.map(record => {
      const existing = prior.get(`errand-${record.id}`);
      return [record, existing?.dataset.revision === String(record.revision) ? existing : renderErrand(record)];
    });
    if (!householdMode) {
      errands.replaceChildren(...cards.map(([, card]) => card));
      return;
    }
    const open = cards.filter(([record]) => record.status !== 'verified')
      .sort(([left], [right]) => Number(reviewNeeded(right)) - Number(reviewNeeded(left)) ||
        (left.checkDate ?? '9999-12-31').localeCompare(right.checkDate ?? '9999-12-31') || left.id.localeCompare(right.id))
      .map(([, card]) => card);
    const verified = cards.filter(([record]) => record.status === 'verified').map(([, card]) => card);
    if (verified.length) {
      const history = document.createElement('section');
      history.className = 'verified-receipts';
      addText(history, 'h3', 'Verified outcomes');
      history.append(...verified);
      open.push(history);
    }
    errands.replaceChildren(...open);
    return;
  }
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = 'Saved errands will appear here.';
  errands.replaceChildren(empty);
}

function showBrief({ today, now, errands: items, fixture, household }) {
  deskTime = now;
  element('today').dateTime = today;
  element('today').textContent = dateLabel(today);
  element('practice').hidden = !fixture;
  checkpointButton.hidden = !household;
  householdMode = household;
  if (household) {
    element('main').classList.add('household');
    const newErrand = intake.closest('section');
    const work = errands.closest('section');
    if (work.previousElementSibling === newErrand) newErrand.before(work);
  }
  records = items;
  showErrands();
}

async function load() {
  try {
    showBrief(await request('/api/desk'));
  } catch {
    const message = document.createElement('p');
    message.textContent = 'Your saved errands could not load.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', load);
    errands.replaceChildren(message, retry);
  }
}

async function checkErrands(focusId) {
  if (checking || openEdits.size) return;
  checking = true;
  checkpointButton.disabled = true;
  checkpointStatus.textContent = 'Checking your errands…';
  try {
    const result = await request('/api/checkpoint', { method: 'POST', body: {} });
    showBrief(result);
    checkpointStatus.textContent = result.conflicts.length ? 'Some errands changed during the check. Check again to update them.' : 'Errands checked.';
  } catch (error) {
    checkpointStatus.textContent = error.message;
  } finally {
    checking = false;
    checkpointButton.disabled = Boolean(openEdits.size);
    if (focusId) element(`errand-${focusId}`)?.querySelector('h3')?.focus();
    else if (document.activeElement === document.body) checkpointButton.focus();
  }
}

checkpointButton.addEventListener('click', () => checkErrands());

intake.addEventListener('submit', async event => {
  event.preventDefault();
  errorMessage.textContent = '';
  statusMessage.textContent = '';
  if (!validate([[noteInput, 'Enter an errand.']], errorMessage)) return;
  const note = noteInput.value.trim();
  const fields = element('intake-fields');
  fields.disabled = true;
  try {
    const { goal, checkDate } = await request('/api/errands/preview', { method: 'POST', body: { note } });
    reviewedNote = note;
    saveRequestId = crypto.randomUUID();
    element('review-note').textContent = note;
    goalInput.value = goal;
    checkInput.value = checkDate ?? '';
    intake.hidden = true;
    review.hidden = false;
    goalInput.focus();
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

element('back').addEventListener('click', () => {
  errorMessage.textContent = '';
  review.hidden = true;
  intake.hidden = false;
  noteInput.focus();
});

review.addEventListener('submit', async event => {
  event.preventDefault();
  errorMessage.textContent = '';
  if (!validate([[goalInput, 'Enter a goal.'], [checkInput, 'Choose a valid check date.']], errorMessage)) return;
  const fields = element('review-fields');
  fields.disabled = true;
  try {
    const record = await request('/api/errands', {
      method: 'POST',
      body: { note: reviewedNote, goal: goalInput.value, checkDate: checkInput.value, requestId: saveRequestId }
    });
    records = [record, ...records.filter(item => item.id !== record.id)];
    showErrands();
    review.hidden = true;
    intake.reset();
    intake.hidden = false;
    statusMessage.textContent = 'Errand saved.';
    element(`errand-${record.id}`).querySelector('h3').focus();
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    fields.disabled = false;
  }
});

await load();
