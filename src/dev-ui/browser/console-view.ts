import type { DevelopmentBootstrap } from "./contextvm-client";

export function consoleMarkup(bootstrap: DevelopmentBootstrap): string {
return `
  <header class="workspace-header"><h1>Development workspace</h1><p id="connection-status" class="status" aria-live="polite" aria-atomic="true">Disconnected</p><button id="connect">Connect</button></header>
  <div class="workspace-controls">
    <section aria-labelledby="funds-heading"><h2 id="funds-heading">Funds and limits</h2><p id="balance">Available: 0 sats · held: 0 sats · settled: 0 sats</p><p class="supporting">Model mode: <strong id="provider-mode">Loading</strong> · action ceiling: <strong>${bootstrap.actionCeilingSat} sats</strong>.</p><div class="row"><label>Cashu amount (sats)<input id="cashu-amount" inputmode="numeric" value="64"></label><button id="cashu" disabled>Fund with Cashu</button><button id="cashu-replay" disabled>Replay Cashu</button></div><div class="row"><label>NWC amount (sats)<input id="nwc-amount" inputmode="numeric" value="3750"></label><button id="nwc" disabled>Fund with NWC</button></div><p id="funding-status" class="status" aria-live="polite" aria-atomic="true"></p></section>
    <section aria-labelledby="generation-heading"><h2 id="generation-heading">Create or revise</h2><label>Focused idea<input id="idea" maxlength="512" value="A counter for a short focused task"></label><div class="row"><label>Maximum (sats)<input id="maximum" inputmode="numeric" value="${bootstrap.actionCeilingSat}"></label><button id="generate" class="primary" disabled>Generate napplet</button></div><label>Revision<input id="revision" maxlength="512" placeholder="Describe the bounded revision"></label><button id="revise" disabled>Revise selected version</button><button id="replay-revision" disabled>Replay last revision request</button><p id="generation-status" class="status" aria-live="polite" aria-atomic="true"></p><p id="generation-error" role="alert" aria-live="assertive"></p><dl id="generation-facts"></dl></section>
    <section id="continuation" aria-labelledby="continuation-heading" hidden><h2 id="continuation-heading">Paused action</h2><p id="pending-status" class="status"></p><button id="resume" class="primary">Resume</button></section>
  </div>
  <div class="workspace-results">
    <section id="execution-activity" aria-labelledby="activity-heading"></section>
    <section aria-labelledby="timeline-heading"><h2 id="timeline-heading">Session timeline</h2><ol id="timeline"></ol></section>
    <section aria-labelledby="versions-heading"><h2 id="versions-heading">Versions and preview</h2><ul id="versions"></ul><iframe id="preview" title="Verified napplet preview" hidden></iframe></section>
    <section aria-labelledby="publication-heading"><h2 id="publication-heading">Publication</h2><p id="publication-status">Publication unavailable in this development setup.</p></section>
  </div>`;
}
