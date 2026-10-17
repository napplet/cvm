import { defineConfig } from 'vitepress';

const group = (text: string, prefix: string, pages: [string, string][]) => ({ text, items: pages.map(([text, path]) => ({ text, link: `/${prefix}/${path === "index" ? "" : path}` })) });
const users = group('Use applet.broker', 'users', [
  ['Start here', 'index'], ['Your first applet', 'quick-start'], ['Create and revise', 'create-and-revise'], ['Identity and saved projects', 'identity-and-projects'], ['Remix and explore', 'remix-and-explore'], ['Publish and share', 'publish-and-share'], ['Costs and limits', 'costs-and-limits'], ['Frequently asked questions', 'faq'], ['Troubleshooting', 'troubleshooting'], ['Glossary', 'glossary'],
]);
const operators = group('Self-host and operate', 'operators', [
  ['Choose your setup', 'index'], ['Local installation', 'quick-start'], ['Accounts and providers', 'providers'], ['Local models', 'local-models'], ['Configuration reference', 'configuration'], ['Static hosting', 'static-hosting'], ['Operations and backups', 'operations'], ['Security boundaries', 'security'],
]);
const implementers = group('Integrate the CVM', 'implementers', [
  ['Integration paths', 'index'], ['Connect with TypeScript', 'connect'], ['Use from an MCP client', 'mcp'], ['Generation workflow', 'workflow'], ['Tool reference', 'tools'], ['Schemas and examples', 'schemas'], ['Progress and errors', 'events-and-errors'],
]);
const developers = group('Develop and extend', 'developers', [
  ['Contributing', 'index'], ['Architecture', 'architecture'], ['Build a compatible CVM', 'your-own-cvm'], ['Why this schema', 'schema-design'], ['Propose a schema change', 'schema-changes'], ['Testing', 'testing'], ['Maintain the documentation', 'documentation'],
]);
const runbooks = group('Detailed runbooks', 'runbooks', [
  ['Development workspace', 'development-gui'], ['Local payments', 'development-payments'], ['Release certification', 'release-certification'], ['Deferred production work', 'production-readiness-deferred'],
]);

export default defineConfig({
  title: 'applet.broker',
  titleTemplate: ':title · Documentation',
  description: 'Create, host, integrate, and extend Nostr applets with napplet-cvm.',
  lang: 'en-US',
  base: '/docs/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: ['README.md', 'node_modules/**'],
  head: [['meta', { name: 'theme-color', content: '#f8f7f3' }]],
  themeConfig: {
    siteTitle: 'applet.broker / docs',
    nav: [{ text: 'Use', link: '/users/' }, { text: 'Self-host', link: '/operators/' }, { text: 'Integrate', link: '/implementers/' }, { text: 'Develop', link: '/developers/' }],
    sidebar: { '/users/': [users], '/operators/': [operators, runbooks], '/implementers/': [implementers], '/developers/': [developers, runbooks], '/runbooks/': [runbooks, operators] },
    search: { provider: 'local' },
    outline: [2, 3],
    editLink: { pattern: 'https://github.com/napplet/cvm/edit/main/docs/:path', text: 'Improve this page on GitHub' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/napplet/cvm' }],
    footer: { message: 'Small applets. Your identity. Your infrastructure.', copyright: 'napplet-cvm · Development documentation' },
  },
});
