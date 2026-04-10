import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, watch } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  trust: TrustLevel;
  stats: { runs: number; successes: number; failures: number };
  createdAt: string;
  updatedAt: string;
}

export type TrustLevel = "untrusted" | "provisional" | "trusted";

function computeTrust(stats: Skill["stats"]): TrustLevel {
  if (stats.runs >= 100 && stats.successes / stats.runs >= 0.95) return "trusted";
  if (stats.runs >= 10 && stats.successes / stats.runs >= 0.9) return "provisional";
  return "untrusted";
}

/** Load all skills from .mcpx/skills/ directory */
export function loadSkills(skillsDir: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  if (!existsSync(skillsDir)) return skills;

  for (const file of readdirSync(skillsDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(skillsDir, file), "utf-8");
      const skill: Skill = JSON.parse(raw);
      skills.set(skill.name, skill);
    } catch {
      // skip invalid files
    }
  }

  return skills;
}

/** Save a skill to disk */
export function saveSkill(skillsDir: string, skill: Skill): void {
  mkdirSync(skillsDir, { recursive: true });
  const filename = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`;
  writeFileSync(join(skillsDir, filename), JSON.stringify(skill, null, 2) + "\n");
}

/** Register a new skill from working code */
export function registerSkill(
  skillsDir: string,
  skills: Map<string, Skill>,
  params: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    code: string;
  },
): Skill {
  const now = new Date().toISOString();
  const existing = skills.get(params.name);

  const skill: Skill = {
    name: params.name,
    description: params.description,
    inputSchema: params.inputSchema ?? { type: "object", properties: {} },
    code: params.code,
    trust: existing?.trust ?? "untrusted",
    stats: existing?.stats ?? { runs: 0, successes: 0, failures: 0 },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  skills.set(skill.name, skill);
  saveSkill(skillsDir, skill);
  return skill;
}

/** Record execution result for trust progression */
export function recordExecution(
  skillsDir: string,
  skills: Map<string, Skill>,
  name: string,
  success: boolean,
): void {
  const skill = skills.get(name);
  if (!skill) return;

  if (success) skill.stats.successes++;
  else skill.stats.failures++;
  skill.stats.runs++;
  skill.trust = computeTrust(skill.stats);
  skill.updatedAt = new Date().toISOString();

  saveSkill(skillsDir, skill);
}

/** Search skills by query (simple text matching) */
export function searchSkills(skills: Map<string, Skill>, query: string): Skill[] {
  const q = query.toLowerCase();
  return Array.from(skills.values()).filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
}

/** Watch skills directory for changes */
export function watchSkills(
  skillsDir: string,
  skills: Map<string, Skill>,
  onChange?: () => void,
): () => void {
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true });
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(skillsDir, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      const fresh = loadSkills(skillsDir);
      skills.clear();
      for (const [name, skill] of fresh) {
        skills.set(name, skill);
      }
      onChange?.();
    }, 500);
  });

  return () => {
    if (debounce) clearTimeout(debounce);
    watcher.close();
  };
}

/** Generate type stubs for skills (for LLM context) */
export function generateSkillTypeDefs(skills: Map<string, Skill>): string {
  if (skills.size === 0) return "";

  const lines: string[] = ["// === Saved Skills ==="];
  for (const skill of skills.values()) {
    const params = skill.inputSchema?.properties
      ? Object.entries(skill.inputSchema.properties as Record<string, { type?: string }>)
          .map(([k, v]) => `${k}: ${v.type ?? "any"}`)
          .join(", ")
      : "";
    lines.push(
      `// [${skill.trust}] ${skill.description}`,
      `declare function skill_${skill.name.replace(/[^a-zA-Z0-9_]/g, "_")}(args: { ${params} }): Promise<any>;`,
      "",
    );
  }
  return lines.join("\n");
}
