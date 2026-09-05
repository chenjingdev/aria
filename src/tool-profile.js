// The public profile matches the benchmark's exposed MCP surface. Full
// capabilities remain available explicitly for development and experiments.
export const RELEASE_HIDDEN_TOOLS = Object.freeze([
  "list_feedback", "resolve_feedback", "add_feedback", "ab_save", "ab_load",
  "list_songs", "load_song", "import_midi"
]);

export function profileHiddenTools(env = process.env) {
  const profile = env.ARIA_TOOL_PROFILE ?? "release";
  if (!["release", "full"].includes(profile))
    throw new Error(`ARIA_TOOL_PROFILE은 release 또는 full이어야 합니다 (받은 값: ${profile})`);
  const extra = (env.ARIA_HIDE_TOOLS ?? "").split(/[\s,]+/).filter(Boolean);
  return [...new Set([...(profile === "release" ? RELEASE_HIDDEN_TOOLS : []), ...extra])];
}
