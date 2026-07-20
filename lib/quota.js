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

function ensureRecord(data, userId, plan, windowName, now) {
  const definition = QUOTA_WINDOWS[windowName];
  let record = data.quotaUsage.find((item) => item.userId === userId && item.plan === plan && item.window === windowName);
  if (!record) {
    record = { userId, plan, window: windowName };
    resetRecord(record, definition, now);
    data.quotaUsage.push(record);
  } else if (!Number.isFinite(record.remainingPoints) || Date.parse(record.resetAt) <= now) {
    resetRecord(record, definition, now);
  }
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
    const records = Object.keys(QUOTA_WINDOWS).map((windowName) => ensureRecord(data, userId, plan, windowName, now));
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
      const record = data.quotaUsage.find((item) => item.userId === userId && item.plan === plan && item.window === windowName);
      if (!record || Date.parse(record.resetAt) <= now) continue;
      record.remainingPoints = Math.min(definition.capacity, Number(record.remainingPoints) + cost);
      record.updatedAt = new Date(now).toISOString();
    }
  });
}

async function getQuotaUsage(store, userId, planValues, now = Date.now()) {
  const plans = [...new Set(planValues.map(normalizePlan))];
  return store.mutate((data) => plans.map((plan) => {
    const windows = {};
    for (const [windowName, definition] of Object.entries(QUOTA_WINDOWS)) {
      const record = ensureRecord(data, userId, plan, windowName, now);
      windows[windowName] = serializeRecord(record, definition);
    }
    return { plan, cost: PLAN_COSTS[plan], windows };
  }));
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

