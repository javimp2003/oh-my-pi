import { describe, expect, it } from "bun:test";
import { activityLabel, diffStats } from "../webview/chat/activity";

describe("activityLabel", () => {
	it("uses the progressive verb while running and the past tense afterwards", () => {
		expect(activityLabel("read", { path: "a.ts" }, "running").verb).toBe("Reading");
		expect(activityLabel("read", { path: "a.ts" }, "pending").verb).toBe("Reading");
		expect(activityLabel("read", { path: "a.ts" }, "done").verb).toBe("Read");
		expect(activityLabel("read", { path: "a.ts" }, "interrupted").verb).toBe("Read");
	});

	it("titles a bash row with the intent and puts the command beneath", () => {
		expect(activityLabel("bash", { command: "bun test\nbun run build" }, "running", "Running the tests")).toEqual({
			verb: "Bash",
			subject: { text: "Running the tests" },
			code: false,
			family: "run",
			detail: "$ bun test",
		});
		// Without an intent the command itself is the subject, in code font.
		expect(activityLabel("shell", { command: "ls -la" }, "done")).toEqual({
			verb: "Bash",
			subject: { text: "ls -la" },
			code: true,
			family: "run",
		});
	});

	it("names python and eval calls Code, with the first line of code", () => {
		expect(activityLabel("eval", { language: "py", code: "\nimport os\nprint(os.getcwd())" }, "done", "Checking cwd")).toEqual(
			{
				verb: "Code",
				subject: { text: "Checking cwd" },
				code: false,
				family: "code",
				detail: "import os",
			},
		);
		expect(activityLabel("python", { code: "print(1)" }, "running")).toEqual({
			verb: "Code",
			subject: { text: "print(1)" },
			code: true,
			family: "code",
		});
	});

	it("takes the edited file from a hashline patch header", () => {
		const label = activityLabel("edit", { input: "[src/a.ts#AB12]\nPUT >3:\n+x" }, "done");
		expect(label.verb).toBe("Edited");
		expect(label.subject?.path).toBe("src/a.ts");
		expect(label.code).toBe(false);
	});

	it("shows search patterns in code font but not searched paths", () => {
		expect(activityLabel("grep", { pattern: "TODO" }, "done").code).toBe(true);
		expect(activityLabel("glob", { path: "src" }, "done")).toEqual({
			verb: "Searched",
			subject: { text: "src", path: "src" },
			code: false,
			family: "search",
		});
	});

	it("falls back to the tool name for unknown tools", () => {
		expect(activityLabel("mystery_tool", {}, "error")).toEqual({
			verb: "Called mystery_tool",
			code: false,
			family: "other",
		});
		expect(activityLabel("mystery_tool", {}, "running").verb).toBe("Calling mystery_tool");
	});

	it("treats reading a web URL as a fetch", () => {
		const url = "https://docs.python.org/3/library/asyncio.html";
		expect(activityLabel("read", { path: url }, "done")).toEqual({
			verb: "Fetched",
			subject: { text: url, url },
			code: false,
			family: "web",
		});
		expect(activityLabel("read", { path: url }, "running").verb).toBe("Fetching");
		expect(activityLabel("read", { path: "src/a.ts" }, "done")).toMatchObject({ verb: "Read", family: "read" });
	});

	it("keeps internal URIs as plain text, not files", () => {
		expect(activityLabel("read", { path: "issue://owner/repo/12" }, "done")).toEqual({
			verb: "Read",
			subject: { text: "issue://owner/repo/12" },
			code: false,
			family: "read",
		});
	});

	it("names plan proposals instead of a write to xd://propose", () => {
		expect(activityLabel("write", { path: "xd://propose", content: "Add caching" }, "running")).toEqual({
			verb: "Proposing plan",
			subject: { text: "Add caching" },
			code: false,
			family: "plan",
		});
		expect(activityLabel("write", { path: "xd://propose", content: "Add caching" }, "done").verb).toBe(
			"Proposed plan",
		);
	});
});

describe("diffStats", () => {
	it("counts added and removed lines of omp's numbered diff", () => {
		expect(diffStats("+5|a\n+6|b\n-7|c\n 8|d")).toEqual({ added: 2, removed: 1 });
	});

	it("ignores unified diff file headers", () => {
		expect(diffStats("+++ a\n--- b")).toEqual({ added: 0, removed: 0 });
	});

	it("returns undefined without a diff", () => {
		expect(diffStats(undefined)).toBeUndefined();
		expect(diffStats("")).toBeUndefined();
	});
});
