export function openActionJournal(database, find, transaction, clock) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      key TEXT PRIMARY KEY,
      errandId TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      preparedAt TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS action_errand ON actions(errandId, operation);
  `);
  const get = database.prepare('SELECT * FROM actions WHERE key = ?');
  const latest = database.prepare(`
    SELECT * FROM actions WHERE errandId = ? AND operation = ?
    ORDER BY status IN ('prepared', 'unknown', 'committed', 'confirmed', 'recorded') DESC, rowid DESC LIMIT 1
  `);
  const insert = database.prepare("INSERT OR IGNORE INTO actions VALUES (?, ?, ?, ?, 'prepared', ?)");
  const reopen = database.prepare("UPDATE actions SET status = 'prepared' WHERE key = ? AND status IN ('blocked', 'failed', 'conflict')");
  const update = database.prepare(`
    UPDATE actions SET status = ? WHERE key = ?
    AND status NOT IN ('committed', 'confirmed', 'recorded')
  `);
  const decode = row => row ? { ...row, payload: JSON.parse(row.payload) } : null;

  return {
    latest: (errandId, operation) => decode(latest.get(errandId, operation)),
    prepare: (errandId, operation, key, payload) => transaction(() => {
      const outstanding = latest.get(errandId, operation);
      if (outstanding && outstanding.key !== key && ['prepared', 'unknown', 'committed', 'confirmed', 'recorded'].includes(outstanding.status)) {
        const error = new Error('Reconcile the original operation before preparing another.');
        error.code = 'operation-pending';
        throw error;
      }
      const encoded = JSON.stringify(payload);
      insert.run(key, errandId, operation, encoded, clock().toISOString());
      const row = get.get(key);
      if (row.errandId !== errandId || row.operation !== operation || row.payload !== encoded) {
        throw new Error('The operation key belongs to different terms.');
      }
      if (reopen.run(key).changes) row.status = 'prepared';
      return decode(row);
    }),
    dispatch: (errandId, action) => transaction(() => action(find(errandId), clock(), clock)),
    mark: (key, status) => update.run(status, key),
    inspect: () => database.prepare('SELECT * FROM actions ORDER BY rowid').all().map(decode),
    reset: errandId => database.prepare('DELETE FROM actions WHERE errandId = ?').run(errandId)
  };
}
