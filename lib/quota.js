'use strict';

const QUOTA_WINDOWS = Object.freeze({
  fiveHour: Object.freeze({ label: '5-hour limit', capacity: 100, durationMs: 5 * 60 * 60 * 1000 }),
  weekly: Object.freeze({ label: 'Weekly limit', capacity: 1000, durationMs: 7 * 24 * 60 * 60 * 1000 })
});

const PLAN_COSTS = Object.freeze({
  pro: 5,
  plus: 3,
  basic: 1.5
});

const LEGACY_PLANS = Object.freeze({ B: 'pro', C: 'plus', D: 'basic' });

function normalizePlan(value) {
  const plan = LEGACY_PLANS[value] || String(value || '').toLowerCase();
  if (!Object.hasOwn(PLAN_COSTS, plan)) throw new Error('Unknown quota plan.');
  return plan;
}

function resetRecord(record, definition, now) {
  record.remainingPoints = definition.capacity;
  record.windowStartedAt = new Date(now).toISOString();
  record.resetAt = new Date(now + definition.durationMs).toISOString();
  record.updatedAt = new Date(now).toISOString();
  return record;
}

function ensureRecord(data, userId, windowName, now) {
  const definition = QUOTA_WINDOWS[windowName];
  const matching = data.quotaUsage.filter((item) => item.userId === userId && item.window === windowName);
  const active = matching.filter((item) => Number.isFinite(item.remainingPoints) && Date.parse(item.resetAt) > now);
  data.quotaUsage = data.quotaUsage.filter((item) => item.userId !== userId || item.window !== windowName);

  let record = { userId, window: windowName };
  if (active.length) {
    const spentPoints = active.reduce((total, item) => total + (definition.capacity - Math.min(definition.capacity, Number(item.remainingPoints))), 0);
    record.remainingPoints = definition.capacity - spentPoints;
    record.windowStartedAt = new Date(Math.min(...active.map((item) => Date.parse(item.windowStartedAt) || now))).toISOString();
    record.resetAt = new Date(Math.min(...active.map((item) => Date.parse(item.resetAt)))).toISOString();
    record.updatedAt = new Date(now).toISOString();
  } else {
    resetRecord(record, definition, now);
  }
  data.quotaUsage.push(record);
  return record;
}

function serializeRecord(record, definition) {
  const remainingPoints = Number(record.remainingPoints);
  const percent = Math.max(0, Math.min(100, (remainingPoints / definition.capacity) * 100));
  return {
    remainingPercent: Math.round(percent * 10) / 10,
    resetAt: record.resetAt
  };
}

async function reserveQuota(store, userId, planValue, costValue, now = Date.now()) {
  const plan = normalizePlan(planValue);
  const cost = Number(costValue ?? PLAN_COSTS[plan]);
  if (!Number.isFinite(cost) || cost <= 0) throw new Error('Quota cost is invalid.');
  return store.mutate((data) => {
    const records = Object.keys(QUOTA_WINDOWS).map((windowName) => ensureRecord(data, userId, windowName, now));
    if (records.some((record) => record.remainingPoints <= 0)) return null;
    for (const record of records) {
      record.remainingPoints -= cost;
      record.updatedAt = new Date(now).toISOString();
    }
    return Object.fromEntries(records.map((record) => [record.window, serializeRecord(record, QUOTA_WINDOWS[record.window])]));
  });
}

async function releaseQuota(store, userId, planValue, costValue, now = Date.now()) {
  const plan = normalizePlan(planValue);
  const cost = Number(costValue ?? PLAN_COSTS[plan]);
  await store.mutate((data) => {
    for (const [windowName, definition] of Object.entries(QUOTA_WINDOWS)) {
      const record = ensureRecord(data, userId, windowName, now);
      record.remainingPoints = Math.min(definition.capacity, Number(record.remainingPoints) + cost);
      record.updatedAt = new Date(now).toISOString();
    }
  });
}

async function getQuotaUsage(store, userId, now = Date.now()) {
  return store.mutate((data) => {
    const windows = {};
    for (const [windowName, definition] of Object.entries(QUOTA_WINDOWS)) {
      const record = ensureRecord(data, userId, windowName, now);
      windows[windowName] = serializeRecord(record, definition);
    }
    return { windows };
  });
}

module.exports = {
  LEGACY_PLANS,
  PLAN_COSTS,
  QUOTA_WINDOWS,
  getQuotaUsage,
  normalizePlan,
  releaseQuota,
  reserveQuota
};

