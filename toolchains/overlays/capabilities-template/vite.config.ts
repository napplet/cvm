import { defineConfig } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
import capabilities from './src/capabilities.json';
import authoring from './.napplet-cvm-authoring.json';

export default defineConfig({
  build: { modulePreload: { polyfill: false } },
  plugins: [nip5aManifest({
    nappletType: 'my-napplet',
    artifactMode: 'single-file',
    description: authoring.purpose,
    requires: capabilities.required,
    optional: capabilities.optional,
  })],
});
