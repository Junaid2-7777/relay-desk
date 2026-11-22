import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDeskServer } from '../src/server.mjs'

const note = 'The shop said it would refund me. Can you help me check on Friday?'
const monday = '2026-11-22T19:00:00.000Z'
const friday = '2026-11-26T19:00:00.000Z'

async function startDesk(dataDir, date) {
  const server = createDeskServer({ dataDir, clock: () => new Date(date) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  async function close() {
    if (server.listening) {
      const closed = once(server, 'close')
      server.close()
      await closed
    }
  }

  return {
    close,
    async request(path, { method = 'GET', body, status } = {}) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const detail = await response.text()
      const description = `${method} ${path} returned ${response.status}: ${detail}`
      if (status === undefined) {
        assert.ok(response.ok, description)
      } else {
        assert.equal(response.status, status, description)
      }
      return JSON.parse(detail)
    },
  }
}

async function startFreshDesk(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'relay-first-use-'))
  const desks = []
  t.after(async () => {
    await Promise.all(desks.map((desk) => desk.close()))
    await rm(dataDir, { recursive: true, force: true })
  })
  async function open(date = monday) {
    const desk = await startDesk(dataDir, date)
    desks.push(desk)
    return desk
  }
  return { desk: await open(), open }
}

test('a refund note survives a restart with its chosen check and no outside effects', async (t) => {
  const { desk, open } = await startFreshDesk(t)
  const empty = await desk.request('/api/desk')
  assert.equal(empty.today, '2026-11-23')
  assert.deepEqual(empty.errands, [])

  const preview = await desk.request('/api/errands/preview', {
    method: 'POST',
    body: { note },
  })
  assert.equal(preview.kind, 'refund')
  assert.equal(preview.checkDate, '2026-11-27')
  assert.ok(preview.goal.trim())

  const saved = await desk.request('/api/errands', {
    method: 'POST',
    body: { note, goal: preview.goal, checkDate: preview.checkDate },
  })
  assert.equal(saved.kind, 'refund')
  assert.equal(saved.note, note)
  assert.equal(saved.goal, preview.goal)
  assert.equal(saved.status, 'open')
  assert.equal(saved.revision, 1)
  assert.equal(saved.merchantDeadline, null)
  await desk.close()

  const reopened = await open(friday)
  const current = await reopened.request('/api/desk')
  assert.equal(current.today, '2026-11-27')
  assert.deepEqual(current.errands, [saved])
  assert.equal(current.errands[0].checkDate, '2026-11-27')

  const draft = await reopened.request(`/api/errands/${saved.id}/draft`, { method: 'POST' })
  assert.ok(draft.text.trim())
  const inspection = await reopened.request('/api/inspect')
  assert.deepEqual(inspection.errands, [saved])
  assert.deepEqual(inspection.grants, [])
  assert.deepEqual(inspection.effects, [])
})

test('editing a saved errand preserves the original note and rejects a stale edit', async (t) => {
  const { desk } = await startFreshDesk(t)
  const saved = await desk.request('/api/errands', {
    method: 'POST',
    body: { note, goal: 'Check the shop refund', checkDate: '2026-11-27' },
  })
  const path = `/api/errands/${saved.id}`
  const edited = await desk.request(path, {
    method: 'PUT',
    body: { goal: 'Ask when the refund will post', checkDate: '2026-11-30', revision: saved.revision },
  })
  assert.equal(edited.id, saved.id)
  assert.equal(edited.goal, 'Ask when the refund will post')
  assert.equal(edited.note, note)
  assert.equal(edited.checkDate, '2026-11-30')
  assert.equal(edited.revision, 2)
  assert.equal(edited.status, 'open')
  assert.equal(edited.merchantDeadline, null)

  await desk.request(path, {
    method: 'PUT',
    body: { goal: 'An older draft', checkDate: '2026-11-27', revision: saved.revision },
    status: 409,
  })
  assert.deepEqual((await desk.request('/api/desk')).errands, [edited])

  const cleared = await desk.request(path, {
    method: 'PUT',
    body: { goal: edited.goal, checkDate: null, revision: edited.revision },
  })
  assert.equal(cleared.checkDate, null)
  assert.equal(cleared.note, note)

  const inspection = await desk.request('/api/inspect')
  assert.deepEqual(inspection.errands, [cleared])
  assert.deepEqual(inspection.effects, [])
})
