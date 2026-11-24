import { grantActiveAt, grantStateAt, orderChecks, reviewNeeded } from '../shared/brief-order.mjs';
import { evidenceInstant } from '../shared/evidence-time.mjs';
import { action, addText, fact, renderHousehold, renderPracticeSetup, statusLabel } from './household.mjs';

const element = id => document.getElementById(id);
const intake = element('intake');
const intakeFields = element('intake-fields');
const review = element('review');
const noteInput = element('note');
const goalInput = element('goal');
const checkInput = element('check-date');
const errands = element('errands');
const errorMessage = element('intake-error');
const statusMessage = element('intake-status');
const checkpointButton = element('checkpoint');
const checkpointStatus = element('checkpoint-status');
const addErrand = element('add-errand');
const format = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
});
const activityFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata'
});
const updateTimeFormat = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const plannerLabels = new Map([
  ['recorded-response', 'Recorded responses'],
  ['n8n', 'n8n planner']
]);
let records = [];
let reviewedNote;
let saveRequestId;
let reviewId;
let deskTime;
let deskDay;
let deskContext;
let pagePlannerMode;
let householdMode = false;
let privateDesk = false;
let receiptSources = [];
let checking = false;
const openEdits = new Set();
const localDrafts = new Map();
const localUpdates = new Map();
const pendingCheckpoints = new Map();
const editReminder = 'Finish editing your errand before checking.';

function updateCheckpointButton() {
  checkpointButton.disabled = checking || Boolean(openEdits.size);
  if (householdMode && openEdits.size && !checking) checkpointStatus.textContent = editReminder;
  else if (checkpointStatus.textContent === editReminder) checkpointStatus.textContent = '';
}

const dateLabel = value => format.format(new Date(value));

async function request(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(deskContext === undefined ? {} : { 'X-Relay-Desk': deskContext })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new Error('The desk could not be reached. Check that Relay Desk is running and try again.');
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { code: result.code, status: response.status });
  if (path === '/api/desk' || path === '/api/checkpoint') {
    if (typeof result.deskContext !== 'string' || !result.deskContext ||
        (deskContext !== undefined && result.deskContext !== deskContext)) {
      throw new Error('The desk changed. Reload the page before continuing.');
    }
    deskContext ??= result.deskContext;
  }
  return result;
}

