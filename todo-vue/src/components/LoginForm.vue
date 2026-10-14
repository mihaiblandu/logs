<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const email = ref('demo@example.com');
const password = ref('password');
const error = ref('');
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await api.login(email.value, password.value);
  } catch (e) {
    error.value = e.status === 401 ? 'Wrong email or password' : e.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="login" @submit.prevent="submit">
    <h1>Cascade Todos</h1>
    <p class="muted">Log in to get a JWT. Every service in the cascade validates it.</p>
    <label>Email <input v-model="email" type="email" autocomplete="username" required /></label>
    <label>Password <input v-model="password" type="password" autocomplete="current-password" required /></label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button class="primary" :disabled="busy">{{ busy ? 'Logging in…' : 'Log in' }}</button>
  </form>
</template>

<style scoped>
.login {
  max-width: 360px; margin: 12vh auto; padding: 24px; display: flex; flex-direction: column; gap: 12px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow);
}
@media (max-width: 420px) { .login { margin: 24px 16px; } }
h1 { margin: 0; font-size: 20px; }
p { margin: 0; }
label { display: flex; flex-direction: column; gap: 4px; font-weight: 500; }
.error { color: var(--error); }
</style>
