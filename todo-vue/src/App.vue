<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, session } from './api.js';
import LoginForm from './components/LoginForm.vue';
import TodoList from './components/TodoList.vue';
import CascadeGraph from './components/CascadeGraph.vue';

const todos = ref([]);
const selectedId = ref(null);
const error = ref('');
const selected = computed(() => todos.value.find((t) => t.id === selectedId.value) ?? null);
const active = computed(() => todos.value.some((t) => ['queued', 'running'].includes(t.cascade_status)));

async function refresh() {
  try {
    todos.value = await api.todos();
    if (!selected.value && todos.value.length) selectedId.value = todos.value[0].id;
    error.value = '';
  } catch (e) {
    error.value = e.message;
  }
}

// poll while a cascade is queued or running
let timer = null;
watch(active, (on) => {
  clearInterval(timer);
  timer = on ? setInterval(refresh, 1000) : null;
});
onBeforeUnmount(() => clearInterval(timer));

watch(() => session.value?.token, (token) => {
  todos.value = [];
  selectedId.value = null;
  if (token) refresh();
}, { immediate: true });

// one todo per scenario; the list then shows them all cascading at once
async function runAll(scenarios) {
  const stamp = new Date().toLocaleTimeString();
  await run(async () => {
    let last;
    for (const s of scenarios) last = await api.createTodo(`${s} · ${stamp}`, s);
    return last;
  });
}

async function run(action) {
  try {
    const todo = await action();
    if (todo?.id) selectedId.value = todo.id;
    await refresh();
  } catch (e) {
    error.value = e.message;
  }
}
</script>

<template>
  <LoginForm v-if="!session" />
  <div v-else class="layout">
    <header>
      <div>
        <strong>Cascade Todos</strong>
        <span class="muted"> · every new todo runs a job that cascades through 6 services</span>
      </div>
      <div class="user">
        <span class="muted">{{ session.user.name }}</span>
        <button @click="api.logout()">Log out</button>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <main>
      <TodoList
        :todos="todos"
        :selected-id="selectedId"
        @select="selectedId = $event"
        @create="(title, scenario) => run(() => api.createTodo(title, scenario))"
        @create-all="runAll"
        @toggle="(t) => run(() => api.updateTodo(t.id, { done: !t.done }))"
        @remove="(t) => run(() => api.deleteTodo(t.id))"
        @rerun="(t, scenario) => run(() => api.rerun(t.id, scenario))"
      />
      <CascadeGraph :todo="selected" />
    </main>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; height: 100vh; }
header {
  display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel);
}
.user { display: flex; align-items: center; gap: 10px; }
main { flex: 1; display: grid; grid-template-columns: minmax(300px, 380px) 1fr; min-height: 0; }
.error { margin: 8px 16px 0; color: var(--error); }
@media (max-width: 800px) {
  .layout { height: auto; }
  main { grid-template-columns: 1fr; }
}
</style>
