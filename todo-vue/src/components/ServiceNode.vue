<script setup>
import { Handle, Position } from '@vue-flow/core';
import { SERVICES, STATUS_LABEL } from '../services.js';

const props = defineProps({ data: Object, selected: Boolean });
const meta = SERVICES[props.data.service] ?? { label: props.data.service, lang: '', color: '#868e96' };
</script>

<template>
  <div class="node" :class="[data.status, { selected }]" :style="{ '--svc': meta.color }">
    <Handle v-if="!data.root" type="target" :position="Position.Left" />
    <div class="head">
      <span class="dot" />
      <strong>{{ meta.label }}</strong>
      <span class="id muted">{{ data.id }}</span>
    </div>
    <div class="lang muted">{{ meta.lang }}</div>
    <div class="foot">
      <span class="badge" :class="data.status">{{ STATUS_LABEL[data.status] }}</span>
      <span v-if="data.duration_ms != null" class="muted">{{ data.duration_ms }} ms</span>
      <span v-if="data.fail" class="planned" title="This scenario injects a failure here">⚡ fail</span>
    </div>
    <Handle v-if="data.hasChildren" type="source" :position="Position.Right" />
  </div>
</template>

<style scoped>
.node {
  width: 190px; padding: 10px 12px; border-radius: 10px; background: var(--panel);
  border: 1px solid var(--border); border-left: 5px solid var(--svc); box-shadow: var(--shadow);
  display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text);
}
.node.selected { outline: 2px solid var(--accent); }
.node.error { border-color: var(--error); border-left-color: var(--error); }
.node.skipped { opacity: .55; border-style: dashed; }
.head { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--svc); }
.id { margin-left: auto; font-family: ui-monospace, monospace; font-size: 11px; }
.foot { display: flex; align-items: center; gap: 8px; }
.planned { margin-left: auto; color: var(--error); font-weight: 600; }
</style>
