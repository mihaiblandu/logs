<script setup>
import { computed, ref, watch } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import { MiniMap } from '@vue-flow/minimap';
import { api } from '../api.js';
import { SERVICES } from '../services.js';
import ServiceNode from './ServiceNode.vue';

const props = defineProps({ todo: Object });

// planned tree per scenario, so the graph shows up before the job has results
const plans = ref({});
watch(() => props.todo?.scenario, async (scenario) => {
  if (scenario && !plans.value[scenario]) {
    try { plans.value = { ...plans.value, [scenario]: (await api.plan(scenario)).plan }; } catch { /* retry on next change */ }
  }
}, { immediate: true });

const selectedNodeId = ref(null);
watch(() => props.todo?.id, () => { selectedNodeId.value = null; });

const COL = 250;
const ROW = 120;

/** Plan + results -> Vue Flow nodes/edges, laid out left-to-right as a tree. */
const graph = computed(() => {
  const todo = props.todo;
  const plan = todo && plans.value[todo.scenario];
  if (!plan) return { nodes: [], edges: [] };

  const results = new Map();
  (function index(r) { if (!r) return; results.set(r.id, r); (r.children ?? []).forEach(index); })(todo.cascade);
  const finished = ['ok', 'error'].includes(todo.cascade_status);

  const nodes = [];
  const edges = [];
  let leafRow = 0;
  (function place(p, depth, parent) {
    const r = results.get(p.id);
    const status = r?.status ?? (finished ? 'skipped' : todo.cascade_status === 'running' ? 'running' : 'pending');
    const childYs = p.children.map((c) => place(c, depth + 1, p));
    const y = childYs.length ? (Math.min(...childYs) + Math.max(...childYs)) / 2 : leafRow++ * ROW;
    nodes.push({
      id: p.id,
      type: 'service',
      position: { x: depth * COL, y },
      selected: p.id === selectedNodeId.value,
      data: { ...p, ...r, status, root: !parent, hasChildren: p.children.length > 0 },
    });
    if (parent) {
      edges.push({
        id: `${parent.id}->${p.id}`,
        source: parent.id,
        target: p.id,
        animated: status === 'running',
        label: r?.duration_ms != null ? `${r.duration_ms} ms` : undefined,
        style: { stroke: status === 'error' ? 'var(--error)' : status === 'ok' ? (SERVICES[p.service]?.color ?? 'var(--muted)') : 'var(--skipped)', strokeWidth: 2 },
      });
    }
    return y;
  })(plan, 0, null);
  return { nodes, edges };
});

const selectedNode = computed(() => graph.value.nodes.find((n) => n.id === selectedNodeId.value)?.data ?? null);
const KIBANA = import.meta.env.VITE_KIBANA_URL || 'http://localhost:5601';
// every log of the cascade (API request, queue job, all services) carries its trace_id
const logsUrl = computed(() => {
  const traceId = props.todo?.trace_id;
  if (!traceId) return null;
  const a = `(dataSource:(dataViewId:logs,type:dataView),query:(language:kuery,query:'trace_id:"${traceId}"'))`;
  return `${KIBANA}/app/discover#/?_a=${encodeURIComponent(a)}&_g=(time:(from:now-24h,to:now))`;
});

const { fitView } = useVueFlow();
watch(() => [props.todo?.id, graph.value.nodes.length], () => setTimeout(() => fitView({ padding: 0.2 }), 0));
</script>

<template>
  <section class="graph">
    <div v-if="!todo" class="empty muted">Select or add a todo to see its cascade.</div>
    <template v-else>
      <div class="bar">
        <div>
          <strong>{{ todo.title }}</strong>
          <span class="badge" :class="todo.cascade_status">{{ todo.cascade_status }}</span>
          <span class="muted"> · {{ todo.scenario }}</span>
        </div>
        <div v-if="todo.trace_id" class="links">
          <code class="muted">trace {{ todo.trace_id.slice(0, 12) }}…</code>
          <a :href="todo.trace_url" target="_blank" rel="noopener">Trace in Jaeger</a>
          <a v-if="logsUrl" :href="logsUrl" target="_blank" rel="noopener">Logs in Discover</a>
        </div>
      </div>
      <div class="canvas">
        <VueFlow
          :nodes="graph.nodes"
          :edges="graph.edges"
          :nodes-draggable="false"
          :nodes-connectable="false"
          :min-zoom="0.3"
          fit-view-on-init
          @node-click="({ node }) => (selectedNodeId = node.id)"
          @pane-click="selectedNodeId = null"
        >
          <template #node-service="nodeProps">
            <ServiceNode v-bind="nodeProps" />
          </template>
          <Background :gap="18" />
          <Controls :show-interactive="false" />
          <MiniMap pannable zoomable :node-color="(n) => SERVICES[n.data.service]?.color ?? '#999'" />
        </VueFlow>
        <aside v-if="selectedNode" class="details">
          <strong>{{ SERVICES[selectedNode.service]?.label }} · {{ selectedNode.id }}</strong>
          <dl>
            <dt>Status</dt><dd><span class="badge" :class="selectedNode.status">{{ selectedNode.status }}</span></dd>
            <dt>Duration</dt><dd>{{ selectedNode.duration_ms ?? '–' }} ms</dd>
            <dt>User (JWT sub)</dt><dd>{{ selectedNode.user_id ?? '–' }}</dd>
            <dt>Span</dt><dd><code>{{ selectedNode.span_id ?? '–' }}</code></dd>
            <dt v-if="selectedNode.error">Error</dt><dd v-if="selectedNode.error" class="err">{{ selectedNode.error }}</dd>
          </dl>
        </aside>
      </div>
    </template>
  </section>
</template>

<style scoped>
.graph { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.empty { margin: auto; padding: 24px; }
.bar {
  display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--panel);
}
.bar .badge { margin-left: 8px; }
.links { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.canvas { position: relative; flex: 1; min-height: 420px; }
.details {
  position: absolute; top: 12px; right: 12px; width: 240px; padding: 12px; z-index: 5;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); font-size: 12px;
}
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 8px 0 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
.err { color: var(--error); }
@media (max-width: 800px) { .details { position: static; width: auto; margin: 8px 16px; } }
</style>
