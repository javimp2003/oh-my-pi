import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { certificatesInDir, systemCaEnv } from "../src/system-ca";

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

		const env = await systemCaEnv({}, { certificates: async () => [ROOT_A, ROOT_B], dir });

		expect(env.NODE_EXTRA_CA_CERTS).toBe(path.join(dir, "omp-vscode-system-ca.pem"));
		expect(await fs.readFile(env.NODE_EXTRA_CA_CERTS!, "utf8")).toBe(`${ROOT_A}\n${ROOT_B.trim()}\n`);
	});

	it("keeps a bundle the user configured, in ompCustom.env or VS Code's environment", async () => {
		const dir = await tempDir();
		const certificates = async () => [ROOT_A];

		delete process.env.NODE_EXTRA_CA_CERTS;
		expect(await systemCaEnv({ NODE_EXTRA_CA_CERTS: "C:\\corp\\root.pem" }, { certificates, dir })).toEqual({});
		process.env.NODE_EXTRA_CA_CERTS = "/etc/corp/root.pem";
		expect(await systemCaEnv({}, { certificates, dir })).toEqual({});
	});

	it("adds nothing when the OS store cannot be read", async () => {
		delete process.env.NODE_EXTRA_CA_CERTS;
		expect(await systemCaEnv({}, { certificates: async () => [], dir: await tempDir() })).toEqual({});
	});
});

describe("certificatesInDir", () => {
	it("reads a proxy client's PEM bundles and DER certificates, ignoring other files", async () => {
		const dir = await tempDir();
		await fs.writeFile(path.join(dir, "nscacert.pem"), `${ROOT_A}\r\n${ROOT_B}`);
		const der = Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x01, 0x01]);
		await fs.writeFile(path.join(dir, "rootcaCert.cer"), der);
		await fs.writeFile(path.join(dir, "nsconfig.json"), "{}");

		const blocks = await certificatesInDir(dir);

		expect(blocks).toContain(ROOT_A);
		expect(blocks).toContain(ROOT_B.trim());
		expect(blocks).toContain(`-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----`);
		expect(blocks).toHaveLength(3);
	});

	it("finds nothing in a missing directory", async () => {
		expect(await certificatesInDir(path.join(await tempDir(), "absent"))).toEqual([]);
	});
});
