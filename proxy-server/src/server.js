import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

const PORT = 12500;

const sessions = new Map();
const requests = new Map();
let wsCounter = 0;

class Session {
  constructor(tabId, ws, wsId) {
    this.id = randomUUID();
    this.tabId = tabId;
    this.ws = ws;
    this.wsId = wsId;
    this.status = 'idle';
    this.createdAt = Date.now();
  }
}

const server = createServer();

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

server.on('request', (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions') {
    const list = [];
    for (const s of sessions.values()) {
      list.push({ id: s.id, tabId: s.tabId, status: s.status, wsId: s.wsId });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sessions: list }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat/stream') {
    handleStreamRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

function handleStreamRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let sessionId, message;
    try {
      const parsed = JSON.parse(body);
      sessionId = parsed.sessionId;
      message = parsed.message;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json' }));
      return;
    }

    if (!message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'message is required' }));
      return;
    }

    let session = null;
    if (sessionId && sessionId !== 'new') {
      session = sessions.get(sessionId);
      if (!session || session.ws.readyState !== 1) session = null;
    }
    if (!session) session = getAvailableSession();
    if (!session) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no available browser tab' }));
      return;
    }

    const requestId = randomUUID();

    const onChunk = (chunk, done) => {
      const sseData = `data: ${JSON.stringify({ chunk, done })}\n\n`;
      if (done) {
        res.end(sseData);
      } else {
        res.write(sseData);
      }
    };

    const onError = (msg) => {
      res.end(`data: ${JSON.stringify({ error: msg })}\n\n`);
    };

    requests.set(requestId, { wsId: session.wsId, onChunk, onError, session });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      requests.delete(requestId);
      if (session && session.status === 'busy') session.status = 'idle';
    };

    res.on('close', cleanup);
    res.on('finish', cleanup);

    session.status = 'busy';
    session.ws.send(JSON.stringify({
      type: 'send_message',
      requestId,
      tabId: session.tabId,
      content: message
    }));
  });
}

wss.on('connection', (ws) => {
  const wsId = ++wsCounter;
  let session = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'tab_register') {
        session = new Session(msg.tabId, ws, wsId);
        sessions.set(session.id, session);
        ws.send(JSON.stringify({ type: 'registered', sessionId: session.id, tabId: msg.tabId }));
        return;
      }

      if (!session) return;

      if (msg.type !== 'stream_chunk' && msg.type !== 'error') return;
      if (!msg.requestId) return;

      const req = requests.get(msg.requestId);
      if (!req) return;
      if (req.wsId && req.wsId !== wsId) return;

      if (msg.type === 'stream_chunk') {
        req.onChunk(msg.chunk, msg.done);
      } else {
        req.onError(msg.message);
      }

      if (msg.done || msg.type === 'error') {
        requests.delete(msg.requestId);
        if (session && session.status === 'busy') session.status = 'idle';
      }
    } catch (e) {
      console.error('[Proxy] parse error:', e);
    }
  });

  ws.on('close', () => {
    if (session) sessions.delete(session.id);
  });

  ws.on('error', (err) => {
    console.error('[Proxy] WS error, wsId:', wsId, err.message);
  });
});

function getAvailableSession() {
  for (const s of sessions.values()) {
    if (s.status === 'idle' && s.ws.readyState === 1) return s;
  }
  return null;
}

server.listen(PORT, () => {
  console.log(`[Proxy] Server running on port ${PORT}`);
});
