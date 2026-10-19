import { describe, expect, it } from "bun:test";
import { SkillDescriptionCatalog } from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";

const description = [
	"Queries and changes the dev, pre and pro GCP environments through gcloud.",
	"Use when the user asks about Cloud Run services, GKE clusters, IAM bindings, buckets or quotas in any of the",
	"three projects, even if they do not mention GCP or gcloud by name. Covers listing, describing, deploying",
	"and updating resources.",
].join("\n");

const skill: Skill = {
	name: "gcp-console",
	description,
	filePath: "/skills/gcp-console/SKILL.md",
	baseDir: "/skills/gcp-console",
	source: "native:user",
};

describe("SkillDescriptionCatalog modes", () => {
	it("full mode lists the whole description on one line; compressed mode a bounded preview", () => {
		const [full] = new SkillDescriptionCatalog({ mode: "full" }).render([skill]);
		expect(full.description).toBe(description.replace(/\s+/g, " "));
		expect(full.description).toContain("updating resources.");

		const [compressed] = new SkillDescriptionCatalog({ mode: "compressed" }).render([skill]);
		expect(compressed.description.length).toBeLessThanOrEqual(100);
		expect(compressed.description).not.toContain("updating resources.");
	});
});
