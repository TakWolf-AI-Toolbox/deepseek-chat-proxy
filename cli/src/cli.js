#!/usr/bin/env node

import readline from 'readline';
import { EventEmitter } from 'events';

const API_BASE = 'http://localhost:12500';

function log(...args) {
  console.error('[CLI]', ...args);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function sendMessage(sessionId, message) {
  const res = await fetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId || 'new', message })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sessionIdOut = sessionId;

  process.stdout.write('\nDeepSeek: ');

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(data.error);
        if (data.chunk !== undefined) {
          process.stdout.write(data.chunk);
        }
        if (data.done) {
          if (data.sessionId) sessionIdOut = data.sessionId;
          process.stdout.write('\n\n');
          return sessionIdOut;
        }
      } catch (e) {
        if (e.message) throw e;
      }
    }
  }

  return sessionIdOut;
}

async function main() {
  let sessionId = null;

  log('Welcome to DeepSeek CLI');
  log('Type "quit" to exit, "clear" to reset session\n');

  while (true) {
    const input = await ask('You: ');
    const message = input.trim();
    if (!message) continue;

    if (message.toLowerCase() === 'quit') break;
    if (message.toLowerCase() === 'clear') { sessionId = null; log('Session cleared'); continue; }
    if (message.toLowerCase() === 'session') { log('Current session:', sessionId); continue; }

    try {
      sessionId = await sendMessage(sessionId, message);
    } catch (err) {
      process.stdout.write('\n\n');
      log('Error:', err.message);
    }
  }

  log('Goodbye!');
}

main().catch(err => { log('Fatal:', err.message); process.exit(1); });
