import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    server: {
      // O Vite desta versao nao reconhece `node:sqlite` como modulo nativo e tenta resolver o
      // arquivo, quebrando qualquer teste que importe o banco. Marcar como externo entrega ao Node,
      // que sabe o que fazer com ele.
      deps: { external: ['node:sqlite'] },
    },
  },
});
