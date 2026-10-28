/**
 * taskflow — the sample application this pipeline ships.
 *
 * A tiny in-memory task store. It exists to be pipelined: linted, tested,
 * built, scanned, packaged, and promoted dev → staging → prod.
 */

let nextId = 1;

export function createTaskStore() {
  return { tasks: new Map() };
}

export function addTask(store, { title, priority = 2, due = null }) {
  if (!title || typeof title !== 'string') throw new Error('title is required');
  if (!Number.isInteger(priority) || priority < 1 || priority > 3) {
    throw new Error('priority must be an integer 1 (urgent) .. 3 (whenever)');
  }
  if (due !== null && Number.isNaN(Date.parse(due))) throw new Error('due must be an ISO date string or null');
  const task = { id: nextId++, title, priority, due, createdAt: new Date().toISOString(), completedAt: null };
  store.tasks.set(task.id, task);
  return task;
}

export function completeTask(store, id) {
  const task = store.tasks.get(id);
  if (!task) throw new Error(`no task with id ${id}`);
  if (task.completedAt) throw new Error(`task ${id} already completed`);
  task.completedAt = new Date().toISOString();
  return task;
}

export function listTasks(store, { status = 'all', sort = 'created' } = {}) {
  let tasks = [...store.tasks.values()];
  if (status === 'open') tasks = tasks.filter(t => !t.completedAt);
  if (status === 'done') tasks = tasks.filter(t => t.completedAt);
  const dueTime = t => (t.due ? Date.parse(t.due) : Number.MAX_SAFE_INTEGER);
  const comparators = {
    created: (a, b) => a.id - b.id,
    priority: (a, b) => a.priority - b.priority || dueTime(a) - dueTime(b),
    due: (a, b) => dueTime(a) - dueTime(b),
  };
  tasks.sort(comparators[sort] ?? comparators.created);
  return tasks;
}

export function stats(store, now = new Date()) {
  const all = [...store.tasks.values()];
  const done = all.filter(t => t.completedAt).length;
  const open = all.length - done;
  const overdue = all.filter(t => !t.completedAt && t.due && Date.parse(t.due) < now.getTime()).length;
  return { total: all.length, open, done, overdue };
}

export function nextAction(store) {
  return listTasks(store, { status: 'open', sort: 'priority' })[0] ?? null;
}
