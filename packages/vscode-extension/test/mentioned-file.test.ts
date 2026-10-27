import { describe, expect, it } from "bun:test";
import { mentionCandidates } from "../src/chat/mentioned-file";

const noWorkspace = { roots: ["/h/omp-sin-workspace"], sessionFile: "/s/2026_x.jsonl", home: "/h" };

describe("mentionCandidates", () => {
	it("resolves a relative path against the chat's own folder", () => {
		expect(mentionCandidates("informe.md", noWorkspace)).toEqual(["/h/omp-sin-workspace/informe.md"]);
	});

	it("expands a home-relative path", () => {
		expect(mentionCandidates("~/omp-sin-workspace/r.md", noWorkspace)).toEqual(["/h/omp-sin-workspace/r.md"]);
	});

	it("maps local:// into the session's artifacts directory and refuses escapes", () => {
		expect(mentionCandidates("local://plans/a%20b.md", noWorkspace)).toEqual(["/s/2026_x/local/plans/a b.md"]);
		expect(mentionCandidates("local://../evil.md", noWorkspace)).toEqual([]);
		expect(mentionCandidates("local://a.md", { ...noWorkspace, sessionFile: undefined })).toEqual([]);
	});

	it("also tries the decoded form of a percent-encoded path", () => {
		expect(mentionCandidates("a%20b.md", noWorkspace)).toEqual([
			"/h/omp-sin-workspace/a%20b.md",
			"/h/omp-sin-workspace/a b.md",
		]);
	});
});
