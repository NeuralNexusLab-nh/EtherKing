'use strict';

const state = {
  user: null,
  authenticated: false,
  readOnly: false,
  currentChat: null,
  chats: [],
  models: [],
  activeChatId: null,
  messages: [],
  generation: null,
  pollTimer: null,
  lastGenerationNotice: null,
  renderedMessageFingerprint: ''
};

const root = document.documentElement;
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('mobile-overlay');
const chatList = document.getElementById('chat-list');
const messages = document.getElementById('messages');
const emptyState = document.getElementById('empty-state');
const conversation = document.getElementById('conversation');
const composer = document.getElementById('composer');
const input = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const modelSelect = document.getElementById('model-select');
const accountDialog = document.getElementById('account-dialog');
const usageDialog = document.getElementById('usage-dialog');
const toast = document.getElementById('toast');
const shareButton = document.getElementById('share-button');

function chatIdFromPath() {
  const match = /^\/chats\/([0-9a-f-]{36})$/i.exec(window.location.pathname);
  return match ? match[1] : null;
}

function setReadOnly(value) {
  state.readOnly = value;
  document.body.classList.toggle('shared-view', value);
  modelSelect.disabled = value;
  if (value) clearPoll();
}

root.dataset.theme = 'light';

function getCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  const part = document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : '';
}

async function api(url, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(method.toUpperCase())) headers.set('X-CSRF-Token', getCookie('etherking_csrf'));
  const response = await fetch(url, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) {
    window.location.replace('/');
    throw new Error('Your session has expired.');
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Request failed.');
  }
  if (response.status === 204) return null;
  return response.json();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function initials(name) {
  return String(name || 'U').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function applyUser(user) {
  state.user = user;
  const avatar = initials(user.displayName);
  for (const id of ['account-avatar', 'dialog-avatar']) document.getElementById(id).textContent = avatar;
  for (const id of ['account-name', 'dialog-name']) document.getElementById(id).textContent = user.displayName;
  for (const id of ['account-email', 'dialog-email']) document.getElementById(id).textContent = user.email;
}

function setSidebar(open) {
  sidebar.classList.toggle('open', open);
  overlay.hidden = !open;
}

document.getElementById('open-sidebar').addEventListener('click', () => setSidebar(true));
document.getElementById('close-sidebar').addEventListener('click', () => setSidebar(false));
overlay.addEventListener('click', () => setSidebar(false));

function isGenerating() {
  return ['queued', 'in_progress'].includes(state.generation?.status);
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  sendButton.disabled = isGenerating() || !input.value.trim();
}

function setGenerating(value) {
  composer.classList.toggle('generating', value);
  input.disabled = value;
  resizeInput();
}

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

function appendInlineMarkdown(container, source) {
  const pattern = /(``[^\n]+?``|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    let element;
    if (token.startsWith('``')) {
      element = document.createElement('code');
      element.textContent = token.slice(2, -2);
    } else if (token.startsWith('`')) {
      element = document.createElement('code');
      element.textContent = token.slice(1, -1);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      element = document.createElement('strong');
      element.textContent = token.slice(2, -2);
    } else {
      element = document.createElement('em');
      element.textContent = token.slice(1, -1);
    }
    container.appendChild(element);
    cursor = match.index + token.length;
  }
  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
}

function appendHighlightedCode(container, source) {
  const pattern = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|def|else|export|false|finally|for|from|function|if|import|in|let|new|null|print|return|switch|throw|true|try|undefined|var|while)\b|\b\d+(?:\.\d+)?\b)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    const span = document.createElement('span');
    if (token.startsWith('//') || token.startsWith('#') || token.startsWith('/*')) span.className = 'code-comment';
    else if (/^["'`]/.test(token)) span.className = 'code-string';
    else if (/^\d/.test(token)) span.className = 'code-number';
    else span.className = 'code-keyword';
    span.textContent = token;
    container.appendChild(span);
    cursor = match.index + token.length;
  }
  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
}

function appendCodeBlock(container, source, language) {
  const block = document.createElement('div');
  block.className = 'code-block';
  const toolbar = document.createElement('div');
  toolbar.className = 'code-toolbar';
  const label = document.createElement('span');
  label.textContent = language || 'Code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy-button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => copyMessage(source));
  toolbar.append(label, copy);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  appendHighlightedCode(code, source);
  pre.appendChild(code);
  block.append(toolbar, pre);
  container.appendChild(block);
}

