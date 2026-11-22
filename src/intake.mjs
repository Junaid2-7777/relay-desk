const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const dateReference = /\b(?:(this|next|last)\s+)?(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
const checkRequest = /\b(?:check|follow[\s-]+up|look\s+again|revisit)(?:\s+(?:again|back|in|it))*(?:\s+on|\s+(?:on\s+)?(?:the|my|our)\s+(?:[\p{L}\p{N}'-]+\s+){1,4}on)?\s+$/iu;

function requestedCheckDate(note, today) {
  const start = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== today) return null;

  const offsets = new Set();
  for (const sentence of note.split(/[.!?;\r\n]+/u)) {
    let requested = false;
    for (const reference of sentence.matchAll(dateReference)) {
      requested ||= checkRequest.test(sentence.slice(0, reference.index));
      if (!requested) continue;

      const modifier = reference[1]?.toLowerCase();
      if (modifier === 'next' || modifier === 'last') return null;

      const day = reference[2].toLowerCase();
      if (day === 'today') offsets.add(0);
      else if (day === 'tomorrow') offsets.add(1);
      else offsets.add((weekdays.indexOf(day) - start.getUTCDay() + 7) % 7);
    }
  }

  if (offsets.size !== 1) return null;
  const [offset] = offsets;
  start.setUTCDate(start.getUTCDate() + offset);
  return start.toISOString().slice(0, 10);
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
