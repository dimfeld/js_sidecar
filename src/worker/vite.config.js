import { defineConfig } from 'vite';
import nodeExternals from 'rollup-plugin-node-externals';

const production = process.env.NODE_ENV === 'production';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: ['node20'],
    sourcemap: true,
    minify: production,
    rollupOptions: {
      input: 'src/index.ts',
    },
  },
  plugins: [nodeExternals()],
  ssr: {
    noExternal: ['lru-cache'],
  },
});