async function requestCheckpoint(path) {
  const key = `${deskContext}:${path}`;
  const checkpointId = pendingCheckpoints.get(key) ?? crypto.randomUUID();
  pendingCheckpoints.set(key, checkpointId);
  const result = await request(path, { method: 'POST', body: { checkpointId } });
  pendingCheckpoints.delete(key);
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

function restoreFocus(control) {
  if (document.activeElement === document.body) control?.focus();
}

function renderPrivateUpdates(panel, record, cardControls, replaceCard) {
  const { id, status } = record;
  const path = `/api/errands/${id}/updates`;
  const state = localUpdates.get(id) ?? { open: false, text: '', requestId: null };
  localUpdates.set(id, state);

  const details = document.createElement('details');
  details.className = 'source updates';
  const summary = addText(details, 'summary', 'Your follow-up updates');
  addText(details, 'p', 'Your words, saved on this computer.');
  const history = document.createElement('ol');
  history.hidden = true;
  details.append(history);
  const message = addText(details, 'p', '');
  message.setAttribute('role', 'status');
  const failure = addText(details, 'p', '');
  failure.setAttribute('role', 'alert');
  const retry = action(details, 'Retry loading updates', () => load({ fromRetry: true }));
  retry.hidden = true;

  let form, input, save;
  let updates = [];
  let loadVersion = 0;
  let saving = false;

  function showHistory() {
    history.replaceChildren(...updates.map(({ text, recordedAt }) => {
      const entry = document.createElement('li');
      const at = evidenceInstant(recordedAt);
      if (Number.isFinite(at)) addText(entry, 'time', `${updateTimeFormat.format(at)} IST`).dateTime = recordedAt;
      addText(entry, 'p', text);
      return entry;
    }));
    history.hidden = updates.length === 0;
  }

  function showError(error) {
    message.textContent = '';
    failure.textContent = error.message;
    if (error.code !== 'desk-context-changed') return;
    updates = [];
    showHistory();
    state.text = '';
    state.requestId = null;
    if (form) {
      form.hidden = true;
      input.value = '';
    }
  }

  async function load({ fromRetry = false, saved = false } = {}) {
    const version = ++loadVersion;
    const current = () => version === loadVersion && details.open && details.isConnected;
    retry.hidden = true;
    if (!saved) {
      updates = [];
      showHistory();
      if (form) form.hidden = true;
      message.textContent = 'Loading your updates…';
    }
    failure.textContent = '';
    try {
      const loaded = await request(path);
      if (!current()) return;
      updates = loaded.updates;
      showHistory();
      if (form) form.hidden = false;
      message.textContent = saved ? 'Update saved on this computer.' : updates.length ? '' : 'No follow-up updates yet.';
    } catch (error) {
      if (!current()) return;
      if (saved && error.code !== 'desk-context-changed') {
        message.textContent = 'Update saved. Reopen your updates to refresh the history.';
        return;
      }
      showError(error);
      retry.hidden = error.code === 'desk-context-changed';
    } finally {
      if (fromRetry && current()) restoreFocus(retry.hidden ? summary : retry);
    }
  }

  if (status === 'open') {
    form = document.createElement('form');
    form.noValidate = true;
    form.hidden = true;
    input = document.createElement('textarea');
    input.id = `update-${id}`;
    input.rows = 3;
    input.maxLength = 2000;
    input.required = true;
    input.value = state.text;
    addText(form, 'label', 'New update').htmlFor = input.id;
    form.append(input);
    save = addText(form, 'button', 'Save update');
    save.type = 'submit';
    details.append(form);

    input.addEventListener('input', () => {
      if (state.text !== input.value) state.requestId = null;
      state.text = input.value;
      input.removeAttribute('aria-invalid');
      failure.textContent = '';
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || form.hidden) return;
      if (!validate([[input, 'Enter an update.']], failure)) return;
      state.requestId ??= crypto.randomUUID();
      const locked = cardControls.filter(control => !control.disabled);
      locked.forEach(control => { control.disabled = true; });
      saving = true;
      save.disabled = true;
      input.readOnly = true;
      message.textContent = 'Saving update…';
      failure.textContent = '';
      let nextFocus = save;
      try {
        const added = await request(path, { method: 'POST', body: { requestId: state.requestId, text: state.text } });
        if (!updates.some(update => update.id === added.id)) updates.push(added);
        showHistory();
        state.requestId = null;
        input.value = state.text = '';
        message.textContent = 'Update saved on this computer.';
        nextFocus = input;
        if (details.open) await load({ saved: true });
        if (form.hidden) nextFocus = summary;
      } catch (error) {
        showError(error);
        if (error.status === 409 && error.code !== 'desk-context-changed') {
          try {
            const { errands } = await request('/api/desk');
            const current = errands.find(item => item.id === id);
            if (current && current.status !== status && details.isConnected) replaceCard(current);
          } catch (refreshError) {
            if (refreshError.code === 'desk-context-changed') showError(refreshError);
          }
        }
        if (form.hidden) nextFocus = summary;
      } finally {
        saving = false;
        save.disabled = false;
        input.readOnly = false;
        locked.forEach(control => { control.disabled = false; });
        if (details.open && document.activeElement === save) nextFocus.focus();
        else if (details.open) restoreFocus(nextFocus);
      }
    });
  } else if (status === 'stopped') addText(details, 'p', 'Resume tracking to add an update.');

  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    state.open = details.open;
    if (details.open && !saving) load();
    else loadVersion++;
  });
  panel.append(details);
  details.open = state.open;
}

