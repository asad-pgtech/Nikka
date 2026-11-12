/** Decoy task list (spec F2): functional, unencrypted, seeded once with a fixed plausible set. */
import { getDb, type Todo } from './db';

export const SEED_TASKS: ReadonlyArray<Pick<Todo, 'title' | 'done'>> = [
  { title: 'Buy groceries', done: false },
  { title: 'Call the dentist to reschedule', done: false },
  { title: 'Pay electricity bill', done: true },
  { title: 'Pick up dry cleaning', done: false },
  { title: 'Water the plants', done: true },
  { title: 'Renew gym membership', done: false },
];

export async function ensureSeeded(): Promise<void> {
  const db = await getDb();
  if (await db.get('meta', 'decoySeeded')) return;
  const tx = db.transaction(['todos', 'meta'], 'readwrite');
  const base = Date.UTC(2025, 0, 6, 9, 0, 0);
  await Promise.all(
    SEED_TASKS.map((t, i) =>
      tx.objectStore('todos').put({ id: `seed-${i}`, title: t.title, done: t.done, createdAt: base + i * 60_000 }),
    ),
  );
  await tx.objectStore('meta').put(true, 'decoySeeded');
  await tx.done;
}

export async function listTodos(): Promise<Todo[]> {
  const all = await (await getDb()).getAll('todos');
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function addTodo(title: string): Promise<Todo> {
  const todo: Todo = { id: crypto.randomUUID(), title: title.trim(), done: false, createdAt: Date.now() };
  await (await getDb()).put('todos', todo);
  return todo;
}

export async function updateTodo(todo: Todo): Promise<void> {
  await (await getDb()).put('todos', todo);
}

export async function deleteTodo(id: string): Promise<void> {
  await (await getDb()).delete('todos', id);
}
