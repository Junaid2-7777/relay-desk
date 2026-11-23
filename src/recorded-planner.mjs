export function createRecordedPlanner(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Supply recorded planner entries.');
  const proposals = new Map();
  for (const entry of entries) {
    if (typeof entry?.note !== 'string' || !entry.note.trim() || !Object.hasOwn(entry, 'recordedProposal')) {
      throw new TypeError('A recorded planner entry needs a note and a proposal.');
    }
    const note = entry.note.trim();
    if (proposals.has(note)) throw new TypeError('The recorded planner has a duplicate note.');
    proposals.set(note, structuredClone(entry.recordedProposal));
  }

  return {
    mode: 'recorded-response',
    propose({ note } = {}) {
      const key = typeof note === 'string' ? note.trim() : '';
      if (!proposals.has(key)) throw new Error('No recorded proposal matches this note.');
      return structuredClone(proposals.get(key));
    }
  };
}
