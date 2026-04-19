const PROXY_URL = 'ws://localhost:12500';

let ws = null;
let reconnectTimer = null;
const tabIdToSessionId = new Map();
const sessionIdToTabId = new Map();

function log(...args) {
  console.log('[DeepSeek-Background]', ...args);
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  clearTimeout(reconnectTimer);

  log('Connecting to proxy...');
  ws = new WebSocket(PROXY_URL);

  ws.onopen = () => {
    log('Connected to proxy');
    for (const [tabId, sessionId] of tabIdToSessionId) {
      log('Re-registering tab:', tabId, 'session:', sessionId);
      ws.send(JSON.stringify({ type: 'tab_register', tabId, sessionId }));
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      log('WS message from proxy:', JSON.stringify(msg));
      handleServerMessage(msg);
    } catch (e) {
      log('Parse error:', e);
    }
  };

  ws.onclose = () => {
    log('Disconnected, reconnecting in 3s...');
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = (err) => {
    log('WebSocket error:', err);
  };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    log('WS send:', JSON.stringify(data));
    ws.send(JSON.stringify(data));
    return true;
  }
  log('WS not connected, cannot send');
  return false;
}

function handleServerMessage(msg) {
  log('handleServerMessage:', JSON.stringify(msg));

  if (msg.type === 'registered') {
    const { sessionId, tabId } = msg;
    tabIdToSessionId.set(tabId, sessionId);
    sessionIdToTabId.set(sessionId, tabId);
    log('Registered session', sessionId, 'for tab', tabId);
    return;
  }

  if (msg.type === 'send_message') {
    const tabId = msg.tabId || sessionIdToTabId.get(msg.sessionId);
    log('send_message for tabId:', tabId, 'sessionId:', msg.sessionId);
    if (tabId) {
      chrome.tabs.sendMessage(tabId, msg).then(r => log('sendMessage success:', r)).catch(e => log('sendMessage error:', e.message));
    } else {
      log('No tabId found for send_message');
    }
    return;
  }

  log('Unknown message type:', msg.type);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  log('onMessage from content:', JSON.stringify(msg), 'sender.tab:', sender.tab?.id);

  if (msg.type === 'tab_ready') {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    const existingSessionId = tabIdToSessionId.get(tabId);
    log('tab_ready for tabId:', tabId, 'existing sessionId:', existingSessionId);
    tabIdToSessionId.set(tabId, existingSessionId || null);
    send({ type: 'tab_register', tabId, sessionId: existingSessionId });
    return;
  }

  if (msg.type === 'stream_chunk' || msg.type === 'error') {
    const tabId = sender.tab?.id;
    const sessionId = tabId ? tabIdToSessionId.get(tabId) : null;
    log('Forwarding', msg.type, 'tabId:', tabId, 'sessionId:', sessionId);
    send({ ...msg, sessionId });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sessionId = tabIdToSessionId.get(tabId);
  if (sessionId) sessionIdToTabId.delete(sessionId);
  tabIdToSessionId.delete(tabId);
  log('Tab removed:', tabId);
});

connect();
