/**
 * `petdex update` — checks GitHub Releases for a newer petdex-desktop binary,
 * downloads it if found, and restarts the running process so the user picks
 * up the new version without manual steps.
 *
 * Tracks the installed version at ~/.petdex/version. If the file is missing
 * (first time on this machine) it just downloads the latest, treating it
 * as a clean install.
 *
 * Compared against the GitHub Release tag (desktop-vX.Y.Z). If the latest
 * tag is the same as the local one, returns "already up to date" without
 * touching anything on disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import * as p from "@clack/prompts";
import pc from "picocolors";

import { desktopBinPath } from "./install.js";
import {
	desktopStatus,
	startDesktop,
	stopDesktop,
} from "./process.js";

const RELEASE_API =
	"https://api.github.com/repos/crafter-station/petdex/releases/latest";

const VERSION_FILE = path.join(homedir(), ".petdex", "version");

type ReleaseAsset = {
	name: string;
	browser_download_url: string;
	size: number;
};

type Release = {
	tag_name: string;
	assets: ReleaseAsset[];
};

function readInstalledVersion(): string | null {
	if (!existsSync(VERSION_FILE)) return null;
	try {
		return readFileSync(VERSION_FILE, "utf8").trim() || null;
	} catch {
		return null;
	}
}

function detectAssetSuffix(): string {
	const os = process.platform;
	const arch = process.arch;
	const osLabel =
		os === "darwin" ? "darwin" : os === "linux" ? "linux" : os === "win32" ? "win32" : os;
	const archLabel = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
	return `${osLabel}-${archLabel}`;
}

export async function runUpdate(args: string[] = []): Promise<void> {
	const force = args.includes("--force");
	p.intro(pc.bgMagenta(pc.white(" petdex update ")));

	const installed = readInstalledVersion();
	if (installed) {
		p.log.info(`Installed: ${pc.cyan(installed)}`);
	} else {
		p.log.info("No installed version recorded — treating as fresh install.");
	}

	const s = p.spinner();
	s.start("Checking GitHub for the latest release");

	let release: Release;
	try {
		const res = await fetch(RELEASE_API, {
			headers: { Accept: "application/vnd.github+json" },
		});
		if (!res.ok) {
			s.stop(pc.red("failed"));
			throw new Error(`GitHub API ${res.status}`);
		}
		release = (await res.json()) as Release;
	} catch (err) {
		s.stop(pc.red("failed"));
		throw new Error(
			`Could not reach GitHub. Check your connection.\n   ${(err as Error).message}`,
		);
	}

	s.stop(`${pc.green("✓")} Latest: ${pc.bold(release.tag_name)}`);

	if (!force && installed && installed === release.tag_name) {
		p.outro(`${pc.green("✓")} Already up to date.`);
		return;
	}

	const suffix = detectAssetSuffix();
	const wantedPrefix = `petdex-desktop-${suffix}`;
	const asset = release.assets.find((a) => a.name.startsWith(wantedPrefix));
	if (!asset) {
		const available = release.assets.map((a) => `      ${a.name}`).join("\n");
		throw new Error(
			`No binary for ${suffix} in ${release.tag_name}.\n   Available:\n${available}`,
		);
	}

	const wasRunning = desktopStatus().state === "running";
	if (wasRunning) {
		p.log.info(`${pc.dim("•")} Stopping running petdex-desktop`);
		stopDesktop();
	}

	const binPath = desktopBinPath();
	await mkdir(path.dirname(binPath), { recursive: true });

	const dl = p.spinner();
	dl.start(`Downloading ${asset.name}`);
	try {
		const res = await fetch(asset.browser_download_url);
		if (!res.ok) {
			dl.stop(pc.red("failed"));
			throw new Error(`Download ${asset.browser_download_url} → ${res.status}`);
		}
		const buffer = Buffer.from(await res.arrayBuffer());
		await writeFile(binPath, buffer);
		await chmod(binPath, 0o755);
		// Strip macOS quarantine so users don't see "cannot be opened" on first launch.
		if (process.platform === "darwin") {
			try {
				await import("node:child_process").then((cp) =>
					cp.spawnSync("xattr", ["-d", "com.apple.quarantine", binPath], {
						stdio: "ignore",
					}),
				);
			} catch {
				// quarantine attribute may not exist; that's fine
			}
		}
		dl.stop(`${pc.green("✓")} Installed ${pc.bold(release.tag_name)} (${formatBytes(asset.size)})`);
	} catch (err) {
		dl.stop(pc.red("failed"));
		throw err;
	}

	await writeFile(VERSION_FILE, release.tag_name + "\n");

	if (wasRunning) {
		p.log.info(`${pc.dim("•")} Restarting petdex-desktop`);
		const result = await startDesktop();
		if (result.ok) {
			p.log.info(`${pc.green("✓")} Restarted (pid ${result.pid})`);
		} else {
			p.log.warn(`${pc.yellow("!")} Could not restart: ${result.reason}`);
		}
	}

	const note = installed
		? `${installed}  →  ${release.tag_name}`
		: release.tag_name;
	p.outro(`${pc.green("✓")} ${note}`);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
