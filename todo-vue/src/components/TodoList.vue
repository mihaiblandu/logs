<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { STATUS_LABEL } from '../services.js';

const props = defineProps({ todos: Array, selectedId: Number });
const emit = defineEmits(['select', 'create', 'createAll', 'toggle', 'remove', 'rerun']);

const title = ref('');
const scenario = ref('all-ok');
const scenarios = ref(['all-ok']);
const descriptions = ref({});
onMounted(async () => {
  try {
    const plan = await api.plan('all-ok');
    scenarios.value = plan.scenarios;
    descriptions.value = plan.descriptions ?? {};
  } catch { /* keep default */ }
});

// latest todo per scenario (todos come newest first): one chip per scenario, all in one row
const latest = computed(() => {
  const by = {};
  for (const t of props.todos) by[t.scenario] ??= t;
  return by;
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
    <p class="muted hint" data-testid="scenario-description">{{ descriptions[scenario] }}</p>

    <div class="run-all">
      <button title="Create one todo per scenario" @click="emit('createAll', scenarios)">Run all scenarios ({{ scenarios.length }})</button>
    </div>
    <div class="strip" aria-label="Scenarios">
      <button v-for="s in scenarios" :key="s" class="chip" :class="latest[s]?.cascade_status ?? 'none'"
              :title="descriptions[s]" :data-scenario="s" @click="latest[s] && emit('select', latest[s].id)">
        <span class="dot" />{{ s }}
      </button>
    </div>

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
.hint { margin: -4px 0 0; font-size: 12px; min-height: 1em; }
.run-all { flex: none; }
.run-all button { width: 100%; }
.strip { display: flex; flex: none; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; font-size: 11px; white-space: nowrap; border-radius: 999px; }
.chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--skipped); }
.chip.ok .dot { background: var(--ok, #2f9e44); }
.chip.error .dot { background: var(--error); }
.chip.queued .dot, .chip.running .dot { background: var(--accent); }
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
