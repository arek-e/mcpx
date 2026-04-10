import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSkills,
  saveSkill,
  registerSkill,
  recordExecution,
  searchSkills,
  generateSkillTypeDefs,
  type Skill,
} from "./skills.js";

let skillsDir: string;
let skills: Map<string, Skill>;

beforeEach(() => {
  skillsDir = join(tmpdir(), `mcpx-skills-test-${Date.now()}`);
  mkdirSync(skillsDir, { recursive: true });
  skills = new Map();
});

afterEach(() => {
  try {
    rmSync(skillsDir, { recursive: true });
  } catch {}
});

describe("registerSkill", () => {
  test("creates a new skill", () => {
    const skill = registerSkill(skillsDir, skills, {
      name: "find-errors",
      description: "Find error logs in Loki",
      code: 'const r = await grafana.queryLokiLogs({ logql: "{level=\\"error\\"}" }); return r;',
    });
    expect(skill.name).toBe("find-errors");
    expect(skill.trust).toBe("untrusted");
    expect(skill.stats.runs).toBe(0);
    expect(skills.has("find-errors")).toBe(true);
  });

  test("updates an existing skill preserving stats", () => {
    registerSkill(skillsDir, skills, {
      name: "my-skill",
      description: "v1",
      code: "return 1;",
    });
    recordExecution(skillsDir, skills, "my-skill", true);
    registerSkill(skillsDir, skills, {
      name: "my-skill",
      description: "v2",
      code: "return 2;",
    });
    const updated = skills.get("my-skill")!;
    expect(updated.description).toBe("v2");
    expect(updated.code).toBe("return 2;");
    expect(updated.stats.runs).toBe(1);
  });
});

describe("recordExecution", () => {
  test("increments success count", () => {
    registerSkill(skillsDir, skills, {
      name: "s1",
      description: "test",
      code: "return 1;",
    });
    recordExecution(skillsDir, skills, "s1", true);
    recordExecution(skillsDir, skills, "s1", true);
    expect(skills.get("s1")!.stats.successes).toBe(2);
    expect(skills.get("s1")!.stats.runs).toBe(2);
  });

  test("increments failure count", () => {
    registerSkill(skillsDir, skills, {
      name: "s1",
      description: "test",
      code: "return 1;",
    });
    recordExecution(skillsDir, skills, "s1", false);
    expect(skills.get("s1")!.stats.failures).toBe(1);
  });

  test("promotes to provisional at 10 runs with 90% success", () => {
    registerSkill(skillsDir, skills, {
      name: "s1",
      description: "test",
      code: "return 1;",
    });
    for (let i = 0; i < 9; i++) recordExecution(skillsDir, skills, "s1", true);
    expect(skills.get("s1")!.trust).toBe("untrusted");
    recordExecution(skillsDir, skills, "s1", true);
    expect(skills.get("s1")!.trust).toBe("provisional");
  });
});

describe("loadSkills", () => {
  test("loads skills from directory", () => {
    registerSkill(skillsDir, skills, {
      name: "a",
      description: "A",
      code: "return 'a';",
    });
    registerSkill(skillsDir, skills, {
      name: "b",
      description: "B",
      code: "return 'b';",
    });
    const loaded = loadSkills(skillsDir);
    expect(loaded.size).toBe(2);
    expect(loaded.get("a")!.description).toBe("A");
  });

  test("returns empty map for missing directory", () => {
    const loaded = loadSkills("/tmp/nonexistent-mcpx-skills-dir");
    expect(loaded.size).toBe(0);
  });
});

describe("searchSkills", () => {
  test("finds by name", () => {
    registerSkill(skillsDir, skills, {
      name: "find-errors",
      description: "Find errors",
      code: "",
    });
    registerSkill(skillsDir, skills, {
      name: "check-latency",
      description: "Check API latency",
      code: "",
    });
    const results = searchSkills(skills, "error");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("find-errors");
  });

  test("finds by description", () => {
    registerSkill(skillsDir, skills, {
      name: "s1",
      description: "Query Grafana dashboards",
      code: "",
    });
    const results = searchSkills(skills, "grafana");
    expect(results).toHaveLength(1);
  });
});

describe("generateSkillTypeDefs", () => {
  test("returns empty string for no skills", () => {
    expect(generateSkillTypeDefs(new Map())).toBe("");
  });

  test("generates type stubs with trust level", () => {
    registerSkill(skillsDir, skills, {
      name: "find-errors",
      description: "Find errors in Loki",
      code: "",
    });
    const defs = generateSkillTypeDefs(skills);
    expect(defs).toContain("skill_find_errors");
    expect(defs).toContain("[untrusted]");
    expect(defs).toContain("Find errors in Loki");
  });
});
