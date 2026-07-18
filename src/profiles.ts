export type ProfileName = "scout" | "researcher" | "worker";

export interface Profile {
  thinking: "low" | "medium" | "high";
  tools: readonly string[];
  systemPrompt: string;
  writes: boolean;
}

export const PROFILES: Readonly<Record<ProfileName, Profile>> = Object.freeze({
  scout: Object.freeze({
    thinking: "low",
    tools: Object.freeze(["read", "grep", "find", "ls"]),
    writes: false,
    systemPrompt: "Inspect the assigned repository scope read-only. Return concrete file and symbol evidence, uncertainties, and a concise handoff. Do not modify files or delegate.",
  }),
  researcher: Object.freeze({
    thinking: "medium",
    tools: Object.freeze(["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content"]),
    writes: false,
    systemPrompt: "Research only the assigned question. Cite checked sources and distinguish evidence from uncertainty. Do not modify files or delegate.",
  }),
  worker: Object.freeze({
    thinking: "high",
    tools: Object.freeze(["read", "grep", "find", "ls", "bash", "edit", "write"]),
    writes: true,
    systemPrompt: "Implement only the bounded assigned task in this isolated checkout. Inspect first, run focused checks, report every changed file and skip, and do not delegate.",
  }),
});

export interface PiLaunch {
  name: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}

export function buildPiLaunch(profileName: ProfileName, runId: string): PiLaunch {
  const profile = PROFILES[profileName];
  const name = `${profileName}-${runId.slice(-8)}`;
  return {
    name,
    argv: [
      "pi",
      "--no-session",
      "--name", name,
      "--thinking", profile.thinking,
      "--tools", profile.tools.join(","),
      "--append-system-prompt", profile.systemPrompt,
    ],
    env: { PI_HERDR_SUBAGENT: "1" },
  };
}
