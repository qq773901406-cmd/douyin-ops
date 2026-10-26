import { localInput } from './workspace-ui.js';

export function restorePendingForm(attempt, catalog) {
  if (!attempt || typeof attempt.key !== 'string' || !attempt.key || typeof attempt.fingerprint !== 'string') return null;
  let body;
  try { body = JSON.parse(attempt.fingerprint); } catch { return null; }
  if (!body || typeof body.kind !== 'string' || typeof body.name !== 'string' || !body.input || typeof body.input !== 'object' || Array.isArray(body.input) || typeof body.enabled !== 'boolean') return null;
  const definition = catalog.find(item => item.kind === body.kind), schedule = body.schedule;
  if (!definition || !schedule || !['once', 'daily', 'weekly'].includes(schedule.type)) return null;
  const at = localInput(schedule.type === 'once' ? schedule.at : schedule.startAt);
  if (!at) return null;
  const formDraft = { kind: body.kind, name: body.name, at, repeat: schedule.type };
  for (const field of definition.fields) {
    // An absent input was deliberately empty; applying catalog defaults would change the request.
    formDraft[field.name] = Object.hasOwn(body.input, field.name) ? body.input[field.name] : field.type === 'checkbox' ? false : field.type === 'platforms' ? [] : '';
    if (field.type === 'lines' && Array.isArray(formDraft[field.name])) formDraft[field.name] = formDraft[field.name].join('\n');
  }
  return { kind: body.kind, formDraft };
}

export function operationRequestBody(definition, kind, formDraft, intent) {
  const input = {};
  for (const field of definition.fields) {
    const raw = formDraft[field.name];
    if (field.type === 'checkbox') input[field.name] = raw === true;
    else if (field.type === 'platforms') input[field.name] = formDraft.platforms;
    else if (raw !== '' && raw !== undefined) input[field.name] = field.type === 'number' ? Number(raw) : field.type === 'lines' ? String(raw).split(/\r?\n/).map(s => s.trim()).filter(Boolean) : raw;
  }
  const first = new Date(formDraft.at), repeat = formDraft.repeat || 'once';
  if (!Number.isFinite(first.getTime())) throw new Error('请填写有效执行时间。');
  const schedule = repeat === 'once' ? { type: 'once', at: first.toISOString() } : { type: repeat, time: formDraft.at.slice(11, 16), timezone: 'Asia/Shanghai', startAt: first.toISOString(), ...(repeat === 'weekly' ? { daysOfWeek: [first.getDay()] } : {}) };
  return { name: formDraft.name, kind, input, schedule, enabled: intent === 'schedule' };
}
