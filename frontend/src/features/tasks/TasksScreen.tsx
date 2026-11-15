/**
 * The decoy (spec F2): an ordinary, working to-do list. Long-pressing the title opens the lock screen.
 * This is also exactly what a wrong password shows.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Icon } from '@/components/Icon';
import { useLongPress } from '@/hooks/useLongPress';
import type { Todo } from '@/lib/storage/db';
import { addTodo, deleteTodo, ensureSeeded, listTodos, updateTodo } from '@/lib/storage/decoy';
import { useSession } from '@/state/session';
import { describeDue, dueDateFor, isValidIsoDate, setDueDate, todayIso } from './dueDates';

export function TasksScreen() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [draft, setDraft] = useState('');
  const [draftDue, setDraftDue] = useState('');
  const setPhase = useSession((s) => s.setPhase);
  const dueTodayTaskId = useSession((s) => s.dueTodayTaskId);
  const longPress = useLongPress(() => setPhase('lock'));

  useEffect(() => {
    void ensureSeeded().then(listTodos).then(setTodos);
  }, []);

  const toggle = async (t: Todo) => {
    const next = { ...t, done: !t.done };
    await updateTodo(next);
    setTodos((list) => list.map((x) => (x.id === t.id ? next : x)));
  };

  const remove = async (t: Todo) => {
    await deleteTodo(t.id);
    setTodos((list) => list.filter((x) => x.id !== t.id));
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    const todo = await addTodo(draft);
    if (isValidIsoDate(draftDue)) setDueDate(todo.id, draftDue);
    setTodos((list) => [...list, todo]);
    setDraft('');
    setDraftDue('');
  };

  // Due dates are cosmetic and never stored; the task a notification named is due today.
  const dueOf = (t: Todo) => (t.id === dueTodayTaskId ? todayIso() : dueDateFor(t.id));

  const open = todos.filter((t) => !t.done).length;

  return (
    <div className="screen">
      <header className="topbar">
        <h1 {...longPress}>Tasks</h1>
      </header>
      <div className="scroll">
        <div className="content">
          <p className="muted small" style={{ margin: '0 4px 10px' }}>
            {open === 0 ? 'All done' : `${open} remaining`}
          </p>
          {todos.length > 0 && (
            <div className="list">
              {todos.map((t) => (
                <div key={t.id} className={`todo${t.done ? ' done' : ''}`}>
                  <button
                    className="check"
                    onClick={() => void toggle(t)}
                    aria-label={t.done ? `Mark "${t.title}" as not done` : `Mark "${t.title}" as done`}
                  >
                    {t.done && <Icon name="check" size={16} />}
                  </button>
                  <div className="todo-body">
                    <span className="title">{t.title}</span>
                    <DueLabel iso={dueOf(t)} done={t.done} />
                  </div>
                  <button className="icon-btn" onClick={() => void remove(t)} aria-label={`Delete "${t.title}"`}>
                    <Icon name="trash" size={20} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <form className="add-row" onSubmit={add}>
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task"
          aria-label="New task"
          maxLength={200}
        />
        <input
          className="input due-input"
          type="date"
          value={draftDue}
          min={todayIso()}
          onChange={(e) => setDraftDue(e.target.value)}
          aria-label="Due date"
        />
        <button className="btn" type="submit" aria-label="Add task" disabled={!draft.trim()}>
          <Icon name="plus" size={20} />
        </button>
      </form>
    </div>
  );
}

function DueLabel({ iso, done }: { iso: string; done: boolean }) {
  const { label, tone } = describeDue(iso);
  return <span className={`due due-${done ? 'done' : tone}`}>{label}</span>;
}