function renderSafeMarkdown(container, content) {
  container.replaceChildren();
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const openingFence = /^\s*(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (openingFence) {
      const fence = openingFence[1];
      const language = openingFence[2].trim().slice(0, 30);
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence)) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      appendCodeBlock(container, codeLines.join('\n'), language);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      container.appendChild(element);
      index += 1;
      continue;
    }
    if (/^\s*((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(line)) {
      container.appendChild(document.createElement('hr'));
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const list = document.createElement('ul');
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*[-*+]\s+/, ''));
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const list = document.createElement('ol');
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        const item = document.createElement('li');
        appendInlineMarkdown(item, lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        list.appendChild(item);
        index += 1;
      }
      container.appendChild(list);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const quoteLines = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) quoteLines.push(lines[index++].replace(/^\s*>\s?/, ''));
      appendInlineMarkdown(quote, quoteLines.join('\n'));
      container.appendChild(quote);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim()
      && !/^(#{1,6})\s+/.test(lines[index])
      && !/^\s*(```|[-*+]\s+|\d+[.)]\s+|>\s?)/.test(lines[index])
      && !/^\s*((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(lines[index])) {
      paragraphLines.push(lines[index++]);
    }
    const paragraph = document.createElement('p');
    appendInlineMarkdown(paragraph, paragraphLines.join('\n'));
    container.appendChild(paragraph);
  }
}

function makeIcon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const data of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', data);
    svg.appendChild(path);
  }
  return svg;
}

function actionButton(label, paths, handler) {
  const button = document.createElement('button');
  button.className = 'message-action';
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(makeIcon(paths));
  button.addEventListener('click', handler);
  return button;
}

async function copyMessage(content) {
  try {
    await navigator.clipboard.writeText(content);
    showToast('Copied to clipboard.');
  } catch {
    showToast('Unable to copy this message.');
  }
}

function beginEditMessage(message, body, actions) {
  const editor = document.createElement('textarea');
  editor.className = 'message-editor';
  editor.value = message.content;
  editor.maxLength = 20000;
  const controls = document.createElement('div');
  controls.className = 'message-edit-controls';
  const cancel = document.createElement('button');
  cancel.className = 'secondary-button compact-button';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = document.createElement('button');
  submit.className = 'primary-button compact-button';
  submit.type = 'button';
  submit.textContent = 'Save and submit';
  controls.append(cancel, submit);
  body.replaceChildren(editor, controls);
  actions.hidden = true;
  editor.focus();
  cancel.addEventListener('click', renderMessages);
  submit.addEventListener('click', async () => {
    const content = editor.value.trim();
    if (!content) return showToast('Message cannot be empty.');
    submit.disabled = true;
    try {
      const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages/${encodeURIComponent(message.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content, model: modelSelect.value })
      });
      state.messages = state.messages.filter((item) => item.id !== message.id);
      state.messages.push(payload.message);
      state.generation = payload.generation;
      renderMessages();
      setGenerating(true);
      schedulePoll();
    } catch (error) {
      showToast(error.message);
      submit.disabled = false;
    }
  });
}

async function regenerateMessage(message) {
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages/${encodeURIComponent(message.id)}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ model: modelSelect.value })
    });
    state.messages = state.messages.filter((item) => item.id !== message.id);
    state.generation = payload.generation;
    renderMessages();
    setGenerating(true);
    schedulePoll();
  } catch (error) {
    showToast(error.message);
  }
}

function createMessageElement(message) {
  const article = document.createElement('article');
  article.className = `message ${message.role}${message.pending ? ' pending' : ''}`;
  if (message.pending) article.id = 'streaming-message';
  if (message.role === 'user') {
    const column = document.createElement('div');
    column.className = 'user-message-column';
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = message.content;
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    actions.appendChild(actionButton('Copy message', ['M8 8h11v11H8z', 'M5 16H4V5h11v1'], () => copyMessage(message.content)));
    if (!state.readOnly) actions.appendChild(actionButton('Edit message', ['M4 20h4l11-11-4-4L4 16v4Z', 'm13.5-13.5 4 4'], () => beginEditMessage(message, body, actions)));
    column.append(body, actions);
    article.appendChild(column);
  } else {
    const mark = document.createElement('span');
    mark.className = 'brand-mark assistant-mark';
    mark.textContent = 'AI';
    const column = document.createElement('div');
    column.className = 'assistant-column';
    const content = document.createElement('div');
    content.className = `message-content${message.pending ? ' typing-cursor' : ''}`;
    if (message.pending) {
      const pending = document.createElement('p');
      pending.className = 'streaming-text';
      pending.textContent = message.content || 'Thinking...';
      content.dataset.streamingContent = message.content || '';
      content.appendChild(pending);
    } else {
      renderSafeMarkdown(content, message.content);
    }
    column.appendChild(content);
    if (!message.pending) {
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      actions.appendChild(actionButton('Copy response', ['M8 8h11v11H8z', 'M5 16H4V5h11v1'], () => copyMessage(message.content)));
      if (!state.readOnly) actions.appendChild(actionButton('Regenerate response', ['M20 7v5h-5', 'M19 12a7 7 0 1 0 1 5'], () => regenerateMessage(message)));
      column.appendChild(actions);
    }
    article.append(mark, column);
  }
  return article;
}

function messageFingerprint(items) {
  return items.map((message) => `${message.id}:${message.content}`).join('|');
}

function updateStreamingMessage() {
  if (!isGenerating()) return;
  const article = document.getElementById('streaming-message');
  if (!article) return renderMessages();
  const content = article.querySelector('.message-content');
  const next = state.generation?.content || '';
  const previous = content.dataset.streamingContent || '';
  let text = content.querySelector('.streaming-text');
  if (!next && !previous) return;
  if (!text || !previous) {
    text = document.createElement('p');
    text.className = 'streaming-text';
    text.textContent = next;
    content.replaceChildren(text);
  } else if (next.startsWith(previous)) {
    text.appendChild(document.createTextNode(next.slice(previous.length)));
  } else {
    text.textContent = next;
  }
  content.dataset.streamingContent = next;
  conversation.scrollTop = conversation.scrollHeight;
}

function renderMessages() {
  messages.replaceChildren();
  state.messages.forEach((message) => messages.appendChild(createMessageElement(message)));
  if (isGenerating()) messages.appendChild(createMessageElement({ role: 'assistant', content: state.generation?.content || '', pending: true }));
  state.renderedMessageFingerprint = messageFingerprint(state.messages);
  const hasMessages = state.messages.length > 0 || isGenerating();
  emptyState.hidden = hasMessages;
  messages.hidden = !hasMessages;
  requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
}

function renderChats() {
  chatList.replaceChildren();
  if (!state.chats.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-list-empty';
    empty.textContent = 'Your conversations will appear here.';
    chatList.appendChild(empty);
    return;
  }
  const heading = document.createElement('div');
  heading.className = 'chat-list-heading';
  heading.textContent = 'Chats';
  chatList.appendChild(heading);
  state.chats.forEach((chat) => {
    const row = document.createElement('div');
    row.className = `chat-row${chat.id === state.activeChatId ? ' active' : ''}`;
    const link = document.createElement('button');
    link.className = 'chat-link';
    link.type = 'button';
    link.textContent = chat.title;
    link.title = chat.title;
    link.addEventListener('click', () => openChat(chat.id));
    const remove = document.createElement('button');
    remove.className = 'chat-delete';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${chat.title}`);
    remove.appendChild(makeIcon(['M6 6l12 12', 'M18 6 6 18']));
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(chat.id, chat.title);
    });
    row.append(link, remove);
    chatList.appendChild(row);
  });
}

