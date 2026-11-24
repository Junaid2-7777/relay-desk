import { PlannerProposalError } from './planner-proposal.mjs';

const maximumResponseBytes = 32 * 1024;
const jsonType = /^application\/json(?:\s*;|$)/i;

function webhookUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Set RELAY_N8N_WEBHOOK_URL to the n8n webhook URL.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new TypeError('Use HTTPS or loopback HTTP in RELAY_N8N_WEBHOOK_URL, with no user information or fragment.');
  }
  return url;
}

async function readProposal(response) {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error('The n8n planner is unavailable.');
  }
  if (!response.body || !jsonType.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new PlannerProposalError();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) throw new PlannerProposalError();
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } catch {
    await reader.cancel().catch(() => {});
    throw new PlannerProposalError();
  } finally {
    reader.releaseLock();
  }
}

export function createN8nPlannerFromEnv(env = process.env) {
  const url = webhookUrl(env.RELAY_N8N_WEBHOOK_URL);
  const token = env.RELAY_N8N_WEBHOOK_TOKEN;
  if (typeof token !== 'string' || !/^[!-~]+$/u.test(token)) {
    throw new TypeError('Set RELAY_N8N_WEBHOOK_TOKEN to the n8n webhook token.');
  }

  const timeoutMs = Number(env.RELAY_N8N_TIMEOUT_MS ?? 12_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('RELAY_N8N_TIMEOUT_MS must be an integer between 1 and 30000.');
  }

  return {
    mode: 'n8n',
    timeoutMs,
    async propose({ note, today, sources, signal = AbortSignal.timeout(timeoutMs) }) {
      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
            'authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ note, today, sources }),
          redirect: 'error',
          signal
        });
      } catch {
        throw new Error('The n8n planner is unavailable.');
      }
      return readProposal(response);
    }
  };
}
