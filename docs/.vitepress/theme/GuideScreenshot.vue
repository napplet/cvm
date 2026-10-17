<script setup lang="ts">
import { withBase } from 'vitepress';
import { computed } from 'vue';
import userCaptures from '../../public/images/users/capture.json';
import operatorCaptures from '../../public/images/operators/capture.json';
const props = withDefaults(defineProps<{ name: string; alt: string; caption: string; audience?: 'users' | 'operators' }>(), { audience: 'users' });
const catalogs = { users: userCaptures, operators: operatorCaptures };
const dimensions = computed(() => catalogs[props.audience].screenshots.find(image => image.file === `${props.name}.png`));
const source = computed(() => withBase(`/images/${props.audience}/${props.name}.png`));
</script>

<template>
  <figure class="guide-screenshot">
    <a :href="source" target="_blank" rel="noopener"
       :aria-label="`Open full-size screenshot: ${alt}`">
      <img :src="source" :alt="alt" :width="dimensions?.width" :height="dimensions?.height" loading="lazy" decoding="async">
    </a>
    <figcaption>
      {{ caption }} <span class="screenshot-example">{{ audience === 'operators' ? 'Sample admin.' : 'Sample workspace.' }}</span>
      <a :href="source" target="_blank" rel="noopener" :aria-label="`Open full-size screenshot: ${alt}`">Open full size ↗</a>
    </figcaption>
  </figure>
</template>
