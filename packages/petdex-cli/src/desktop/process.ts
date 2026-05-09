/**
 * `petdex desktop {start|stop|status}` — manages the petdex-desktop process.
 *
 * Stores the current PID at ~/.petdex/desktop.pid so subsequent runs can
 * detect a previous instance and avoid spawning duplicates.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import pc from "picocolors";

import { desktopBinPath } from "./install.js";

const PID_FILE = path.join(homedir(), ".petdex", "desktop.pid");
const LOG_FILE = path.join(homedir(), ".petdex", "desktop.log");

function readPidFile(): number | null {
	if (!existsSync(PID_FILE)) return null;
	try {
		const txt = readFileSync(PID_FILE, "utf8").trim();
		const pid = Number(txt);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isPidAlive(pid: number): boolean {
	try {
		// signal 0 = check existence without delivering anything
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function clearPidFile(): void {
	try {
		unlinkSync(PID_FILE);
	} catch {
		// not present, fine
	}
}

export type DesktopStatus =
	| { state: "running"; pid: number }
	| { state: "stopped" }
	| { state: "stale"; pid: number };

export function desktopStatus(): DesktopStatus {
	const pid = readPidFile();
	if (pid == null) return { state: "stopped" };
	if (isPidAlive(pid)) return { state: "running", pid };
	return { state: "stale", pid };
}

export type StartResult =
	| { ok: true; pid: number; alreadyRunning: boolean }
	| { ok: false; reason: string };

export async function startDesktop(): Promise<StartResult> {
	const status = desktopStatus();
	if (status.state === "running") {
		return { ok: true, pid: status.pid, alreadyRunning: true };
	}
	if (status.state === "stale") clearPidFile();

	const bin = desktopBinPath();
	if (!existsSync(bin)) {
		return {
			ok: false,
			reason: `petdex-desktop binary not found at ${bin}. Run \`petdex install desktop\` first.`,
		};
	}

	await mkdir(path.dirname(LOG_FILE), { recursive: true });

	const out = await import("node:fs").then((fs) =>
		fs.openSync(LOG_FILE, "a"),
	);
	const err = await import("node:fs").then((fs) =>
		fs.openSync(LOG_FILE, "a"),
	);

	const child = spawn(bin, [], {
		detached: true,
		stdio: ["ignore", out, err],
	});
	child.unref();

	if (!child.pid) {
		return { ok: false, reason: "Failed to spawn petdex-desktop" };
	}

	await writeFile(PID_FILE, String(child.pid));
	return { ok: true, pid: child.pid, alreadyRunning: false };
}

export type StopResult =
	| { ok: true; pid: number }
	| { ok: false; reason: string };

export function stopDesktop(): StopResult {
	const status = desktopStatus();
	if (status.state === "stopped") {
		return { ok: false, reason: "petdex-desktop is not running" };
	}
	const pid = status.pid;
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		clearPidFile();
		return {
			ok: false,
			reason: `Failed to signal pid ${pid}: ${(err as Error).message}`,
		};
	}
	clearPidFile();
	return { ok: true, pid };
}

export async function cmdDesktopStart(): Promise<void> {
	const result = await startDesktop();
	if (!result.ok) {
		console.error(`${pc.red("✗")} ${result.reason}`);
		process.exit(1);
	}
	if (result.alreadyRunning) {
		console.log(`${pc.dim("•")} petdex-desktop already running (pid ${result.pid})`);
	} else {
		console.log(`${pc.green("✓")} petdex-desktop started (pid ${result.pid})`);
		console.log(pc.dim(`  log: ${LOG_FILE}`));
	}
}

export function cmdDesktopStop(): void {
	const result = stopDesktop();
	if (!result.ok) {
		console.error(`${pc.dim("•")} ${result.reason}`);
		process.exit(result.reason.includes("not running") ? 0 : 1);
	}
	console.log(`${pc.green("✓")} stopped pid ${result.pid}`);
}

export function cmdDesktopStatus(): void {
	const status = desktopStatus();
	switch (status.state) {
		case "running":
			console.log(`${pc.green("●")} running (pid ${status.pid})`);
			break;
		case "stopped":
			console.log(`${pc.dim("○")} stopped`);
			break;
		case "stale":
			console.log(
				`${pc.yellow("?")} pid ${status.pid} written but not alive (run \`petdex desktop start\` to restart)`,
			);
			break;
	}
}
