'use strict';

const root = document.documentElement;
const loginTab = document.getElementById('login-tab');
const registerTab = document.getElementById('register-tab');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const alertBox = document.getElementById('auth-alert');
const title = document.getElementById('auth-title');
const subtitle = document.getElementById('auth-subtitle');
const captchaDialog = document.getElementById('captcha-dialog');
const captchaMount = document.getElementById('captcha-mount');
const captchaAlert = document.getElementById('captcha-alert');
let captchaWidget = null;
let captchaRequest = null;

function requestHumanVerification() {
  if (!window.NexaCAPTCHA?.render) return Promise.reject(new Error('Human verification failed to load. Please refresh and try again.'));
  if (captchaRequest) return captchaRequest.promise;
  let resolveRequest;
  let rejectRequest;
  const promise = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  captchaRequest = { promise, resolve: resolveRequest, reject: rejectRequest };
  captchaAlert.hidden = true;
  if (!captchaWidget) {
    captchaWidget = window.NexaCAPTCHA.render(captchaMount, {
      onComplete(result) {
        if (!result?.success || !captchaRequest) return;
        const current = captchaRequest;
        captchaRequest = null;
        current.resolve({ verificationId: result.verificationId, responseToken: result.responseToken });
        captchaDialog.close();
      }
    });
  } else {
    captchaWidget.reset();
  }
  captchaDialog.showModal();
  return promise;
}

function cancelHumanVerification() {
  if (!captchaRequest) return;
  const current = captchaRequest;
  captchaRequest = null;
  current.reject(new Error('Human verification was cancelled.'));
}

document.getElementById('captcha-cancel').addEventListener('click', () => captchaDialog.close());
captchaDialog.addEventListener('close', cancelHumanVerification);
captchaDialog.addEventListener('cancel', cancelHumanVerification);

function setTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  root.dataset.theme = value;
  try { localStorage.setItem('etherking_theme', value); } catch {}
  document.querySelectorAll('.theme-toggle').forEach((button) => {
    const nextTheme = value === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Use ${nextTheme} theme`);
    button.title = `Use ${nextTheme} theme`;
  });
}

let savedTheme = '';
try { savedTheme = localStorage.getItem('etherking_theme') || ''; } catch {}
setTheme(savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.querySelectorAll('.theme-toggle').forEach((button) => {
  button.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
});

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
    data.captcha = await requestHumanVerification();
    let response;
    let payload;
    for (;;) {
      response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      payload = await response.json().catch(() => ({}));
      if (response.ok || payload.code !== 'CAPTCHA_REQUIRED') break;
      data.captcha = await requestHumanVerification();
    }
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

fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
  .then((response) => response.ok ? response.json() : null)
  .then((session) => {
    if (session?.authenticated) window.location.replace('/app');
  })
  .catch(() => {});
