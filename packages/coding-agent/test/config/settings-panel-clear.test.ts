import { afterEach, beforeAll, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";

let state: SettingsTestState | undefined;
let tempDir: TempDir;
let agentDir: string;
let projectDir: string;

beforeAll(async () => {
	await initTheme();
});

beforeEach(() => {
	state = beginSettingsTest();
	tempDir = TempDir.createSync("@pi-settings-panel-clear-");
	agentDir = tempDir.join("agent");
	projectDir = tempDir.join("project");
	for (const dir of [agentDir, projectDir]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	restoreSettingsTestState(state);
	state = undefined;
	AgentStorage.close();
	tempDir.removeSync();
});

it("clearing a settings-panel text field removes the key from config.yml so its env fallback applies again", async () => {
	Bun.env.SEARXNG_ENDPOINT = "https://env.example";
	Bun.env.HINDSIGHT_API_TOKEN = "env-secret";
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, YAML.stringify({ searxng: { endpoint: "https://cfg.example" }, temperature: 0.4 }));
	await Settings.init({ cwd: projectDir, agentDir });
	const host = createSettingsHost();
	// The panel edits the configured layers: env values are never shown or pre-filled.
	expect(host.get("hindsight.apiToken")).toBeUndefined();

	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: host,
			plugins: createPluginSettingsHost(projectDir),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);

	for (const ch of "searxng endpoint") selector.handleInput(ch);
	selector.handleInput("\n"); // open the text field
	selector.handleInput("\x15"); // clear it
	selector.handleInput("\n"); // submit

	expect(cfgSearxngEndpoint.get(settings)).toBe("https://env.example");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
});

it("edits previously config-only arrays and numbers through the same parser as omp config, then removes the override on reset", async () => {
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, YAML.stringify({ temperature: 0.4 }));
	await Settings.init({ cwd: projectDir, agentDir });
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(projectDir),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	for (const character of "retry.baseDelayMs") selector.handleInput(character);
	selector.handleInput("\n");
	selector.handleInput("\x15");
	for (const character of "1250") selector.handleInput(character);
	selector.handleInput("\n");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4, retry: { baseDelayMs: 1250 } });
	selector.handleInput("\x12");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
	selector.handleInput("\x1b");
	for (const character of "enabledModels") selector.handleInput(character);
	selector.handleInput("\n");
	selector.handleInput("\x15");
	for (const character of '["litellm/team-model"]') selector.handleInput(character);
	selector.handleInput("\n");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
		temperature: 0.4,
		enabledModels: ["litellm/team-model"],
	});
});

it("does not reveal a credential in the canonical parser's error or persist an invalid credential record", async () => {
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, YAML.stringify({ temperature: 0.4 }));
	await Settings.init({ cwd: projectDir, agentDir });
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(projectDir),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	for (const character of "images.urls.credentials") selector.handleInput(character);
	selector.handleInput("\n");
	selector.handleInput("\x15");
	for (const character of '{"token":"credential-error-canary"') selector.handleInput(character);
	selector.handleInput("\n");
	const rendered = Bun.stripANSI(selector.render(100).join("\n"));
	expect(rendered).toContain("Could not save credential");
	expect(rendered).not.toContain("credential-error-canary");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({ temperature: 0.4 });
});

it("masks a previously config-only token in search and while editing, then saves the actual replacement", async () => {
	const configPath = path.join(agentDir, "config.yml");
	await Bun.write(configPath, YAML.stringify({ auth: { broker: { token: "stored-credential-canary" } } }));
	await Settings.init({ cwd: projectDir, agentDir });
	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(projectDir),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	for (const character of "auth.broker.token") selector.handleInput(character);
	const search = Bun.stripANSI(selector.render(100).join("\n"));
	expect(search).toContain("auth.broker.token");
	expect(search).not.toContain("stored-credential-canary");
	selector.handleInput("\n");
	expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("stored-credential-canary");
	selector.handleInput("\x15");
	for (const character of "replacement-credential-canary") selector.handleInput(character);
	expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("replacement-credential-canary");
	selector.handleInput("\n");
	await settings.flush();
	expect(YAML.parse(await Bun.file(configPath).text())).toEqual({
		auth: { broker: { token: "replacement-credential-canary" } },
	});
});
