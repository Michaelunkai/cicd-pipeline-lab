import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskStore, addTask, completeTask, listTasks, stats, nextAction } from '../src/taskflow.mjs';

test('addTask stores a task and assigns sequential ids', () => {
  const store = createTaskStore();
  const a = addTask(store, { title: 'write pipeline' });
  const b = addTask(store, { title: 'ship it', priority: 1 });
  assert.equal(a.id + 1, b.id);
  assert.equal(store.tasks.size, 2);
  assert.equal(a.priority, 2);
});

test('addTask rejects a missing title', () => {
  const store = createTaskStore();
  assert.throws(() => addTask(store, {}), /title is required/);
});

test('addTask rejects out-of-range priority', () => {
  const store = createTaskStore();
  assert.throws(() => addTask(store, { title: 'x', priority: 0 }), /priority/);
  assert.throws(() => addTask(store, { title: 'x', priority: 4 }), /priority/);
});

test('addTask rejects an unparseable due date', () => {
  const store = createTaskStore();
  assert.throws(() => addTask(store, { title: 'x', due: 'not-a-date' }), /due/);
});

test('completeTask stamps completedAt exactly once', () => {
  const store = createTaskStore();
  const t = addTask(store, { title: 'once' });
  assert.equal(t.completedAt, null);
  completeTask(store, t.id);
  assert.ok(t.completedAt);
  assert.throws(() => completeTask(store, t.id), /already completed/);
});

test('completeTask throws on unknown id', () => {
  assert.throws(() => completeTask(createTaskStore(), 999), /no task/);
});

test('listTasks filters by status', () => {
  const store = createTaskStore();
  const a = addTask(store, { title: 'a' });
  addTask(store, { title: 'b' });
  completeTask(store, a.id);
  assert.equal(listTasks(store).length, 2);
  assert.equal(listTasks(store, { status: 'open' }).length, 1);
  assert.equal(listTasks(store, { status: 'done' })[0].title, 'a');
});

test('listTasks sorts by priority then earliest due', () => {
  const store = createTaskStore();
  addTask(store, { title: 'later', priority: 3 });
  addTask(store, { title: 'urgent-no-due', priority: 1 });
  addTask(store, { title: 'urgent-due', priority: 1, due: '2026-01-01' });
  const titles = listTasks(store, { sort: 'priority' }).map(t => t.title);
  assert.deepEqual(titles, ['urgent-due', 'urgent-no-due', 'later']);
});

test('tasks without a due date sort after dated tasks on the same priority', () => {
  const store = createTaskStore();
  addTask(store, { title: 'no-due', priority: 1 });
  addTask(store, { title: 'dated', priority: 1, due: '2030-01-01' });
  assert.equal(listTasks(store, { sort: 'due' })[0].title, 'dated');
});

test('stats counts total, open, done', () => {
  const store = createTaskStore();
  const a = addTask(store, { title: 'a' });
  addTask(store, { title: 'b' });
  completeTask(store, a.id);
  assert.deepEqual(stats(store), { total: 2, open: 1, done: 1, overdue: 0 });
});

test('stats counts overdue open tasks against a supplied clock', () => {
  const store = createTaskStore();
  addTask(store, { title: 'late', due: '2020-01-01' });
  const s = stats(store, new Date('2026-10-28T00:00:00Z'));
  assert.equal(s.overdue, 1);
});

test('completed tasks are never overdue', () => {
  const store = createTaskStore();
  const t = addTask(store, { title: 'done-late', due: '2020-01-01' });
  completeTask(store, t.id);
  assert.equal(stats(store, new Date('2026-10-28T00:00:00Z')).overdue, 0);
});

test('nextAction returns the most urgent open task', () => {
  const store = createTaskStore();
  addTask(store, { title: 'chill', priority: 3 });
  const hot = addTask(store, { title: 'hot', priority: 1 });
  assert.equal(nextAction(store).id, hot.id);
});

test('nextAction returns null when nothing is open', () => {
  const store = createTaskStore();
  assert.equal(nextAction(store), null);
});
