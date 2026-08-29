'use strict';

const state = {
  user: null,
  chats: [],
  activeChatId: null,
  messages: [],
  generating: false,
  abortController: null
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

function setTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = value;
  localStorage.setItem('etherking_theme', value);
}

setTheme(localStorage.getItem('etherking_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
document.querySelectorAll('.theme-toggle').forEach((button) => button.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark')));

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
  const response = await fetch(url, { ...options, method, headers, credentials: 'same-origin' });
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

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  sendButton.disabled = state.generating ? false : !input.value.trim();
}

input.addEventListener('input', resizeInput);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

function renderSafeContent(container, content) {
  container.replaceChildren();
  const parts = String(content || '').split(/```/);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const firstBreak = part.indexOf('\n');
      const language = firstBreak >= 0 ? part.slice(0, firstBreak).trim().slice(0, 30) : '';
      const code = firstBreak >= 0 ? part.slice(firstBreak + 1) : part;
      if (language) {
        const label = document.createElement('div');
        label.className = 'code-label';
        label.textContent = language;
        container.appendChild(label);
      }
      const pre = document.createElement('pre');
      const codeElement = document.createElement('code');
      codeElement.textContent = code;
      pre.appendChild(codeElement);
      container.appendChild(pre);
      return;
    }
    part.split(/\n{2,}/).filter((value) => value.length).forEach((paragraph) => {
      const p = document.createElement('p');
      p.textContent = paragraph;
      container.appendChild(p);
    });
  });
}

function createMessageElement(message, streaming = false) {
  const article = document.createElement('article');
  article.className = `message ${message.role}`;
  if (message.role === 'user') {
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = message.content;
    article.appendChild(body);
  } else {
    const mark = document.createElement('span');
    mark.className = 'brand-mark assistant-mark';
    mark.textContent = 'E';
    const content = document.createElement('div');
    content.className = `message-content${streaming ? ' typing-cursor' : ''}`;
    renderSafeContent(content, message.content);
    article.append(mark, content);
  }
  return article;
}

function renderMessages() {
  messages.replaceChildren();
  state.messages.forEach((message) => messages.appendChild(createMessageElement(message)));
  const hasMessages = state.messages.length > 0;
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
    remove.textContent = 'x';
    remove.setAttribute('aria-label', `Delete ${chat.title}`);
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

async function openChat(chatId) {
  if (state.generating || chatId === state.activeChatId) return;
  try {
    const payload = await api(`/api/chats/${encodeURIComponent(chatId)}`);
    state.activeChatId = chatId;
    state.messages = payload.messages;
    modelSelect.value = payload.chat.model;
    localStorage.setItem('etherking_model', modelSelect.value);
    renderChats();
    renderMessages();
    setSidebar(false);
    input.focus();
  } catch (error) {
    showToast(error.message);
  }
}

function startNewChat() {
  if (state.generating) return;
  state.activeChatId = null;
  state.messages = [];
  renderChats();
  renderMessages();
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

function setGenerating(value) {
  state.generating = value;
  composer.classList.toggle('generating', value);
  input.disabled = value;
  sendButton.disabled = value ? false : !input.value.trim();
}

async function ensureChat(content) {
  if (state.activeChatId) return state.activeChatId;
  const payload = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify({ title: content, model: modelSelect.value })
  });
  state.activeChatId = payload.chat.id;
  state.chats.unshift(payload.chat);
  renderChats();
  return state.activeChatId;
}

async function sendMessage(content) {
  setGenerating(true);
  let assistant = null;
  try {
    const chatId = await ensureChat(content);
    state.messages.push({ role: 'user', content });
    assistant = { role: 'assistant', content: '' };
    state.messages.push(assistant);
    renderMessages();

    const article = messages.lastElementChild;
    const contentElement = article.querySelector('.message-content');
    contentElement.classList.add('typing-cursor');
    state.abortController = new AbortController();
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCookie('etherking_csrf')
      },
      body: JSON.stringify({ content, model: modelSelect.value }),
      signal: state.abortController.signal
    });
    if (response.status === 401) return window.location.replace('/');
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Unable to generate a response.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      assistant.content += decoder.decode(value, { stream: true });
      renderSafeContent(contentElement, assistant.content);
      conversation.scrollTop = conversation.scrollHeight;
    }
    assistant.content += decoder.decode();
    contentElement.classList.remove('typing-cursor');
    await loadChats();
  } catch (error) {
    if (error.name === 'AbortError') {
      if (assistant && !assistant.content) state.messages.pop();
      showToast('Generation stopped.');
    } else {
      if (assistant) assistant.content = `Unable to respond: ${error.message}`;
      renderMessages();
      showToast(error.message);
    }
  } finally {
    state.abortController = null;
    setGenerating(false);
    input.focus();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.generating) {
    state.abortController?.abort();
    return;
  }
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  resizeInput();
  sendMessage(content);
});

modelSelect.addEventListener('change', () => localStorage.setItem('etherking_model', modelSelect.value));

async function loadModels() {
  const payload = await api('/api/models');
  modelSelect.replaceChildren();
  payload.models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.id} - ${model.provider}`;
    modelSelect.appendChild(option);
  });
  const saved = localStorage.getItem('etherking_model');
  if (saved && payload.models.some((model) => model.id === saved)) modelSelect.value = saved;
  else if (payload.models.some((model) => model.id === 'gpt-5.6-luna')) modelSelect.value = 'gpt-5.6-luna';
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

document.getElementById('usage-button').addEventListener('click', async () => {
  try {
    const payload = await api('/api/usage');
    const usageList = document.getElementById('usage-list');
    usageList.replaceChildren();
    payload.usage.sort((a, b) => a.group.localeCompare(b.group)).forEach((item) => {
      const row = document.createElement('div');
      row.className = 'usage-item';
      const copy = document.createElement('div');
      copy.className = 'usage-copy';
      const name = document.createElement('strong');
      name.textContent = `Group ${item.group}`;
      const count = document.createElement('span');
      count.textContent = `${item.used} / ${item.limit}`;
      const track = document.createElement('div');
      track.className = 'usage-track';
      const fill = document.createElement('span');
      fill.className = 'usage-fill';
      fill.style.width = `${Math.min((item.used / item.limit) * 100, 100)}%`;
      copy.append(name, count);
      track.appendChild(fill);
      row.append(copy, track);
      usageList.appendChild(row);
    });
    usageDialog.showModal();
  } catch (error) {
    showToast(error.message);
  }
});

async function initialize() {
  try {
    const session = await api('/api/session');
    if (!session.authenticated) return window.location.replace('/');
    applyUser(session.user);
    await Promise.all([loadModels(), loadChats()]);
    renderMessages();
    input.focus();
  } catch (error) {
    showToast(error.message);
  }
}

initialize();

