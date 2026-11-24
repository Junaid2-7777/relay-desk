import { DatabaseSync } from 'node:sqlite';

const busyTimeout = 3000;
const sqliteBusy = 5;
const startupWait = new Int32Array(new SharedArrayBuffer(4));

export function openDatabase(path) {
  const database = new DatabaseSync(path);
  const deadline = performance.now() + busyTimeout;
  try {
    // Changing journal mode can report SQLITE_BUSY immediately while another process initializes the file.
    while (true) {
      try {
        database.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (error) {
        const remaining = deadline - performance.now();
        if ((error.errcode & 0xff) !== sqliteBusy || remaining <= 0) throw error;
        Atomics.wait(startupWait, 0, 0, Math.min(25, remaining));
      }
    }
    database.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
