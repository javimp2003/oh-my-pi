/**
 * Trust for omp's HTTPS requests behind a TLS-inspecting network.
 *
 * Company networks often re-sign HTTPS with their own root certificate, which
 * IT installs in the OS certificate store: browsers and VS Code trust it, but
 * omp (a Bun program) trusts only its built-in roots and fails with "self
 * signed certificate in certificate chain". The extension exports the OS
 * store to a PEM file and hands it to omp as `NODE_EXTRA_CA_CERTS`, which adds
 * those certificates to its roots.
 *
 * The store is read with the OS's own tools, because Node inside VS Code
 * (Electron, built on BoringSSL) cannot be relied on to enumerate it:
 * PowerShell's `Cert:` drive on Windows (the trusted root stores, which also
 * show the roots group policy deploys), the admin-managed system keychain on
 * macOS, and the distribution bundle on Linux. Only trusted roots are read:
 * a certificate the OS would not trust must not become trusted for omp.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Windows trusted root stores (machine, user, and third-party roots). */
const WINDOWS_STORES = ["Cert:\\LocalMachine\\Root", "Cert:\\CurrentUser\\Root", "Cert:\\LocalMachine\\AuthRoot"];
const WINDOWS_EXPORT = `$ErrorActionPreference='SilentlyContinue'; Get-ChildItem ${WINDOWS_STORES.join(",")} | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks'); '-----END CERTIFICATE-----' }`;
const LINUX_BUNDLES = [
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/ssl/cert.pem",
];

function run(command: string, args: readonly string[]): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	execFile(command, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20_000 }, (_error, stdout) =>
		resolve(stdout ?? ""),
	);
	return promise;
}

/**
 * Where the Netskope client (a common TLS-inspecting proxy) keeps its CA
 * certificates (`nscacert.pem`, `rootcaCert.cer`, …); its own docs point
 * Node tools at them. The directories are admin-managed.
 */
const NETSKOPE_DIRS =
	process.platform === "win32"
		? [path.join(process.env.ProgramData ?? "C:\\ProgramData", "Netskope", "stagent", "data")]
		: process.platform === "darwin"
			? ["/Library/Application Support/Netskope/STAgent/data"]
			: [];

/** The OS store's certificates plus a TLS-inspecting client's own, as PEM blocks (deduplicated). */
export async function osCertificates(): Promise<string[]> {
	let output = "";
	if (process.platform === "win32") {
		output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_EXPORT]);
	} else if (process.platform === "darwin") {
		output = await run("security", ["find-certificate", "-a", "-p", "/Library/Keychains/System.keychain"]);
	} else {
		for (const bundle of LINUX_BUNDLES) {
			output = await fs.readFile(bundle, "utf8").catch(() => "");
			if (output) break;
		}
	}
	const blocks = pemBlocks(output);
	for (const dir of NETSKOPE_DIRS) blocks.push(...(await certificatesInDir(dir)));
	return [...new Set(blocks)];
}

/**
 * Certificates in the `.pem`/`.crt`/`.cer` files of `dir`, PEM or DER, as PEM
 * blocks; empty when the directory is missing or unreadable.
 */
export async function certificatesInDir(dir: string): Promise<string[]> {
	const names = await fs.readdir(dir).catch(() => []);
	const blocks: string[] = [];
	for (const name of names) {
		if (!/\.(pem|crt|cer)$/i.test(name)) continue;
		const bytes = await fs.readFile(path.join(dir, name)).catch(() => undefined);
		if (!bytes) continue;
		const pem = pemBlocks(bytes.toString("latin1"));
		// A DER certificate is an ASN.1 SEQUENCE: it starts with 0x30.
		if (pem.length === 0 && bytes[0] === 0x30) pem.push(derToPem(bytes));
		blocks.push(...pem);
	}
	return blocks;
}

function pemBlocks(text: string): string[] {
	return (text.match(PEM_BLOCK) ?? []).map(block => block.replace(/\r\n/g, "\n").trim());
}

function derToPem(der: Buffer): string {
	const base64 = der.toString("base64").replace(/.{1,64}/g, "$&\n");
	return `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----`;
}

/** What the last export handed omp, for the output channel. */
export let lastSystemCa: { file: string; certificates: number } | undefined;

let exported: Promise<{ file: string; certificates: number } | undefined> | undefined;

/**
 * `NODE_EXTRA_CA_CERTS` for omp pointing at the OS store's certificates, or
 * nothing when the user already sets it (in `ompCustom.env` or VS Code's own
 * environment) or the store cannot be read. The store is exported once per
 * window; `options` replace the store and directory in tests.
 */
export async function systemCaEnv(
	userEnv: Readonly<Record<string, string>>,
	options: { certificates?: () => Promise<readonly string[]>; dir?: string } = {},
): Promise<Record<string, string>> {
	if (userEnv.NODE_EXTRA_CA_CERTS !== undefined || process.env.NODE_EXTRA_CA_CERTS !== undefined) return {};
	const task = options.certificates
		? exportStore(options.certificates, options.dir)
		: (exported ??= exportStore(osCertificates, options.dir));
	const result = await task;
	lastSystemCa = result;
	return result ? { NODE_EXTRA_CA_CERTS: result.file } : {};
}

async function exportStore(
	certificates: () => Promise<readonly string[]>,
	dir = os.tmpdir(),
): Promise<{ file: string; certificates: number } | undefined> {
	const blocks = await certificates();
	if (blocks.length === 0) return undefined;
	const file = path.join(dir, "omp-vscode-system-ca.pem");
	try {
		await fs.writeFile(file, `${blocks.map(block => block.trim()).join("\n")}\n`);
	} catch {
		return undefined;
	}
	return { file, certificates: blocks.length };
}
