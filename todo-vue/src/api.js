// Thin client for the Laravel API. The JWT is kept in localStorage for convenience only.
import { ref } from 'vue';

const TOKEN_KEY = 'cascade-todos.token';

function read() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { return null; }
}

export const session = ref(read()); // { token, user } | null

function save(value) {
  session.value = value;
  try { value ? localStorage.setItem(TOKEN_KEY, JSON.stringify(value)) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.value?.token) headers.Authorization = `Bearer ${session.value.token}`;

  const response = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401 && path !== '/login') save(null); // expired or invalid token
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

export const api = {
  async login(email, password) {
    const data = await request('POST', '/login', { email, password });
    save({ token: data.token, user: data.user });
  },
  logout: () => save(null),
  todos: () => request('GET', '/todos'),
  createTodo: (title, scenario) => request('POST', '/todos', { title, scenario }),
  updateTodo: (id, patch) => request('PATCH', `/todos/${id}`, patch),
  deleteTodo: (id) => request('DELETE', `/todos/${id}`),
  rerun: (id, scenario) => request('POST', `/todos/${id}/run`, { scenario }),
  plan: (scenario) => request('GET', `/cascade/plan?scenario=${encodeURIComponent(scenario)}`),
};
