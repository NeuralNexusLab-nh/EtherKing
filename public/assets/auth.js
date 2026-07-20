'use strict';

const root = document.documentElement;
const loginTab = document.getElementById('login-tab');
const registerTab = document.getElementById('register-tab');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const alertBox = document.getElementById('auth-alert');
const title = document.getElementById('auth-title');
const subtitle = document.getElementById('auth-subtitle');

function setTheme(theme) {
  const value = theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = value;
  localStorage.setItem('etherking_theme', value);
}

setTheme(localStorage.getItem('etherking_theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
document.querySelector('.theme-toggle').addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

function setMode(mode) {
  const registering = mode === 'register';
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  loginTab.classList.toggle('active', !registering);
  registerTab.classList.toggle('active', registering);
  loginTab.setAttribute('aria-selected', String(!registering));
  registerTab.setAttribute('aria-selected', String(registering));
  title.textContent = registering ? 'Create your account' : 'Welcome back';
  subtitle.textContent = registering ? 'Save conversations securely across your devices.' : 'Sign in to continue your conversations.';
  alertBox.hidden = true;
  const firstInput = (registering ? registerForm : loginForm).querySelector('input');
  firstInput.focus();
}

loginTab.addEventListener('click', () => setMode('login'));
registerTab.addEventListener('click', () => setMode('register'));

function showError(message) {
  alertBox.textContent = message || 'Something went wrong. Please try again.';
  alertBox.hidden = false;
}

async function submitAuth(form, endpoint) {
  alertBox.hidden = true;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Please wait...';
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to continue.');
    window.location.replace('/app');
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth(loginForm, '/api/auth/login');
});

registerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth(registerForm, '/api/auth/register');
});

fetch('/api/session', { credentials: 'same-origin' })
  .then((response) => response.ok ? response.json() : null)
  .then((session) => {
    if (session?.authenticated) window.location.replace('/app');
  })
  .catch(() => {});

