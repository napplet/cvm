const text = (value: string | undefined, limit: number) => (value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit);
const placeholder = /^(?:generated development napplet|untitled applet|my applet|napplet|cvm preview)$/iu;

/** Reuse verified metadata and the caller's saved project. This read-only path
 * never generates, evaluates applet code or spends additional model tokens. */
export function suggestPublicationMetadata(tags: readonly string[][], projectTitle: string | undefined, version: number) {
  const declaredTitle = text(tags.find(tag => tag[0] === "title")?.[1], 120);
  const declaredDescription = text(tags.find(tag => tag[0] === "description")?.[1], 500);
  const project = text(projectTitle, 500);
  const usefulProject = project && !placeholder.test(project) ? project : "";
  const shortProject = usefulProject.replace(/^(?:please\s+)?(?:create|build|make|design)\s+(?:me\s+)?(?:an?\s+)?/iu, "").split(/[.!?](?:\s|$)/u)[0]!.slice(0, 80);
  const title = declaredTitle && !placeholder.test(declaredTitle) ? declaredTitle : shortProject ? shortProject[0]!.toLocaleUpperCase() + shortProject.slice(1) : `Applet version ${version}`;
  return { title, description: declaredDescription || usefulProject || `A focused applet: ${title}.`, basis: declaredTitle && !placeholder.test(declaredTitle) && declaredDescription ? "manifest" as const : usefulProject ? "project" as const : "fallback" as const };
}
