/**
 * Trust for omp's HTTPS requests behind a TLS-inspecting network.
 *
 * Company networks often re-sign HTTPS with their own root certificate, which
 * IT installs in the OS certificate store: browsers and VS Code trust it, but
 * omp (a Bun program) trusts only its built-in roots and fails with "self
 * signed certificate in certificate chain". The extension exports the OS
 * store's certificates (Node's `tls.getCACertificates("system")`: the Windows
 * certificate store, or the roots added to the macOS keychain) to a PEM file
 * and hands it to omp as `NODE_EXTRA_CA_CERTS`, which adds them to its roots.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

type SystemCertificates = () => readonly string[];

/** The OS store's certificates as PEM; empty where Node cannot read it. */
function osCertificates(): readonly string[] {
	const read = (tls as { getCACertificates?: (type: "system") => string[] }).getCACertificates;
	try {
		return read?.("system") ?? [];
	} catch {
		return [];
	}
}

let written: { file: string; content: string } | undefined;

/**
 * `NODE_EXTRA_CA_CERTS` for omp pointing at the OS store's certificates, or
 * nothing when the user already sets it (in `ompCustom.env` or VS Code's own
 * environment) or the store adds nothing. The file is rewritten only when
 * the store changes.
 */
export function systemCaEnv(
	userEnv: Readonly<Record<string, string>>,
	options: { certificates?: SystemCertificates; dir?: string } = {},
): Record<string, string> {
	if (userEnv.NODE_EXTRA_CA_CERTS !== undefined || process.env.NODE_EXTRA_CA_CERTS !== undefined) return {};
	const certificates = (options.certificates ?? osCertificates)();
	if (certificates.length === 0) return {};
	const file = path.join(options.dir ?? os.tmpdir(), "omp-vscode-system-ca.pem");
	const content = `${certificates.map(pem => pem.trim()).join("\n")}\n`;
	if (written?.file !== file || written.content !== content) {
		try {
			if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== content) fs.writeFileSync(file, content);
			written = { file, content };
		} catch {
			return {};
		}
	}
	return { NODE_EXTRA_CA_CERTS: file };
}
