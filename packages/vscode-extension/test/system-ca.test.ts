import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { systemCaEnv } from "../src/system-ca";

const ROOT_A = "-----BEGIN CERTIFICATE-----\nMIIBcorpA\n-----END CERTIFICATE-----";
const ROOT_B = "-----BEGIN CERTIFICATE-----\nMIIBcorpB\n-----END CERTIFICATE-----\n";

const dirs: string[] = [];
const inherited = process.env.NODE_EXTRA_CA_CERTS;

afterEach(async () => {
	if (inherited === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
	else process.env.NODE_EXTRA_CA_CERTS = inherited;
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vscode-ca-"));
	dirs.push(dir);
	return dir;
}

describe("systemCaEnv", () => {
	it("hands omp the OS store's certificates as one PEM bundle", async () => {
		delete process.env.NODE_EXTRA_CA_CERTS;
		const dir = await tempDir();

		const env = systemCaEnv({}, { certificates: () => [ROOT_A, ROOT_B], dir });

		expect(env.NODE_EXTRA_CA_CERTS).toBe(path.join(dir, "omp-vscode-system-ca.pem"));
		expect(await fs.readFile(env.NODE_EXTRA_CA_CERTS!, "utf8")).toBe(`${ROOT_A}\n${ROOT_B.trim()}\n`);
	});

	it("follows a store that changed since the last start", async () => {
		delete process.env.NODE_EXTRA_CA_CERTS;
		const dir = await tempDir();
		systemCaEnv({}, { certificates: () => [ROOT_A], dir });

		const env = systemCaEnv({}, { certificates: () => [ROOT_A, ROOT_B], dir });

		expect(await fs.readFile(env.NODE_EXTRA_CA_CERTS!, "utf8")).toContain("MIIBcorpB");
	});

	it("keeps a bundle the user configured, in ompCustom.env or VS Code's environment", async () => {
		const dir = await tempDir();
		const certificates = () => [ROOT_A];

		delete process.env.NODE_EXTRA_CA_CERTS;
		expect(systemCaEnv({ NODE_EXTRA_CA_CERTS: "C:\\corp\\root.pem" }, { certificates, dir })).toEqual({});
		process.env.NODE_EXTRA_CA_CERTS = "/etc/corp/root.pem";
		expect(systemCaEnv({}, { certificates, dir })).toEqual({});
	});

	it("adds nothing when the OS store has no certificates to add", async () => {
		delete process.env.NODE_EXTRA_CA_CERTS;
		expect(systemCaEnv({}, { certificates: () => [], dir: await tempDir() })).toEqual({});
	});
});