async function loadChats() {
  const payload = await api('/api/chats');
  state.chats = payload.chats;
  renderChats();
}

function clearPoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function schedulePoll() {
  clearPoll();
  if (!state.activeChatId || !isGenerating()) return;
  state.pollTimer = setTimeout(refreshActiveChat, 500);
}

async function refreshActiveChat() {
  if (!state.activeChatId) return;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}`);
    state.generation = payload.generation;
    const nextFingerprint = messageFingerprint(payload.messages);
    state.messages = payload.messages;
    if (nextFingerprint !== state.renderedMessageFingerprint) renderMessages();
    else updateStreamingMessage();
    setGenerating(isGenerating());
    if (state.generation?.status === 'failed' && state.lastGenerationNotice !== state.generation.id) {
      state.lastGenerationNotice = state.generation.id;
      showToast(state.generation.error || 'Generation failed.');
    }
    if (isGenerating()) schedulePoll();
    else {
      clearPoll();
      await loadChats();
    }
  } catch (error) {
    showToast(error.message);
    schedulePoll();
  }
}

async function openChat(chatId, options = {}) {
  if (chatId === state.activeChatId && state.messages.length) return;
  try {
    clearPoll();
    const payload = await api(`/api/chats/${encodeURIComponent(chatId)}`);
    setReadOnly(false);
    state.activeChatId = chatId;
    state.currentChat = payload.chat;
    state.messages = payload.messages;
    state.generation = payload.generation;
    if (state.models.some((model) => model.id === payload.chat.model)) modelSelect.value = payload.chat.model;
    localStorage.setItem('etherking_model', modelSelect.value);
    renderChats();
    renderMessages();
    shareButton.hidden = false;
    document.title = `${payload.chat.title} - EtherKing`;
    const chatUrl = `/chats/${encodeURIComponent(chatId)}`;
    if (options.replaceHistory) history.replaceState({ chatId }, '', chatUrl);
    else if (options.updateHistory !== false && window.location.pathname !== chatUrl) history.pushState({ chatId }, '', chatUrl);
    setGenerating(isGenerating());
    schedulePoll();
    setSidebar(false);
    if (!isGenerating()) input.focus();
  } catch (error) {
    if (options.allowShared) return loadSharedChat(chatId, { replaceHistory: options.replaceHistory });
    showToast(error.message);
  }
}

async function loadSharedChat(chatId, options = {}) {
  try {
    clearPoll();
    const payload = await api(`/api/shared/chats/${encodeURIComponent(chatId)}`);
    setReadOnly(true);
    state.activeChatId = chatId;
    state.currentChat = payload.chat;
    state.messages = payload.messages;
    state.generation = null;
    renderMessages();
    shareButton.hidden = true;
    document.title = `${payload.chat.title} - EtherKing`;
    const chatUrl = `/chats/${encodeURIComponent(chatId)}`;
    if (options.replaceHistory) history.replaceState({ chatId }, '', chatUrl);
  } catch (error) {
    showToast(error.message);
    if (!state.authenticated) window.location.replace('/');
  }
}

function startNewChat(updateHistory = true) {
  clearPoll();
  setReadOnly(false);
  state.activeChatId = null;
  state.currentChat = null;
  state.messages = [];
  state.generation = null;
  renderChats();
  renderMessages();
  setGenerating(false);
  shareButton.hidden = true;
  document.title = 'EtherKing';
  if (updateHistory && window.location.pathname !== '/app') history.pushState({}, '', '/app');
  setSidebar(false);
  input.focus();
}

document.getElementById('new-chat').addEventListener('click', startNewChat);

async function deleteChat(chatId, title) {
  if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
    state.chats = state.chats.filter((chat) => chat.id !== chatId);
    if (state.activeChatId === chatId) startNewChat();
    else renderChats();
  } catch (error) {
    showToast(error.message);
  }
}

async function ensureChat() {
  if (state.activeChatId) return state.activeChatId;
  const payload = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ model: modelSelect.value })
  });
  state.activeChatId = payload.chat.id;
  state.currentChat = payload.chat;
  state.chats.unshift(payload.chat);
  renderChats();
  shareButton.hidden = false;
  history.pushState({ chatId: payload.chat.id }, '', `/chats/${encodeURIComponent(payload.chat.id)}`);
  return state.activeChatId;
}

async function sendMessage(content) {
  setGenerating(true);
  try {
    const chatId = await ensureChat();
    const payload = await api(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, model: modelSelect.value })
    });
    state.messages.push(payload.message);
    state.generation = payload.generation;
    renderMessages();
    schedulePoll();
    await loadChats();
  } catch (error) {
    state.generation = null;
    setGenerating(false);
    renderMessages();
    showToast(error.message);
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (isGenerating()) return;
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  resizeInput();
  sendMessage(content);
});

modelSelect.addEventListener('change', () => localStorage.setItem('etherking_model', modelSelect.value));

async function loadModels() {
  const payload = await api('/api/models');
  state.models = payload.models;
  modelSelect.replaceChildren();
  const providers = new Map();
  for (const model of payload.models) {
    if (!providers.has(model.provider)) {
      const group = document.createElement('optgroup');
      group.label = model.provider;
      providers.set(model.provider, group);
      modelSelect.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name;
    option.dataset.plan = model.plan;
    providers.get(model.provider).appendChild(option);
  }
  const saved = localStorage.getItem('etherking_model');
  if (saved && payload.models.some((model) => model.id === saved)) modelSelect.value = saved;
  else if (payload.models.some((model) => model.id === 'gpt-5.4-mini')) modelSelect.value = 'gpt-5.4-mini';
}

document.getElementById('account-button').addEventListener('click', () => accountDialog.showModal());
document.getElementById('show-delete-account').addEventListener('click', () => {
  document.getElementById('delete-account-panel').hidden = false;
  document.getElementById('delete-password').focus();
});

document.getElementById('logout-button').addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.replace('/');
  } catch (error) {
    showToast(error.message);
  }
});

document.getElementById('delete-account-button').addEventListener('click', async () => {
  const password = document.getElementById('delete-password').value;
  const alert = document.getElementById('delete-alert');
  alert.hidden = true;
  if (!password) {
    alert.textContent = 'Enter your password to continue.';
    alert.hidden = false;
    return;
  }
  try {
    await api('/api/account', { method: 'DELETE', body: JSON.stringify({ password }) });
    localStorage.removeItem('etherking_model');
    window.location.replace('/');
  } catch (error) {
    alert.textContent = error.message;
    alert.hidden = false;
  }
});

function percentText(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

function usageWindow(label, value) {
  const row = document.createElement('div');
  row.className = 'usage-window';
  const copy = document.createElement('div');
  copy.className = 'usage-copy';
  const name = document.createElement('span');
  name.textContent = label;
  const count = document.createElement('strong');
  count.textContent = percentText(value.remainingPercent);
  const track = document.createElement('div');
  track.className = 'usage-track';
  const fill = document.createElement('span');
  fill.className = 'usage-fill';
  fill.style.width = percentText(value.remainingPercent);
  copy.append(name, count);
  track.appendChild(fill);
  row.append(copy, track);
  return row;
}

document.getElementById('usage-button').addEventListener('click', async () => {
  try {
    const payload = await api('/api/usage');
    const usageList = document.getElementById('usage-list');
    usageList.replaceChildren();
    const card = document.createElement('section');
    card.className = 'usage-item';
    card.append(
      usageWindow('5-hour limit', payload.usage.windows.fiveHour),
      usageWindow('Weekly limit', payload.usage.windows.weekly)
    );
    usageList.appendChild(card);
    usageDialog.showModal();
  } catch (error) {
    showToast(error.message);
  }
});

shareButton.addEventListener('click', async () => {
  if (!state.activeChatId || state.readOnly) return;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/share`, { method: 'POST' });
    state.currentChat = payload.chat;
    const shareUrl = new URL(payload.url, window.location.origin).href;
    await navigator.clipboard.writeText(shareUrl);
    showToast('Share link copied.');
  } catch (error) {
    showToast(error.message);
  }
});

window.addEventListener('popstate', () => {
  const chatId = chatIdFromPath();
  if (chatId) {
    if (state.authenticated) openChat(chatId, { updateHistory: false, allowShared: true });
    else loadSharedChat(chatId);
  } else if (state.authenticated) {
    startNewChat(false);
  } else {
    window.location.replace('/');
  }
});

async function initialize() {
  try {
    const pathChatId = chatIdFromPath();
    const session = await api('/api/session');
    state.authenticated = session.authenticated === true;
    if (!state.authenticated) {
      if (pathChatId) return loadSharedChat(pathChatId, { replaceHistory: true });
      return window.location.replace('/');
    }
    applyUser(session.user);
    await Promise.all([loadModels(), loadChats()]);
    if (pathChatId) return openChat(pathChatId, { updateHistory: false, replaceHistory: true, allowShared: true });
    startNewChat(false);
  } catch (error) {
    showToast(error.message);
  }
}

initialize();
