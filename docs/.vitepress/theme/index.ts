import DefaultTheme from 'vitepress/theme';
import GuideScreenshot from './GuideScreenshot.vue';
import './custom.css';
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) { app.component('GuideScreenshot', GuideScreenshot); },
};
