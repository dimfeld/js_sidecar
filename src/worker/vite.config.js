import { defineConfig } from 'vite';

const production = process.env.NODE_ENV === 'production';


export default defineConfig({
  build: {
    outDir: 'dist',
    target: ['node20'],
    sourcemap: true,
    assetsDir: production ? '_app/immutable' : '_app/dev',
    copyPublicDir: true,
    manifest: true,
    minify: production,
    rollupOptions: {
      input: "src/index.ts"
    }
  },
});
