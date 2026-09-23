import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../src/renderer/react-dist',
    emptyOutDir: true,
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      name: 'AdminNav',
      fileName: 'admin-nav',
      formats: ['iife'],
    },
    rollupOptions: {
      output: {
        assetFileNames: 'admin-nav.[ext]',
      },
    },
  },
});
