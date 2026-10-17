<script setup lang="ts">
import { withBase } from 'vitepress';
import { computed } from 'vue';
import captures from '../../public/images/users/capture.json';
const props = defineProps<{ name: string; alt: string; caption: string }>();
const dimensions = computed(() => captures.screenshots.find(image => image.file === `${props.name}.png`));
</script>

<template>
  <figure class="guide-screenshot">
    <a :href="withBase(`/images/users/${name}.png`)" target="_blank" rel="noopener"
       :aria-label="`Open full-size screenshot: ${alt}`">
      <img :src="withBase(`/images/users/${name}.png`)" :alt="alt" :width="dimensions?.width" :height="dimensions?.height" loading="lazy" decoding="async">
    </a>
    <figcaption>
      {{ caption }} <span class="screenshot-example">Sample workspace.</span>
      <a :href="withBase(`/images/users/${name}.png`)" target="_blank" rel="noopener">Open full size ↗</a>
    </figcaption>
  </figure>
</template>
