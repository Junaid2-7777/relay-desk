const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dateReference = /\b(?:(this|next|last)\s+)?(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{4}-\d{2}-\d{2})\b/giu;
const quotedText = /"[^"]*"|“[^”]*”|‘[^’]*’|(?<![\p{L}\p{N}])'(?:[^']|(?<=\p{L})'(?=\p{L}))*'(?![\p{L}\p{N}])/gu;
const requestIntro = /^\s*(?:(?:please|help\s+me|(?:can|could|would|will)\s+you|(?:i|we)\s+(?:want|need|would\s+like)\s+(?:you\s+)?to)\s+)*/iu;
const checkRequest = /^(?:check|follow[\s-]+up|look\s+again|revisit)(?:\s+(?:again|back|in|it|this))*(?:\s+on|\s+(?:(?:on|for)\s+)?(?:the|my|our)\s+(?:[\p{L}\p{N}'-]+\s+){1,4}on)?\s+$/iu;
const clauseConnector = /^\s*(?:and|but|so)\s+/iu;
const reportingCue = /\b(?:(?:said|says|told|wrote|replied|asked|asks|reads|reported|instructed|suggested|advised|reminded|warned)(?:\s+(?:to|me|us|you|again))*(?:\s*:|\s*$)|(?:message|instructions?|note|notice|email|text|letter)\s*:)/iu;
const dateListSeparator = /^\s*(?:(?:morning|afternoon|evening|night)\b\s*)?(?:[,/–—-]|,?\s*(?:and(?:\s+then)?|or(?:\s+else)?|to|through|then)(?:\s+on)?)\s*$/iu;
const bookingRequest = /^(?:book|reserve|schedule)\s+(?:(?:me|us)\s+(?:for\s+)?)?(?:a|an|one|the|my|our)\s+/iu;
const bookingDetails = /[,:]|\s+(?:about|and|or|for|from|of|at|on|with|to|between|before|after|(?:this|next)\s+(?:morning|afternoon|evening|week|month))\b/iu;
const nonSlotObject = /\b(?:alarm|alert|book|cop(?:y|ie)|e-?mail|follow[\s-]+up|message|notification|payment|reminder|text|transfer)s?$/iu;
const bookingRefusal = /\b(?:do\s+not|don['’]t|never|not\s+to)\s+(?:actually\s+)?(?:book|reserve|schedule)\b/iu;
const referenceLabel = /\b(?:reference(?:[ \t]+(?:number|id))?|ref|id)\b\.?[ \t]*(?:[:#][ \t]*)?(?!(?:id|number|not|missing|unknown)\b)([a-z0-9][a-z0-9._:-]*)/giu;

function noteSentences(note) {
  return note.replace(quotedText, quote => /[.!?].$/u.test(quote) ? '. ' : ' ')
    .replace(/:[ \t]*[\r\n]+\s*/gu, ': ').split(/[.!?;\r\n]+/u);
}

function requestsBooking(note) {
  const sentences = noteSentences(note);
  if (sentences.some(sentence => bookingRefusal.test(sentence))) return false;
  return sentences.some(sentence => {
    const request = sentence.replace(requestIntro, '');
    if (!bookingRequest.test(request)) return false;
    const [object] = request.replace(bookingRequest, '').split(bookingDetails, 1);
    const item = object.replace(dateReference, '').trim();
    return /\p{L}/u.test(item) && !nonSlotObject.test(item);
  });
}

function calendarDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === day ? date : null;
}

function startsCheckRequest(prefix) {
  const clauses = prefix.split(',');
  const request = clauses.pop().replace(clauseConnector, '').replace(requestIntro, '');
  return checkRequest.test(request) && !clauses.some(clause => reportingCue.test(clause));
}

function requestedCheckDate(note, today) {
  const start = calendarDay(today);
  if (!start) return null;

  const dates = new Set();
  for (const sentence of noteSentences(note)) {
    let previousDateEnd = null;
    for (const reference of sentence.matchAll(dateReference)) {
      const inDateList = previousDateEnd !== null && dateListSeparator.test(sentence.slice(previousDateEnd, reference.index));
      if (!inDateList && !startsCheckRequest(sentence.slice(0, reference.index))) continue;
      previousDateEnd = reference.index + reference[0].length;

      const modifier = reference[1]?.toLowerCase();
      if (modifier === 'next' || modifier === 'last') return null;

      const day = reference[2].toLowerCase();
      if (/^\d/u.test(day)) {
        if (!calendarDay(day)) return null;
        dates.add(day);
        continue;
      }

      const date = new Date(start);
      const weekday = weekdays.indexOf(day);
      const offset = weekday < 0 ? Number(day === 'tomorrow') : (weekday - start.getUTCDay() + 7) % 7;
      date.setUTCDate(start.getUTCDate() + offset);
      const candidate = date.toISOString().slice(0, 10);
      if (!calendarDay(candidate)) return null;
      dates.add(candidate);
    }
  }

  return dates.size === 1 ? [...dates][0] : null;
}

export function previewErrand(note, today) {
  const request = note.trim();
  const kind = /\brefund(?:s|ed|ing)?\b/i.test(request) ? 'refund' : 'errand';
  return {
    kind,
    goal: kind === 'refund' ? 'Check for my refund' : request.replace(/\s+/gu, ' '),
    checkDate: requestedCheckDate(request, today),
  };
}

export function suggestPracticePlan(note, sources) {
  const lower = note.toLowerCase();
  const subjects = new Set(Array.from(note.matchAll(referenceLabel), match => match[1].replace(/[.:]+$/u, '')));
  const [reference] = subjects;
  const subject = subjects.size === 1 && reference.length <= 100 ? reference : '';
  if (requestsBooking(note)) return { capability: 'visit', subject };

  const issuers = sources.filter(source => lower.includes(source.label.toLowerCase()));
  const expected = /\b(?:until|once|proof\s+that|confirmation\s+that)\b[^.!?]{0,70}\b(closed|approved|confirmed|issued|rejected|completed)\b/u.exec(lower);
  return {
    capability: 'receipt',
    issuer: issuers.length === 1 ? issuers[0].issuer : '',
    subject,
    type: 'receipt',
    status: expected?.[1] ?? ''
  };
}