function renderPrivateDraftSave(panel, draft, state, read, write, cardControls) {
  const terms = state.editable;
  const hint = addText(panel, 'p', 'Choose Save draft to keep these words on this computer. You can copy the text at any time.');
  hint.id = `${draft.id}-hint`;
  hint.className = 'hint';
  draft.setAttribute('aria-describedby', hint.id);
  draft.maxLength = 8000;
  const message = addText(panel, 'p', '');
  message.setAttribute('role', 'status');
  const comparison = document.createElement('div');
  panel.append(comparison);

  function useVersion(saved, text = saved.text) {
    state.savedText = saved.text;
    terms.draftRevision = saved.draftRevision;
    terms.text = draft.value = text;
    state.draftConflict = null;
    state.message = '';
    comparison.replaceChildren();
  }

  function showConflict() {
    const saved = state.draftConflict;
    if (!saved) return null;
    const details = document.createElement('details');
    details.className = 'source evidence';
    details.open = true;
    addText(details, 'summary', 'Compare drafts');
    const latest = document.createElement('textarea');
    latest.id = `${draft.id}-latest`;
    latest.rows = 4;
    latest.readOnly = true;
    latest.value = saved.text;
    addText(details, 'label', 'Draft saved in another tab').htmlFor = latest.id;
    details.append(latest);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const choose = (label, text) => action(actions, label, () => {
      useVersion(saved, text());
      update();
      draft.focus();
    });
    choose('Use saved draft', () => saved.text);
    choose('Keep my edits', () => draft.value);
    details.append(actions);
    comparison.replaceChildren(details);
    return latest;
  }

  const save = action(panel, 'Save draft', async () => {
    const locked = cardControls.filter(control => !control.disabled);
    locked.forEach(control => { control.disabled = true; });
    save.disabled = true;
    draft.readOnly = true;
    message.textContent = 'Saving draft…';
    let conflictFocus;
    try {
      useVersion(await write({ text: draft.value, draftRevision: terms.draftRevision }));
    } catch (error) {
      state.message = error.message;
      if (error.code === 'local-draft-conflict') {
        try {
          state.draftConflict = await read();
          state.message = 'Another tab saved a newer draft. Compare it with your edits.';
          conflictFocus = showConflict();
        } catch {
          state.message = 'Another tab saved a newer draft. Try Save draft again to compare it.';
        }
      }
    } finally {
      locked.forEach(control => { control.disabled = false; });
      draft.readOnly = false;
      update();
      restoreFocus(conflictFocus ?? (save.disabled ? draft : save));
    }
  });

  function update() {
    const dirty = draft.value !== state.savedText;
    save.disabled = Boolean(state.draftConflict) || !draft.value.trim() || (!dirty && terms.draftRevision > 0);
    message.textContent = state.message || (dirty ? 'Unsaved draft changes.' :
      terms.draftRevision > 0 ? 'Draft saved on this computer.' : 'Draft ready to edit or copy.');
  }
  draft.addEventListener('input', () => {
    if (!state.draftConflict) state.message = '';
    update();
  });
  showConflict();
  update();
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
  const active = grant => grantActiveAt(grant, deskTime);
  const run = async (endpoint, current, body) => {
    errorMessage.textContent = '';
    buttons.forEach(button => { button.disabled = true; });
    setBusy(true);
    try {
      const path = `/api/errands/${record.id}/${endpoint}`;
      const result = endpoint === 'check-refund'
        ? await requestCheckpoint(path) : await request(path, { method: 'POST', body });
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
    const inactive = grantStateAt(grant, deskTime) === 'not-yet-active' ? 'Access starts later' : 'Access expired';
    const availability = {
      allowed: active(grant) ? `Allowed until ${activityFormat.format(new Date(grant.expiresAt))} IST` : inactive,
      declined: 'Access declined',
      withdrawn: 'Access withdrawn'
    };
    addText(section, 'p', availability[grant?.status] ?? 'Access available for seven days');
    const checked = record.checks[key];
    if (checked) {
      if (checked.status === 'unavailable') addText(section, 'p', 'Unable to check this source.');
      if (checked.checkedAt) addText(section, 'p', `Last successful check ${activityFormat.format(new Date(checked.checkedAt))} IST`);
      if (checked.lastEventAt) {
        const instant = evidenceInstant(checked.lastEventAt);
        addText(section, 'p', Number.isFinite(instant) ? `Last event ${activityFormat.format(instant)} IST` : 'Last event time unavailable.');
      }
    }
    if (key === 'merchant' && record.merchantEvent) {
      addText(section, 'p', record.merchantEvent.type === 'promise' ? 'Shop promised the refund.' : 'Shop updated the return.');
    }
    const row = document.createElement('div');
    row.className = 'actions';
    const choose = (text, choice) => buttons.push(action(row, text, event =>
      run('refund-access', event.currentTarget, { source: key, choice, revision: record.revision })));
    if (active(grant)) choose(`Withdraw ${label.toLowerCase()} access`, 'withdrawn');
    else {
      choose(`Allow ${label.toLowerCase()} access`, 'allowed');
      if (grant?.status !== 'declined') choose(`Decline ${label.toLowerCase()} access`, 'declined');
    }
    section.append(row);
    details.append(section);
  }
  panel.append(details);
  if (record.status !== 'verified' && record.status !== 'stopped' && Object.values(record.refundAccess).some(active)) {
    buttons.push(action(panel, 'Check refund sources', event => run('check-refund', event.currentTarget)));
  }
}

function renderErrand(record, accessState) {
  const card = element('errand-template').content.firstElementChild.cloneNode(true);
  const part = name => card.querySelector(`[data-${name}]`);
  const { id, goal, note, kind, checkDate, merchantDeadline } = record;
  card.id = `errand-${id}`;
  card.dataset.revision = record.revision;
  card.dataset.day = deskDay;
  card.dataset.pendingFollowup = Boolean(record.pendingFollowup);
  card.dataset.visitPlanEditable = Boolean(record.visitPlanEditable);
  card.dataset.accessState = accessState;
  part('goal').textContent = goal;
  part('goal').tabIndex = -1;
  part('goal').id = `goal-${id}`;
  card.setAttribute('aria-labelledby', part('goal').id);
  part('note').textContent = note;
  const reviewing = reviewNeeded(record, deskTime);
  part('status').textContent = statusLabel(record, deskTime);
  card.classList.toggle('review-needed', reviewing);
  if (record.status === 'verified') card.querySelector('.ring').classList.add('verified');
  const due = !householdMode && record.status === 'open' && checkDate && checkDate <= deskDay;
  const dateTitle = due ? (checkDate === deskDay ? 'Check today' : 'Check overdue') : 'Your check date';
  const billReview = record.bill && record.invoice && reviewing;
  const dates = billReview ? document.createElement('dl') : part('facts');
  if (billReview) dates.className = 'facts';
  fact(dates, dateTitle, checkDate ? dateLabel(checkDate) : 'Choose when to check');
  if (due && kind === 'refund') fact(part('facts'), 'What to check', 'Look for the posted credit for this return.');
  if (kind === 'refund') {
    fact(part('facts'), 'Merchant deadline', merchantDeadline ? dateLabel(merchantDeadline) : 'Unknown');
  }
  const replaceCard = (result, showEvidence = false) => {
    openEdits.delete(`setup-${id}`);
    updateCheckpointButton();
    const current = records.find(item => item.id === id);
    if (current?.pendingFollowup && result.pendingFollowup === undefined && !result.queuedFollowup) {
      result = { ...result, pendingFollowup: true };
    }
    records = records.map(item => item.id === id ? result : item);
    showErrands(id);
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
    if (record.queuedFollowup) fact(part('facts'), 'Follow-up', 'Queued in the practice outbox');
    else if (record.pendingFollowup) fact(part('facts'), 'Follow-up', 'Queue confirmation pending');
    if (record.status !== 'stopped') renderRefund(part('evidence'), record, result => replaceCard(result, true), part('error'), busy => {
      part('edit').disabled = busy;
      part('draft').disabled = busy;
      part('tracking').disabled = busy;
    });
  }
  const canSetUp = Object.hasOwn(record, 'practicePlan') && record.status === 'open';
  if (record.visit || record.bill || record.receiptPlan || canSetUp) {
    const panel = part('evidence');
    const source = part('note').closest('details');
    if (record.visit || record.bill) {
      source.open = false;
      panel.after(source);
      if (billReview) panel.after(dates);
    }
    const run = async (endpoint, body, current, advance = false) => {
      part('error').textContent = '';
      panel.disabled = true;
      part('edit').disabled = true;
      part('draft').disabled = true;
      part('tracking').disabled = true;
      try {
        const result = await request(`/api/errands/${id}/${endpoint}`, { method: 'POST', body });
        replaceCard(result, endpoint === 'household-access');
        if (advance) await checkErrands(id);
      } catch (error) {
        part('error').textContent = error.message;
        panel.disabled = false;
        part('edit').disabled = openEdits.has(`setup-${id}`);
        part('draft').disabled = part('edit').disabled;
        part('tracking').disabled = part('edit').disabled;
        current.focus();
      }
    };
    if (!canSetUp) renderHousehold(panel, part('facts'), record, run, deskTime);
    if (canSetUp || (record.receiptPlan && record.status === 'open') || record.visitPlanEditable) {
      renderPracticeSetup(panel, record, receiptSources, run, (dirty, details) => {
        const key = `setup-${id}`;
        if (dirty) openEdits.add(key);
        else openEdits.delete(key);
        updateCheckpointButton();
        for (const button of [part('edit'), part('draft'), part('tracking'), ...panel.querySelectorAll('button')]) {
          if (!details.contains(button)) button.disabled = dirty;
        }
      });
    }
  }
  const trackingButton = part('tracking');
  trackingButton.hidden = record.status === 'verified';
  const stopped = record.status === 'stopped';
  if (stopped) trackingButton.textContent = 'Resume tracking';
  trackingButton.addEventListener('click', async () => {
    part('error').textContent = '';
    const controls = [trackingButton, part('edit'), part('draft'), part('evidence')];
    controls.forEach(control => { control.disabled = true; });
    try {
      const result = await request(`/api/errands/${id}/tracking`, {
        method: 'POST', body: { choice: stopped ? 'resume' : 'stop', revision: record.revision }
      });
      replaceCard(result);
    } catch (error) {
      part('error').textContent = error.message;
      controls.forEach(control => { control.disabled = false; });
      trackingButton.focus();
    }
  });

  const draftButton = part('draft');
  if (privateDesk) renderPrivateUpdates(part('evidence'), record, [part('edit'), draftButton, trackingButton], replaceCard);
  if (record.queuedFollowup) draftButton.textContent = 'Review queued follow-up';
  else if (record.pendingFollowup) draftButton.textContent = 'Review pending follow-up';
  const readDraft = () => request(`/api/errands/${id}/draft`, { method: 'POST' });
  async function readCurrentErrand() {
    return (await request('/api/desk')).errands.find(item => item.id === id);
  }

  function restoreDraft() {
    const state = localDrafts.get(id);
    if (!state) return;
    const pending = Boolean(record.pendingFollowup);
    const queued = Boolean(record.queuedFollowup);
    const terms = queued ? record.queuedFollowup : pending ? state.pending : state.editable;
    if (!terms) return;

    const panel = document.createElement('div');
    panel.className = 'draft';
    if (terms.recipient) {
      const envelope = document.createElement('dl');
      envelope.className = 'facts';
      fact(envelope, 'Recipient', terms.recipient);
      fact(envelope, 'Subject', terms.subject);
      panel.append(envelope);
    }
    const title = queued ? 'Queued follow-up' : pending ? 'Original pending follow-up' : 'Local follow-up draft';
    const label = addText(panel, 'label', title);
    const draft = document.createElement('textarea');
    draft.id = `draft-${id}`;
    draft.rows = 5;
    draft.value = terms.text;
    draft.readOnly = pending || queued;
    label.htmlFor = draft.id;
    if (!draft.readOnly) draft.addEventListener('input', () => { terms.text = draft.value; });
    panel.append(draft);
    part('extra').replaceChildren(panel);

    if (Number.isSafeInteger(terms.draftRevision) && !pending && !queued) {
      renderPrivateDraftSave(panel, draft, state, readDraft, body =>
        request(`/api/errands/${id}/local-draft`, { method: 'PUT', body }), [draftButton, part('edit'), trackingButton]);
      return draft;
    }

    if (pending) addText(panel, 'p', 'Check the practice outbox for these exact words.');
    const message = addText(panel, 'p', state.message);
    message.setAttribute('role', 'status');
    if (pending || (terms.recipient && record.status === 'open' && !queued)) {
      const submit = action(panel, pending ? 'Check practice outbox' : 'Queue this draft in practice outbox', async () => {
        const controls = [submit, draftButton, part('edit'), trackingButton, part('evidence')]
          .filter(control => !control.disabled);
        controls.forEach(control => { control.disabled = true; });
        draft.readOnly = true;
        message.textContent = pending ? 'Checking the original draft…' : 'Checking before queuing…';
        try {
          const result = await request(`/api/errands/${id}/queue-followup`, {
            method: 'POST', body: { revision: record.revision, recipient: terms.recipient, subject: terms.subject,
              text: draft.value, ...(pending ? { reconcileOnly: true } : {}) }
          });
          if (result.queuedFollowup) {
            state.pending = null;
            state.message = 'Draft queued in the practice outbox.';
          } else if (result.followupReconciliation === 'not-queued') {
            state.editable ??= state.pending;
            state.pending = null;
            state.message = 'The practice outbox has no entry for this draft.';
          } else {
            state.message = result.status === 'verified'
              ? 'Credit verified. You can keep this draft.' : 'Check refund sources before queuing again.';
          }
          replaceCard(result);
        } catch (error) {
          if (!pending) {
            try {
              const current = await readCurrentErrand();
              if (current?.pendingFollowup) {
                const original = await readDraft();
                if (original.pendingFollowup) state.pending = original;
              }
              if (current?.queuedFollowup || (current?.pendingFollowup && state.pending)) {
                state.message = '';
                replaceCard(current);
                return;
              }
            } catch {
              // Keep the editable copy while the desk cannot read the journal.
            }
          }
          state.message = error.message;
          message.textContent = state.message;
        } finally {
          controls.forEach(control => { control.disabled = false; });
          draft.readOnly = pending;
          restoreFocus(submit);
        }
      });
      submit.dataset.queue = '';
    }
    return draft;
  }
  restoreDraft();
  part('edit').addEventListener('click', () => {
    openEdits.add(id);
    updateCheckpointButton();
    part('edit').disabled = true;
    part('draft').disabled = true;
    trackingButton.disabled = true;
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
    const fields = form.querySelector('fieldset');
    const save = fields.querySelector('[type="submit"]');
    const changedDesk = 'The desk changed. Reopen the original desk at this address and try Save changes again.';
    let base = record;
    let conflict = null;

    function closeEdit(saved) {
      openEdits.delete(id);
      updateCheckpointButton();
      if (saved !== record) {
        replaceCard(saved);
        return;
      }
      form.remove();
      restoreDraft();
      part('error').textContent = '';
      part('edit').disabled = false;
      part('draft').disabled = false;
      trackingButton.disabled = false;
      part('evidence').disabled = false;
      part('edit').focus();
    }

    function compare(saved) {
      const details = document.createElement('details');
      details.className = 'source evidence';
      details.open = true;
      const summary = addText(details, 'summary', 'Compare errand details');
      const current = document.createElement('dl');
      current.className = 'facts';
      fact(current, 'Saved goal', saved.goal);
      fact(current, 'Saved check date', saved.checkDate ? dateLabel(saved.checkDate) : 'No check date');
      details.append(current);
      const choices = document.createElement('div');
      choices.className = 'actions';
      action(choices, 'Use saved errand', () => closeEdit(saved));
      action(choices, 'Keep my edits', () => {
        base = saved;
        conflict = null;
        details.remove();
        part('error').textContent = '';
        save.disabled = false;
        editedGoal.focus();
      });
      details.append(choices);
      save.parentElement.before(details);
      conflict = saved;
      save.disabled = true;
      return summary;
    }

    form.querySelector('[data-cancel]').addEventListener('click', () => closeEdit(conflict ?? base));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (fields.disabled || conflict) return;
      part('error').textContent = '';
      if (!validate([[editedGoal, 'Enter a goal.'], [editedDate, 'Choose a valid check date.']], part('error'))) return;
      fields.disabled = true;
      try {
        const result = await request(`/api/errands/${id}`, {
          method: 'PUT',
          body: { goal: editedGoal.value, checkDate: editedDate.value, revision: base.revision }
        });
        closeEdit(result);
      } catch (error) {
        part('error').textContent = privateDesk && error.code === 'desk-context-changed' ? changedDesk : error.message;
        let focus = editedGoal;
        if (privateDesk && error.code === 'errand-edit-conflict') {
          try {
            const saved = await readCurrentErrand();
            if (saved) {
              focus = compare(saved);
              part('error').textContent = 'Another tab saved newer errand details. Compare them with your edits.';
            }
          } catch (readError) {
            part('error').textContent = readError.code === 'desk-context-changed' ? changedDesk :
              'The errand changed. Try Save changes again to compare it with your edits.';
          }
        }
        fields.disabled = false;
        focus.focus();
      }
    });
    part('extra').replaceChildren(form);
    editedGoal.focus();
  });
  draftButton.addEventListener('click', async () => {
    const shown = part('extra').querySelector('.draft textarea');
    if (shown) {
      shown.focus();
      return;
    }
    part('error').textContent = '';
    draftButton.disabled = true;
    part('edit').disabled = true;
    trackingButton.disabled = true;
    try {
      const terms = record.queuedFollowup ?? await readDraft();
      const state = localDrafts.get(id) ?? { editable: null, pending: null, message: '' };
      if (terms.pendingFollowup) state.pending = terms;
      else if (!record.queuedFollowup && !state.editable) {
        state.editable = terms;
        state.savedText = terms.text;
      }
      localDrafts.set(id, state);
      if (Boolean(terms.pendingFollowup) !== Boolean(record.pendingFollowup)) {
        const current = await readCurrentErrand();
        if (current) replaceCard({ ...current, pendingFollowup: Boolean(current.pendingFollowup) });
      } else {
        restoreDraft()?.focus();
      }
    } catch (error) {
      part('error').textContent = error.message;
    } finally {
      draftButton.disabled = false;
      part('edit').disabled = false;
      trackingButton.disabled = false;
      restoreFocus(draftButton);
    }
  });
  return card;
}

