<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
import { STATUS_LABEL } from '../services.js';

defineProps({ todos: Array, selectedId: Number });
const emit = defineEmits(['select', 'create', 'toggle', 'remove', 'rerun']);

const title = ref('');
const scenario = ref('all-ok');
const scenarios = ref(['all-ok']);
onMounted(async () => {
  try { scenarios.value = (await api.plan('all-ok')).scenarios; } catch { /* keep default */ }
});

function submit() {
  if (!title.value.trim()) return;
  emit('create', title.value.trim(), scenario.value);
  title.value = '';
}
</script>

<template>
  <section class="todos">
    <form class="add" @submit.prevent="submit">
      <input v-model="title" type="text" placeholder="What needs doing?" aria-label="New todo" maxlength="200" />
      <select v-model="scenario" aria-label="Cascade scenario">
        <option v-for="s in scenarios" :key="s" :value="s">{{ s }}</option>
      </select>
      <button class="primary">Add</button>
    </form>

    <p v-if="!todos.length" class="muted empty">No todos yet. Adding one starts a cascade.</p>
    <ul>
      <li v-for="t in todos" :key="t.id" :class="{ selected: t.id === selectedId }" @click="emit('select', t.id)">
        <input type="checkbox" :checked="t.done" :aria-label="`Done: ${t.title}`" @click.stop @change="emit('toggle', t)" />
        <div class="body">
          <span class="title" :class="{ done: t.done }">{{ t.title }}</span>
          <span class="meta">
            <span class="badge" :class="t.cascade_status">{{ STATUS_LABEL[t.cascade_status] }}</span>
            <span class="muted">{{ t.scenario }}</span>
          </span>
        </div>
        <div class="actions">
          <button title="Run the cascade again" :disabled="['queued', 'running'].includes(t.cascade_status)"
                  @click.stop="emit('rerun', t, scenario)">Re-run</button>
          <button title="Delete" aria-label="Delete" @click.stop="emit('remove', t)">✕</button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.todos { border-right: 1px solid var(--border); overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.add { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; }
.empty { margin: 8px 0; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
li {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
}
li.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.title.done { text-decoration: line-through; color: var(--muted); }
.meta { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.actions { display: flex; gap: 4px; }
.actions button { padding: 4px 8px; font-size: 12px; }
@media (max-width: 800px) { .todos { border-right: 0; border-bottom: 1px solid var(--border); } }
</style>
