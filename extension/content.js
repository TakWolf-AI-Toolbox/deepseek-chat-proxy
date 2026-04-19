const SELECTORS = {
  textarea: 'textarea',
  submitButton: 'button[class*="send"]',
};

let pendingRequestId = null;
let pendingResolve = null;
let pendingReject = null;
let lastText = '';
let streamDone = false;
let checkTimer = null;

function log(...args) {
  console.log('[DeepSeek-Content]', ...args);
}

function sendMsg(data) {
  const msgToSend = { ...data, requestId: pendingRequestId };
  log('sendMsg called, data:', JSON.stringify(msgToSend));
  chrome.runtime.sendMessage(msgToSend);
}

function extractSessionId() {
  const m = window.location.pathname.match(/\/a\/chat\/s\/([a-f0-9-]+)/);
  return m ? m[1] : null;
}

async function waitForTextarea(timeout = 15000) {
  const existing = document.querySelector(SELECTORS.textarea);
  if (existing) return existing;

  return new Promise((resolve, reject) => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector(SELECTORS.textarea);
      if (el) { obs.disconnect(); resolve(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error('textarea not found')); }, timeout);
  });
}

function fillAndSend(textarea, content) {
  textarea.focus();

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(textarea, content);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    textarea.value = content;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const submitBtn = document.querySelector(SELECTORS.submitButton);
  if (submitBtn && !submitBtn.disabled) {
    submitBtn.click();
    return true;
  }

  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
  return true;
}

function getLastAiMessageText() {
  const messages = document.querySelectorAll('.ds-message');
  for (let i = messages.length - 1; i >= 0; i--) {
    const el = messages[i];
    if (el.classList.contains('d29f3d7d')) continue;

    const markdowns = el.querySelectorAll('.ds-markdown');
    if (markdowns.length === 0) continue;

    let text = '';
    for (const md of markdowns) {
      text += md.textContent || '';
    }
    if (text.trim()) return text;
  }
  return '';
}

function startObserver() {
  lastText = '';
  streamDone = false;

  clearTimeout(checkTimer);

  let stableCount = 0;

  const check = () => {
    if (streamDone) return;

    const current = getLastAiMessageText();

    if (current.length > lastText.length) {
      const newChunk = current.slice(lastText.length);
      lastText = current;
      stableCount = 0;
      sendMsg({ type: 'stream_chunk', chunk: newChunk, done: false });
      log('chunk:', newChunk.length, 'chars, total:', current.length);
    } else if (current.length > 0 && current.length === lastText.length) {
      stableCount++;
      if (stableCount >= 4) {
        streamDone = true;
        sendMsg({ type: 'stream_chunk', chunk: '', done: true });
        log('done, total length:', current.length);
        if (pendingResolve) pendingResolve(current);
        pendingResolve = null;
        pendingReject = null;
        pendingRequestId = null;
        return;
      }
    } else {
      stableCount = 0;
    }

    checkTimer = setTimeout(check, 300);
  };

  setTimeout(check, 1500);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  log('onMessage received:', JSON.stringify(msg));
  if (msg.type !== 'send_message') return;

  const { requestId, content } = msg;
  log('send_message received, requestId:', requestId, 'content:', content);
  pendingRequestId = requestId;

  waitForTextarea(15000).then((textarea) => {
    startObserver();
    fillAndSend(textarea, content);
    sendResponse({ success: true });
  }).catch((err) => {
    log('Error:', err.message);
    sendMsg({ type: 'error', message: err.message });
    sendResponse({ success: false, error: err.message });
    pendingRequestId = null;
    pendingResolve = null;
    pendingReject = null;
  });

  return true;
});

log('Content script loaded, session:', extractSessionId());
sendMsg({ type: 'tab_ready', sessionId: extractSessionId(), url: window.location.href });
