#!/usr/bin/env node

import readline from 'readline';
import { spawn } from 'child_process';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';

const API_BASE = 'http://localhost:12500';

const TOOL_PATTERNS = [
  /<<tool_call>>([^|]+)\|([\s\S]*?)<<\/tool_call>>/g,
  /<tool_call>\s*<name>([^<]+)<\/name>\s*<args>([\s\S]*?)<\/args>\s*<\/tool_call>/g,
];

const AGENT_CONTEXT = `You are a helpful CLI assistant with access to the following tools:

## Available Tools

### execute
Execute a shell command and return the output.
Usage: execute|command string (e.g., execute|ls -la /tmp)

### read_file
Read the contents of a file.
Usage: read_file|path to file (e.g., read_file|/etc/hosts)

### ls
List directory contents.
Usage: ls|path to directory (e.g., ls|/tmp)

## Important Rules

1. When you need to run a shell command, use the execute tool
2. When you need to read a file, use the read_file tool
3. When you need to list a directory, use the ls tool
4. Always respond with tool calls wrapped in <<tool_call>>tool_name|args<</tool_call>> format
5. After receiving tool results, incorporate them into your response
6. Do not pretend to execute commands - actually use the tools

Remember: You can only execute commands on the machine where this CLI is running.`;

function log(...args) {
  console.error('[CLI]', ...args);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function executeCommand(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, exitCode: -1 });
    });
  });
}

async function readFileTool(path) {
  try {
    const content = await readFile(path, 'utf-8');
    return { success: true, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function listDir(path) {
  const targetPath = path || '.';
  try {
    const entries = await readdir(targetPath);
    const result = [];
    for (const entry of entries) {
      try {
        const fullPath = join(targetPath, entry);
        const s = await stat(fullPath);
        result.push({
          name: entry,
          type: s.isDirectory() ? 'dir' : 'file',
          size: s.size
        });
      } catch {
        result.push({ name: entry, type: 'unknown' });
      }
    }
    return { success: true, path: targetPath, entries: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function executeTool(name, args) {
  switch (name) {
    case 'execute':
      return await executeCommand(args);
    case 'read_file':
      return await readFileTool(args);
    case 'ls':
      return await listDir(args || '.');
    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

function parseToolCalls(text) {
  const calls = [];
  for (const pattern of TOOL_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = regex.exec(text)) !== null) {
      calls.push({ name: match[1].trim(), args: match[2].trim() });
    }
  }
  return calls;
}

function formatToolResult(result) {
  if (result.error) {
    return `Error: ${result.error}`;
  }
  if (result.stdout !== undefined) {
    const output = result.stdout + (result.stderr ? `\nSTDERR: ${result.stderr}` : '');
    return `Exit code: ${result.exitCode}\nOutput:\n${output || '(no output)'}`;
  }
  if (result.content !== undefined) {
    if (result.success) {
      return `File content (${result.content.length} chars):\n${result.content.slice(0, 5000)}${result.content.length > 5000 ? '\n...(truncated)' : ''}`;
    }
    return `Error: ${result.error}`;
  }
  if (result.entries !== undefined) {
    if (result.success) {
      const lines = result.entries.map(e => `${e.type === 'dir' ? 'd' : '-'} ${e.name}${e.size !== undefined ? ` (${e.size})` : ''}`).join('\n');
      return `Contents of ${result.path}:\n${lines}`;
    }
    return `Error: ${result.error}`;
  }
  return JSON.stringify(result);
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
  let fullResponse = '';

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
          fullResponse += data.chunk;
        }
        if (data.done) {
          if (data.sessionId) sessionIdOut = data.sessionId;
          process.stdout.write('\n\n');
          return { sessionId: sessionIdOut, response: fullResponse };
        }
      } catch (e) {
        if (e.message) throw e;
      }
    }
  }

  return { sessionId: sessionIdOut, response: fullResponse };
}

async function handleUserMessage(sessionId, userMessage) {
  let currentSessionId = sessionId;
  let conversationHistory = [];
  let maxIterations = 1000;
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    const { sessionId: newSessionId, response } = await sendMessage(currentSessionId, userMessage);
    currentSessionId = newSessionId;
    conversationHistory.push({ role: 'user', content: userMessage });
    conversationHistory.push({ role: 'assistant', content: response });

    const toolCalls = parseToolCalls(response);
    if (toolCalls.length === 0) {
      return currentSessionId;
    }

    for (const call of toolCalls) {
      log(`Executing tool: ${call.name} with args: ${call.args}`);
      const result = await executeTool(call.name, call.args);
      const formattedResult = formatToolResult(result);
      log(`Tool result: ${formattedResult.slice(0, 200)}${formattedResult.length > 200 ? '...' : ''}`);
      conversationHistory.push({ role: 'tool', tool: call.name, content: formattedResult });
      userMessage = `[Tool: ${call.name}]\nResult: ${formattedResult}\n\nContinue your response, incorporating this result.`;
    }
  }

  log('Max iterations reached');
  return currentSessionId;
}

async function main() {
  let sessionId = null;
  const cwd = process.cwd();

  log('Welcome to DeepSeek Chat Proxy CLI (Agent Mode)');
  log(`Current directory: ${cwd}`);
  log('Type "quit" to exit, "clear" to reset session\n');

  while (true) {
    const input = await ask('You: ');
    const message = input.trim();
    if (!message) continue;

    if (message.toLowerCase() === 'quit') break;
    if (message.toLowerCase() === 'clear') { sessionId = null; log('Session cleared'); continue; }
    if (message.toLowerCase() === 'session') { log('Current session:', sessionId); continue; }

    let finalMessage = message;
    if (!sessionId) {
      finalMessage = `${AGENT_CONTEXT}\n\n---\n\nUser request: ${message}`;
      log('(New session - agent context prepended)');
    }

    try {
      sessionId = await handleUserMessage(sessionId, finalMessage);
    } catch (err) {
      process.stdout.write('\n\n');
      log('Error:', err.message);
    }
  }

  log('Goodbye!');
}

main().catch(err => { log('Fatal:', err.message); process.exit(1); });