function showErrands(changedId) {
  if (records.length) {
    const prior = new Map([...errands.querySelectorAll('article')].map(card => [card.id, card]));
    const ordered = orderChecks([...records], householdMode, deskTime);
    const cards = ordered.map(record => {
      const existing = prior.get(`errand-${record.id}`);
      const grants = Object.entries(record.refundAccess ?? record.grants ?? {});
      const accessState = [...grants, ['approval', record.approval]]
        .map(([operation, grant]) => `${operation}:${grantStateAt(grant, deskTime)}`).sort().join(' ');
      const reuse = record.id !== changedId && existing?.dataset.revision === String(record.revision) &&
        existing.dataset.day === deskDay && existing.dataset.pendingFollowup === String(Boolean(record.pendingFollowup)) &&
        existing.dataset.visitPlanEditable === String(Boolean(record.visitPlanEditable)) && existing.dataset.accessState === accessState;
      return [record, reuse ? existing : renderErrand(record, accessState)];
    });
    if (!householdMode) {
      errands.replaceChildren(...cards.map(([, card]) => card));
      return;
    }
    const open = cards.filter(([record]) => !['verified', 'stopped'].includes(record.status))
      .map(([, card]) => card);
    const verified = cards.filter(([record]) => record.status === 'verified').map(([, card]) => card);
    if (verified.length) {
      const history = document.createElement('section');
      history.className = 'verified-receipts';
      addText(history, 'h3', 'Verified outcomes');
      history.append(...verified);
      open.push(history);
    }
    const stopped = cards.filter(([record]) => record.status === 'stopped').map(([, card]) => card);
    if (stopped.length) {
      const history = document.createElement('section');
      history.className = 'verified-receipts';
      addText(history, 'h3', 'Stopped errands');
      history.append(...stopped);
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

function showBrief({ today, now, errands: items, fixture, household, plannerMode, receiptSources: sources = [] }) {
  const mode = plannerMode ?? 'fixed-rule';
  pagePlannerMode ??= mode;
  if (mode !== pagePlannerMode) throw new Error('The planner changed. Reload the desk to review where your note will go.');
  deskTime = now;
  deskDay = today;
  receiptSources = sources;
  element('today').dateTime = today;
  element('today').textContent = dateLabel(today);
  element('practice').hidden = !fixture;
  const plannerLabel = element('planner-mode');
  plannerLabel.hidden = !household;
  plannerLabel.textContent = plannerLabels.get(plannerMode) ?? 'Fixed rules';
  element('note-hint').textContent = plannerMode === 'n8n'
    ? 'Use a synthetic note. Reviewing it sends the note to the configured n8n workflow.'
    : 'Use your own words. The note is saved on this computer.';
  checkpointButton.hidden = !household;
  addErrand.hidden = !household;
  householdMode = household;
  privateDesk = !fixture && !household;
  if (household) {
    element('main').classList.add('household');
    const newErrand = intake.closest('section');
    const work = errands.closest('section');
    if (work.previousElementSibling === newErrand) newErrand.before(work);
  }
  records = items;
  showErrands();
}

async function load(retry) {
  if (retry) retry.disabled = true;
  try {
    showBrief(await request('/api/desk'));
    intakeFields.disabled = false;
    if (retry) restoreFocus(noteInput);
  } catch {
    if (retry) {
      retry.disabled = false;
      restoreFocus(retry);
      return;
    }
    const message = document.createElement('p');
    message.textContent = 'Your saved errands could not load.';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Try again';
    button.addEventListener('click', () => load(button));
    errands.replaceChildren(message, button);
  }
}

async function checkErrands(focusId) {
  if (checking || openEdits.size) return;
  checking = true;
  updateCheckpointButton();
  const controls = [...errands.querySelectorAll('[data-edit], [data-draft], [data-tracking], [data-evidence], [data-queue]')]
    .filter(control => !control.disabled);
  for (const control of controls) control.disabled = true;
  const before = new Map(records.map(record => [record.id, record]));
  checkpointStatus.textContent = 'Checking your errands…';
  try {
    const result = await requestCheckpoint('/api/checkpoint');
    // A save or action already in flight can return before this checkpoint response.
    const newer = new Map(records.filter(record => before.get(record.id) !== record).map(record => [record.id, record]));
    result.errands = result.errands.map(record => {
      const local = newer.get(record.id);
      newer.delete(record.id);
      return local?.revision > record.revision ? local : record;
    });
    result.errands.unshift(...newer.values());
    showBrief(result);
    checkpointStatus.textContent = result.conflicts.length ? 'Some errands changed during the check. Check again to update them.' : 'Errands checked.';
  } catch (error) {
    checkpointStatus.textContent = error.message;
  } finally {
    checking = false;
    for (const control of controls) control.disabled = false;
    updateCheckpointButton();
    if (focusId) element(`errand-${focusId}`)?.querySelector('h3')?.focus();
    else if (document.activeElement === document.body) checkpointButton.focus();
  }
}

checkpointButton.addEventListener('click', () => checkErrands());
addErrand.addEventListener('click', event => {
  event.preventDefault();
  (review.hidden ? noteInput : goalInput).focus();
});

function showReview() {
  intake.hidden = true;
  review.hidden = false;
  goalInput.focus();
}

intake.addEventListener('submit', async event => {
  event.preventDefault();
  if (intakeFields.disabled) return;
  errorMessage.textContent = '';
  statusMessage.textContent = '';
  if (!validate([[noteInput, 'Enter an errand.']], errorMessage)) return;
  const note = noteInput.value.trim();
  // Reopening the same private review keeps its fields and original save reference.
  if (!householdMode && note === reviewedNote) {
    showReview();
    return;
  }
  intakeFields.disabled = true;
  try {
    const { goal, checkDate, previewId, plannerStatus } = await request('/api/errands/preview', {
      method: 'POST', body: { note, plannerMode: pagePlannerMode }
    });
    reviewedNote = note;
    reviewId = previewId;
    if (plannerStatus === 'fallback') statusMessage.textContent = 'A local suggestion is ready to review.';
    saveRequestId = crypto.randomUUID();
    element('review-note').textContent = note;
    goalInput.value = goal;
    checkInput.value = checkDate ?? '';
    showReview();
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    intakeFields.disabled = false;
    restoreFocus(event.submitter);
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
      body: { note: reviewedNote, goal: goalInput.value, checkDate: checkInput.value, requestId: saveRequestId, previewId: reviewId, plannerMode: pagePlannerMode }
    });
    records = [record, ...records.filter(item => item.id !== record.id)];
    showErrands();
    review.hidden = true;
    intake.reset();
    reviewedNote = undefined;
    intake.hidden = false;
    statusMessage.textContent = 'Errand saved.';
    element(`errand-${record.id}`).querySelector('h3').focus();
  } catch (error) {
    errorMessage.textContent = error.message;
  } finally {
    fields.disabled = false;
    restoreFocus(event.submitter);
  }
});

await load();
