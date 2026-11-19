import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path, { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { access, readdir } from "node:fs/promises";
// src/config.ts
const Config = Schema.object({
	exePath: Schema.string().default("").description("Path to lceda-pro.exe: WSL /mnt/d/Program Files/lceda-pro/lceda-pro.exe, or native Windows D:\\Program Files\\lceda-pro\\lceda-pro.exe. Empty: auto-detected on every mounted drive (WSL: /mnt/<letter>, Windows: existing C:..Z:)."),
	spawnCwd: Schema.string().default("").description("cwd for spawning the Windows exe. Empty: the drive root of exePath (a drive root avoids UNC cwd issues)."),
	projectPath: Schema.string().default("").description("Windows-side .eprj3 project path opened headless. Required: set per project."),
	pcbUuid: Schema.string().default("").description("PCB document uuid for openDocument prelude. Required: set per project."),
	schUuid: Schema.string().default("").description("Schematic page uuid for openDocument prelude. Required: set per project."),
	freeroutingJar: Schema.string().default("").description("Freerouting jar path. Required for lceda_route."),
	javaBin: Schema.string().default("java").description("Java binary for Freerouting (resolved from PATH by default)."),
	sesDirWin: Schema.string().default("").description("Windows-visible dir where the SES file is placed for importAutoRouteSesFile. Required for lceda_route."),
	workDir: Schema.string().default(".dsh-lceda").description("Local dir for DSN/SES/export artifacts (relative paths resolve against the session workspace)."),
	invokeTimeoutMs: Schema.number().default(12e4).description("Default invoke budget in ms."),
	routeTimeoutMs: Schema.number().default(9e5).description("Freerouting run budget in ms."),
	allowGuiConcurrent: Schema.boolean().default(false).description("Allow write operations while a user GUI session is open (dangerous: two-way .eprj3 sync can overwrite).")
});
// src/cli.ts
process.platform;
/** Relative install locations of the CLI inside a Windows drive root. */
const EXE_TAIL = [join("Program Files", "lceda-pro", "lceda-pro.exe"), join("Program Files (x86)", "lceda-pro", "lceda-pro.exe")];
/** Candidate exe paths under a list of drive roots (WSL `/mnt/d`, Windows `D:\`). */
function exeCandidates(roots) {
	return roots.flatMap((r) => EXE_TAIL.map((t) => join(r, t)));
}
/** First path that exists; `tried` keeps the full miss list for the error text. */
async function firstExisting(paths) {
	for (const p of paths) try {
		await access(p);
		return {
			found: p,
			tried: paths
		};
	} catch {}
	return { tried: paths };
}
/** Drives worth probing: mounted `/mnt/<letter>` on WSL, existing `X:\` roots on Windows. */
async function driveRoots(opts = {}) {
	const exists = opts.exists ?? (async (p) => (await firstExisting([p])).found !== void 0);
	if ((opts.platform ?? process.platform) === "win32") {
		const roots = [];
		for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
			const root = `${letter}:\\`;
			if (await exists(root)) roots.push(root);
		}
		return roots;
	}
	return (await readdir("/mnt").catch(() => [])).filter((d) => /^[a-z]$/i.test(d)).sort().map((d) => `/mnt/${d}`);
}
let autoExe;
async function detectExe() {
	if (autoExe && (await firstExisting([autoExe])).found) return {
		found: autoExe,
		tried: [autoExe]
	};
	const hit = await firstExisting(exeCandidates(await driveRoots()));
	if (hit.found) autoExe = hit.found;
	return hit;
}
/** exePath if it exists, else autodetect on any mounted Windows drive (D:, E:, …). */
async function resolveExe(cfg) {
	if (cfg.exePath) {
		if ((await firstExisting([cfg.exePath])).found) return cfg.exePath;
		const auto = await detectExe();
		throw new Error(`cannot find "${cfg.exePath}" (config exePath)` + (auto.found ? `; lceda-pro.exe was auto-detected at ${auto.found}` : `; not found in ${auto.tried.join(", ")}`) + " (see README.md#troubleshooting)");
	}
	const auto = await detectExe();
	if (!auto.found) throw new Error(`LCEDA Pro not found: install it, or set config exePath to lceda-pro.exe (WSL: /mnt/d/..., Windows: D:\\...) (looked in ${auto.tried.join(", ")}; see README.md#troubleshooting)`);
	return auto.found;
}
/** Drive root of a path to the Windows exe (`D:\\` or `/mnt/d`): a drive root is a valid cwd for it. */
function driveRoot(p) {
	const win = /^([A-Za-z]):[\\/]/.exec(p);
	if (win) return `${win[1].toUpperCase()}:\\`;
	const wsl = /^\/mnt\/([a-z])\//i.exec(p);
	return wsl ? `/mnt/${wsl[1].toLowerCase()}` : parse(p).root || "/";
}
/** Spawn the Windows CLI and parse its single JSON envelope from stdout. */
async function runCli(cfg, args, stdin, timeoutMs = 12e4) {
	const exe = await resolveExe(cfg);
	return new Promise((resolve, reject) => {
		const child = spawn(exe, args, { cwd: cfg.spawnCwd || driveRoot(exe) });
		let out = "";
		let err = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(/* @__PURE__ */ new Error(`lceda CLI timeout after ${timeoutMs}ms: ${args.join(" ")}`));
		}, timeoutMs);
		child.stdout.on("data", (d) => {
			out += d.toString();
		});
		child.stderr.on("data", (d) => {
			err += d.toString();
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(/* @__PURE__ */ new Error(`cannot start "${exe}" (${e.message}): check permissions on the install dir, or set config exePath (see README.md#troubleshooting)`));
		});
		child.on("close", () => {
			clearTimeout(timer);
			const text = out.trim();
			try {
				const o = JSON.parse(text);
				resolve({
					ok: !!o.ok,
					value: o.value,
					error: o.error,
					raw: text
				});
			} catch {
				resolve({
					ok: false,
					error: { message: `non-JSON CLI output: ${text.slice(0, 400)} ${err.slice(0, 200)}` },
					raw: text
				});
			}
		});
		if (stdin !== void 0) child.stdin.write(stdin);
		child.stdin.end();
	});
}
async function listSessions(cfg) {
	const v = (await runCli(cfg, ["session", "list"], void 0, 3e4)).value;
	if (Array.isArray(v)) return v;
	if (v && Array.isArray(v.sessions)) return v.sessions;
	return [];
}
async function openHeadless(cfg, path) {
	const p = path ?? cfg.projectPath;
	if (!p) throw new Error("no project path: pass a .eprj3 path or set config projectPath (see README.md#configuration)");
	const env = await runCli(cfg, [
		"open",
		"--headless",
		"true",
		"--path",
		p
	], void 0, 9e4);
	if (!env.ok) throw new Error(`open failed: ${env.error?.message ?? env.raw.slice(0, 300)}`);
	const v = env.value;
	if (!v?.sessionId) throw new Error(`open returned no sessionId: ${env.raw.slice(0, 300)}`);
	return v.sessionId;
}
async function closeSession(cfg, sessionId, destroy = true) {
	const args = [
		"session",
		"close",
		"--session",
		sessionId
	];
	if (destroy) args.push("--destroy");
	return (await runCli(cfg, args, void 0, 3e4)).ok;
}
/** Invoke editor JS through stdin (--code-file -): no UNC paths, no temp files. */
async function invoke(cfg, sessionId, code, args, timeoutMs) {
	const argv = [
		"invoke",
		"--session",
		sessionId,
		"--ext-uuid",
		"eda",
		"--code-file",
		"-",
		"--timeout",
		String(timeoutMs ?? cfg.invokeTimeoutMs)
	];
	if (args !== void 0) argv.push("--args", JSON.stringify(args));
	const env = await runCli(cfg, argv, code, (timeoutMs ?? cfg.invokeTimeoutMs) + 3e4);
	if (!env.ok) throw new Error(`invoke failed: ${env.error?.message ?? env.raw.slice(0, 400)}`);
	return env.value;
}
/** Refuse writes while the user's GUI holds the project (.eprj3 two-way sync). */
async function guardGui(cfg) {
	if (cfg.allowGuiConcurrent) return;
	const gui = (await listSessions(cfg)).filter((s) => s.origin === "user");
	if (gui.length) throw new Error(`user GUI session open (${gui.map((s) => s.sessionId).join(", ")}); close it first or set allowGuiConcurrent. Two-way .eprj3 sync would race headless writes.`);
}
function readyPrelude(uuid) {
	return `await eda.dmt_EditorControl.openDocument(${JSON.stringify(uuid)});\nawait eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(uuid)}, 30000);\n`;
}
/** getAll can return null right after open; retry with settle. */
const RETRY_GETALL = `async function getAllRetry(fn, n = 6) { for (let i = 0; i < n; i++) { const r = await fn(); if (r) return r; await new Promise((r2) => setTimeout(r2, 1500)); } throw new Error('getAll stayed null'); }\n`;
// src/decode.ts
/** Pure helpers: base64/UTF-16 decoding, Protel2 netlist parsing, connectivity union-find. */
function b64ToBuffer(b64) {
	return Buffer.from(b64, "base64");
}
/** LCEDA BOM/PNP CSVs are UTF-16LE; normalize to UTF-8 for downstream tools. */
function normalizeCsv(buf) {
	if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) return Buffer.from(buf.toString("utf16le").replace(/^\ufeff/, ""), "utf8");
	const sample = buf.subarray(0, Math.min(buf.length, 200));
	let zeros = 0;
	for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros++;
	if (zeros > sample.length / 4) return Buffer.from(buf.toString("utf16le").replace(/^\ufeff/, ""), "utf8");
	return buf;
}
/** Parse a Protel2 netlist: [ component blocks ] then ( netname nodes... ) blocks. */
function parseProtel2(text) {
	const comps = {};
	const nets = {};
	const lines = text.split(/\r?\n/);
	let i = 0;
	let curRef = null;
	let inComp = false;
	let curNet = null;
	for (; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "[") {
			inComp = true;
			curRef = null;
			continue;
		}
		if (line === "]") {
			inComp = false;
			continue;
		}
		if (inComp) {
			if (curRef === null && line && !line.startsWith("*")) curRef = line;
			continue;
		}
		if (line === "(") {
			curNet = null;
			continue;
		}
		if (line === ")") {
			curNet = null;
			continue;
		}
		if (curNet === null && line && !line.startsWith("*")) {
			curNet = line;
			nets[curNet] = [];
			continue;
		}
		if (curNet !== null && line) {
			const node = line.split(/\s+/)[0];
			nets[curNet].push(node);
			const dash = node.lastIndexOf("-");
			if (dash > 0) {
				const ref = node.slice(0, dash);
				const pin = node.slice(dash + 1);
				comps[ref] = comps[ref] ?? {};
				comps[ref][pin] = curNet;
			}
		}
	}
	return {
		comps,
		nets
	};
}
/** Union-find connectivity over pads/track endpoints/vias (pour copper NOT counted). */
function connectivity(pads, segs, vias, tol = .6) {
	const parent = /* @__PURE__ */ new Map();
	const find = (a) => {
		let r = a;
		while (parent.get(r) !== r) r = parent.get(r);
		let c = a;
		while (parent.get(c) !== c) {
			const n = parent.get(c);
			parent.set(c, r);
			c = n;
		}
		return r;
	};
	const union = (a, b) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};
	const add = (id) => {
		if (!parent.has(id)) parent.set(id, id);
	};
	const pts = [...pads.map((p) => ({
		id: p.id,
		net: p.net,
		x: p.x,
		y: p.y,
		layer: p.layer,
		through: p.through
	})), ...vias.map((v) => ({
		id: v.id,
		net: v.net,
		x: v.x,
		y: v.y,
		layer: 0,
		through: true
	}))];
	for (const p of pts) add(p.id);
	const segPts = segs.map((s, i) => {
		const a = {
			id: `seg${i}a`,
			net: s.net,
			x: s.ax,
			y: s.ay,
			layer: s.layer
		};
		const b = {
			id: `seg${i}b`,
			net: s.net,
			x: s.bx,
			y: s.by,
			layer: s.layer
		};
		add(a.id);
		add(b.id);
		union(a.id, b.id);
		return [a, b];
	});
	const all = [...pts, ...segPts.flat()];
	const near = (p, q) => Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol;
	const layerOk = (p, q) => p.through || q.through || p.layer === q.layer || p.layer === 0 || q.layer === 0;
	for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
		const p = all[i];
		const q = all[j];
		if (p.net !== q.net || !p.net) continue;
		if (near(p, q) && layerOk(p, q)) union(p.id, q.id);
	}
	const groups = /* @__PURE__ */ new Map();
	for (const p of pts) {
		if (!p.net) continue;
		const r = find(p.id);
		if (!groups.has(p.net)) groups.set(p.net, /* @__PURE__ */ new Set());
		groups.get(p.net).add(r);
	}
	const isolated = {};
	for (const [net, roots] of groups) if (roots.size > 1) isolated[net] = pts.filter((p) => p.net === net).map((p) => p.id);
	return isolated;
}
/** Diff actual ref|pin->net against expected; empty-string nets mean intentional NC. */
function diffNets(actual, expected) {
	const mismatches = [];
	let checked = 0;
	for (const [key, want] of Object.entries(expected)) {
		checked++;
		const got = actual[key] ?? "";
		if (got !== want) mismatches.push({
			key,
			actual: got,
			expected: want
		});
	}
	return {
		checked,
		mismatches
	};
}
// src/index.ts
const name = "dsh-lceda";
const inject = ["tools"];
const B64 = `function toB64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }\n`;
async function resolveSession(cfg, owned, given) {
	if (given) return given;
	const alive = await listSessions(cfg);
	const ids = new Set(alive.map((s) => s.sessionId));
	while (owned.length && !ids.has(owned[owned.length - 1])) owned.pop();
	if (owned.length) return owned[owned.length - 1];
	const id = await openHeadless(cfg);
	owned.push(id);
	return id;
}
async function call(cfg, owned, session, code, args, timeoutMs) {
	let sid = await resolveSession(cfg, owned, session);
	try {
		return await invoke(cfg, sid, code, args, timeoutMs);
	} catch (e) {
		const msg = String(e.message);
		if (/SESSION_NOT_FOUND|订阅|canvas/i.test(msg) && !session) {
			await closeSession(cfg, sid).catch(() => false);
			const i = owned.indexOf(sid);
			if (i >= 0) owned.splice(i, 1);
			sid = await openHeadless(cfg);
			owned.push(sid);
			return await invoke(cfg, sid, code, args, timeoutMs);
		}
		throw e;
	}
}
const IS_WIN = process.platform === "win32";
function winToWsl(p) {
	const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
	return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
}
/** Editor-side Windows path -> a path this process can touch (identity unless WSL). */
function toLocal(p) {
	return IS_WIN ? p : winToWsl(p);
}
/** Document ids derived from a `.eprj3` (plain JSON: profile.pcbs / profile.sheets keys). */
const idCache = /* @__PURE__ */ new Map();
function projectIds(projectPath) {
	if (!projectPath) return {};
	const local = toLocal(projectPath);
	try {
		const { mtimeMs, size } = fs.statSync(local);
		const hit = idCache.get(local);
		if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.ids;
		const doc = JSON.parse(fs.readFileSync(local, "utf8"));
		const ids = {
			pcb: Object.keys(doc.profile?.pcbs ?? {})[0],
			sch: Object.keys(doc.profile?.sheets ?? {})[0]
		};
		idCache.set(local, {
			mtimeMs,
			size,
			ids
		});
		return ids;
	} catch {
		return {};
	}
}
/** Configured id, else the first one of that kind inside the configured project. */
function needUuid(cfg, kind) {
	const what = kind === "pcb" ? "board" : "schematic page";
	const u = (kind === "pcb" ? cfg.pcbUuid : cfg.schUuid) || projectIds(cfg.projectPath)[kind];
	if (!u) throw new Error(`config ${kind}Uuid is not set, and config projectPath ` + (cfg.projectPath ? `("${cfg.projectPath}") contains no ${what}` : "is empty") + `: set projectPath to a project that has one, or set ${kind}Uuid directly (see README.md#configuration)`);
	return u;
}
function jsonRender(_args, value) {
	const text = JSON.stringify(value, null, 1);
	return [{
		type: "text",
		text: text.length > 6e3 ? text.slice(0, 6e3) + "\n…(truncated)" : text
	}];
}
function apply(ctx, config) {
	const cfg = config;
	/** Sessions this plugin instance opened; closed on dispose so a reload leaves no headless CLI behind. */
	const owned = [];
	ctx.effect(() => async () => {
		await Promise.all(owned.splice(0).map((id) => closeSession(cfg, id).catch(() => false)));
	}, "dsh-lceda owned sessions");
	ctx.inject(["skills"], (sctx) => {
		try {
			const dir = fileURLToPath(new URL("../skills/lceda-dev/", import.meta.url));
			const text = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
			const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
			const description = fm ? /^description:[ \t]*(.+?)[ \t]*$/m.exec(fm[1])?.[1]?.trim() : void 0;
			const content = (fm ? text.slice(fm[0].length) : text).replace(/^(?:[ \t]*\r?\n)+/, "");
			const skills = sctx.skills;
			sctx.effect(() => skills.register({
				name: "lceda-dev",
				source: "bundled",
				description,
				content,
				resourceBase: {
					kind: "directory",
					path: dir
				}
			}), "dsh-lceda skill lceda-dev");
		} catch (e) {
			console.warn(`dsh-lceda: skill lceda-dev not registered: ${String(e.message)}`);
		}
	});
	ctx.tools.register(defineTool({
		name: "lceda_session",
		description: "Manage LCEDA Pro headless sessions: open (headless, returns sessionId), list, close (destroy), clean (close stale CLI-origin sessions not owned by this plugin). User GUI sessions are never closed.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "open | list | close | clean"
			},
			path: {
				type: "string",
				description: "Windows .eprj3 path for open (default config projectPath)."
			},
			session: {
				type: "string",
				description: "Session id for close."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			if (args.action === "list") return { sessions: await listSessions(cfg) };
			if (args.action === "open") {
				const id = await openHeadless(cfg, args.path);
				owned.push(id);
				return { sessionId: id };
			}
			if (args.action === "close") {
				const id = args.session ?? owned.pop();
				if (!id) throw new Error("no session to close");
				return {
					closed: id,
					ok: await closeSession(cfg, id)
				};
			}
			if (args.action === "clean") {
				const sessions = await listSessions(cfg);
				const closed = [];
				for (const s of sessions) if (s.origin === "cli" && !owned.includes(s.sessionId)) {
					if (await closeSession(cfg, s.sessionId)) closed.push(s.sessionId);
				}
				return { closed };
			}
			throw new Error(`unknown action ${args.action}`);
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_run",
		description: "Run editor JavaScript in a headless LCEDA session (eda namespace, async body, return value reported). doc=pcb|sch opens+waits for that document first. ok:true only means the code ran: validate business results inside the code and throw on failure. Write ops refuse while a user GUI session is open.",
		parameters: {
			code: {
				type: "string",
				required: true,
				description: "Async function body using eda.*; return a JSON-serializable result."
			},
			args: {
				type: "object",
				additionalProperties: true,
				description: "Passed to the code as __CLI__.args."
			},
			session: {
				type: "string",
				description: "Session id (default: plugin-owned headless session, opened on demand)."
			},
			doc: {
				type: "string",
				description: "pcb | sch | <uuid>: openDocument + waitForDocumentReady prelude."
			},
			timeoutMs: {
				type: "number",
				description: "Invoke budget ms (default config invokeTimeoutMs)."
			},
			write: {
				type: "boolean",
				description: "Set true for mutating code to enable the GUI-concurrency guard (default true)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			if (args.write !== false) await guardGui(cfg);
			const uuid = args.doc === "pcb" ? needUuid(cfg, "pcb") : args.doc === "sch" ? needUuid(cfg, "sch") : args.doc;
			const code = (uuid ? readyPrelude(uuid) : "") + RETRY_GETALL + args.code;
			return { value: await call(cfg, owned, args.session, code, args.args, args.timeoutMs) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_export",
		description: "Export manufacturing/design artifacts and decode them to a local directory: gerber (zip), bom (csv), pnp (csv), pdf (assembly), netlist (Protel2), svg/png (schematic). CSV UTF-16LE is normalized to UTF-8.",
		parameters: {
			kinds: {
				type: "array",
				items: { type: "string" },
				description: "Subset of gerber,bom,pnp,pdf,netlist,svg,png (default all)."
			},
			outDir: {
				type: "string",
				description: "Output dir (default config workDir/exports); WSL: /mnt/..., Windows: D:\\..."
			},
			name: {
				type: "string",
				description: "Base file name (default board)."
			},
			session: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			await guardGui(cfg);
			const kinds = args.kinds?.length ? args.kinds : [
				"gerber",
				"bom",
				"pnp",
				"pdf",
				"netlist",
				"svg",
				"png"
			];
			const base = args.name ?? "board";
			const code = `${B64}${RETRY_GETALL}
const out = {};
const want = ${JSON.stringify(kinds)};
const base = ${JSON.stringify(base)};
if (want.some((k) => ['gerber','pnp','pdf'].includes(k))) {
  await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
  await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
  const M = eda.pcb_ManufactureData;
  if (want.includes('gerber')) { const f = await M.getGerberFile(base + '-gerber', false, 'mm'); out.gerber = toB64(await f.arrayBuffer()); }
  if (want.includes('pnp')) { const f = await M.getPickAndPlaceFile(base + '-pnp', 'csv', 'mm'); out.pnp = toB64(await f.arrayBuffer()); }
  if (want.includes('pdf')) { const f = await M.getPdfFile(base + '-assembly', {}); out.pdf = toB64(await f.arrayBuffer()); }
}
if (want.some((k) => ['bom','netlist','svg','png'].includes(k))) {
  await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "sch"))});
  await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "sch"))}, 30000);
  const S = eda.sch_ManufactureData;
  if (want.includes('bom')) { const f = await S.getBomFile(base + '-bom', 'csv'); out.bom = toB64(await f.arrayBuffer()); }
  if (want.includes('netlist')) { const f = await S.getNetlistFile(base + '-net', 'Protel2'); out.netlist = toB64(await f.arrayBuffer()); }
  if (want.includes('svg')) { const f = await S.getSvgFile(base + '-sch'); out.svg = toB64(await f.arrayBuffer()); }
  if (want.includes('png')) { const f = await S.getPngFile(base + '-sch', { width: 2400, height: 1700 }); out.png = toB64(await f.arrayBuffer()); }
}
return out;`;
			const map = await call(cfg, owned, args.session, code, void 0, 24e4);
			const dir = args.outDir ?? path.join(cfg.workDir, "exports");
			fs.mkdirSync(dir, { recursive: true });
			const files = [];
			const ext = {
				gerber: "zip",
				bom: "csv",
				pnp: "csv",
				pdf: "pdf",
				netlist: "net",
				svg: "svg",
				png: "png"
			};
			for (const [kind, b64] of Object.entries(map)) {
				let buf = b64ToBuffer(b64);
				if (kind === "bom" || kind === "pnp") buf = normalizeCsv(buf);
				const file = path.join(dir, `${base}-${kind === "gerber" ? "gerber" : kind}.${ext[kind]}`);
				fs.writeFileSync(file, buf);
				files.push({
					kind,
					file,
					bytes: buf.length
				});
			}
			return { files };
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_route",
		description: "Full autoroute cycle: clearRouting -> export Specctra DSN -> run Freerouting headless -> import SES back. Returns unrouted/violation counts from the Freerouting log and imported track count. Pre-drawn buses are NOT preserved by Freerouting; draw them after import.",
		parameters: {
			passes: {
				type: "number",
				description: "Freerouting -mp passes (default 100)."
			},
			session: { type: "string" },
			workDir: {
				type: "string",
				description: "Dir for dsn/ses/log (default config workDir); WSL: /mnt/..., Windows: D:\\..."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			if (!cfg.freeroutingJar || !cfg.sesDirWin) throw new Error("lceda_route requires config freeroutingJar and sesDirWin (see README.md#configuration)");
			await guardGui(cfg);
			const dir = args.workDir ?? cfg.workDir;
			fs.mkdirSync(dir, { recursive: true });
			const dsnPath = path.join(dir, "board.dsn");
			const sesPath = path.join(dir, "board.ses");
			const logPath = path.join(dir, "freerouting.log");
			const code1 = `${B64}${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
await eda.pcb_Document.clearRouting();
const f = await eda.pcb_ManufactureData.getDsnFile('board');
return toB64(await f.arrayBuffer());`;
			const b64 = await call(cfg, owned, args.session, code1, void 0, 18e4);
			fs.writeFileSync(dsnPath, b64ToBuffer(b64));
			const log = fs.openSync(logPath, "w");
			await new Promise((resolve, reject) => {
				const child = spawn(cfg.javaBin, [
					"-jar",
					cfg.freeroutingJar,
					"-de",
					dsnPath,
					"-do",
					sesPath,
					"-mp",
					String(args.passes ?? 100),
					"--gui.enabled=false"
				], {
					cwd: dir,
					stdio: [
						"ignore",
						log,
						log
					]
				});
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(/* @__PURE__ */ new Error("Freerouting timeout"));
				}, cfg.routeTimeoutMs);
				child.on("error", (e) => {
					clearTimeout(timer);
					reject(/* @__PURE__ */ new Error(`cannot start "${cfg.javaBin}" (${e.message}): set config javaBin to a working Java runtime (see README.md#troubleshooting)`));
				});
				child.on("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			fs.closeSync(log);
			const logText = fs.readFileSync(logPath, "utf8");
			const unrouted = /(\d+)\s+unrouted/i.exec(logText)?.[1] ?? null;
			const violations = /(\d+)\s+clearance violation/i.exec(logText)?.[1] ?? null;
			const sesDir = cfg.sesDirWin.replace(/[\\/]+$/, "");
			const sesWin = `${sesDir}${sesDir.includes("\\") ? "\\" : "/"}board.ses`;
			fs.mkdirSync(toLocal(cfg.sesDirWin), { recursive: true });
			fs.copyFileSync(sesPath, path.join(toLocal(cfg.sesDirWin), "board.ses"));
			const code2 = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
const f = await eda.sys_FileSystem.readFileFromFileSystem(${JSON.stringify(sesWin)});
const imported = await eda.pcb_Document.importAutoRouteSesFile(f);
await eda.pcb_Document.save();
const lines = await getAllRetry(() => eda.pcb_PrimitiveLine.getAll());
return { imported, tracks: lines.length };`;
			return {
				...await call(cfg, owned, args.session, code2, void 0, 18e4),
				unrouted,
				violations,
				dsn: dsnPath,
				ses: sesPath,
				log: logPath
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_check",
		description: "Verify the board: drc (pcb_Drc.check with getDrcResult fallback; headless check can crash the session), nets (pad nets vs an expected ref|pin->net JSON file), conn (union-find over pads/tracks/vias; pour copper is NOT counted, GND-only-by-pour reads as isolated), all.",
		parameters: {
			mode: {
				type: "string",
				description: "drc | nets | conn | all (default all)."
			},
			expectedFile: {
				type: "string",
				description: "Path of expected ref|pin->net JSON for nets mode."
			},
			session: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			const mode = args.mode ?? "all";
			const out = {};
			if (mode === "nets" || mode === "all") {
				const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
const comps = await getAllRetry(() => eda.pcb_PrimitiveComponent.getAll());
const actual = {};
for (const c of comps) {
  const ref = await c.getState_Designator();
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
  for (const p of pins || []) actual[ref + '|' + p.padNumber] = p.net || '';
}
return actual;`;
				const actual = await call(cfg, owned, args.session, code, void 0, 18e4);
				if (args.expectedFile) out.nets = diffNets(actual, JSON.parse(fs.readFileSync(args.expectedFile, "utf8")));
				else out.nets = { actual };
			}
			if (mode === "conn" || mode === "all") {
				const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
const comps = await getAllRetry(() => eda.pcb_PrimitiveComponent.getAll());
const pads = [];
for (const c of comps) {
  const ref = await c.getState_Designator();
  const pins = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId);
  for (const p of pins || []) pads.push({ id: ref + '.' + p.padNumber, net: p.net || '', x: p.x, y: p.y, layer: p.layer ?? 1, through: (Array.isArray(p.hole) ? (p.hole[1] ?? 0) > 0 : (p.hole ?? 0) > 0) || p.layer === 12 });
}
const lines = await getAllRetry(() => eda.pcb_PrimitiveLine.getAll());
const segs = lines.map((l) => ({ net: l.net || '', ax: l.startX, ay: l.startY, bx: l.endX, by: l.endY, layer: l.layer }));
const vias = await getAllRetry(() => eda.pcb_PrimitiveVia.getAll());
const vs = vias.map((v) => ({ id: v.primitiveId, net: v.net || '', x: v.x, y: v.y }));
return { pads, segs, vias: vs };`;
				const g = await call(cfg, owned, args.session, code, void 0, 18e4);
				out.conn = {
					isolated: connectivity(g.pads, g.segs, g.vias),
					pads: g.pads.length,
					segs: g.segs.length,
					vias: g.vias.length
				};
			}
			if (mode === "drc" || mode === "all") {
				const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
let ran = false; let result = null; let note = '';
try { result = await eda.pcb_Drc.getDrcResult(); } catch (e) { result = null; }
if (!result) {
  try { await Promise.race([eda.pcb_Drc.check(true, false, false), new Promise((_, rej) => setTimeout(() => rej(new Error('drc-check-timeout')), 20000))]); ran = true; } catch (e) { ran = false; }
  try { result = await eda.pcb_Drc.getDrcResult(); } catch (e) { note = 'headless DRC unavailable (canvas subscription): ' + String(e && e.message || e); }
}
return { ran, result, note };`;
				out.drc = await call(cfg, owned, args.session, code, void 0, 18e4);
			}
			return out;
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_pour",
		description: "Copper pour maintenance: rebuild (rebuildCopperRegion on every pour + save; create does NOT fill), connectMode (set pad/track connect mode 0=none 1=thermal 2=solid in the DRC rule config via single-arg overwriteCurrentRuleConfiguration, then rebuild). Inner layers must not carry solid pour when inner signal tracks exist.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "rebuild | connectMode"
			},
			mode: {
				type: "number",
				description: "connectMode value 0|1|2 for connectMode action (default 2)."
			},
			session: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			await guardGui(cfg);
			const code = args.action === "connectMode" ? `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
const r = await eda.pcb_Drc.getCurrentRuleConfiguration();
const c = r.config; const mode = ${args.mode ?? 2};
const cz = c.Plane['Copper Zone'].copperRegion.form;
for (const key of ['singleLayerPadModel','multiLayerPadModel']) for (const k of Object.keys(cz[key].data)) cz[key].data[k].connectMode = mode;
for (const k of Object.keys(cz.trackConnectModel.data)) cz.trackConnectModel.data[k].trackConnectMode = mode;
const pz = c.Plane['Plane Zone']; if (pz && pz.innerPlane) for (const k of Object.keys(pz.innerPlane.data)) pz.innerPlane.data[k].connectMode = mode;
await eda.pcb_Drc.overwriteCurrentRuleConfiguration(c);
const pours = await getAllRetry(() => eda.pcb_PrimitivePour.getAll());
for (const p of pours) await p.rebuildCopperRegion();
await eda.pcb_Document.save();
const after = await eda.pcb_Drc.getCurrentRuleConfiguration();
return { rule: after.name, pours: pours.length };` : `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "pcb"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "pcb"))}, 30000);
const pours = await getAllRetry(() => eda.pcb_PrimitivePour.getAll());
for (const p of pours) await p.rebuildCopperRegion();
await eda.pcb_Document.save();
return { pours: pours.length };`;
			return { value: await call(cfg, owned, args.session, code, void 0, 18e4) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_sch_wire",
		description: "Connect schematic pins with wires (the engineering-conventional method): each wire is a net name plus a polyline through pin hotspots (getAllPinsByPrimitiveId x,y). Wire endpoints must land exactly on pin coordinates. Net labels are decorative; connectivity comes from wire nets.",
		parameters: {
			wires: {
				type: "array",
				required: true,
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						net: {
							type: "string",
							required: true
						},
						points: {
							type: "array",
							required: true,
							items: {
								type: "array",
								items: { type: "number" }
							},
							description: "[[x,y],[x,y],...] polyline; consecutive points form segments."
						}
					}
				},
				description: "Wires to create."
			},
			session: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			await guardGui(cfg);
			const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "sch"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "sch"))}, 30000);
const wires = __CLI__.args.wires;
const ids = [];
for (const w of wires) {
  const line = [];
  for (let i = 0; i + 1 < w.points.length; i++) line.push(w.points[i][0], w.points[i][1], w.points[i + 1][0], w.points[i + 1][1]);
  const prim = await eda.sch_PrimitiveWire.create(line, w.net);
  if (!prim) throw new Error('wire create returned null for net ' + w.net);
  ids.push(prim.primitiveId);
}
await eda.sch_Document.save();
return { created: ids.length, ids };`;
			return { value: await call(cfg, owned, args.session, code, { wires: args.wires }, 18e4) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "lceda_sch_netlist",
		description: "Compile the schematic netlist (Protel2) and optionally diff every ref|pin->net against an expected JSON file. pin.net fields only reflect net labels; this compiled netlist is the source of truth for connectivity.",
		parameters: {
			compareFile: {
				type: "string",
				description: "Path of expected ref|pin->net JSON."
			},
			session: { type: "string" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: jsonRender
		},
		async execute(args) {
			const code = `${RETRY_GETALL}
await eda.dmt_EditorControl.openDocument(${JSON.stringify(needUuid(cfg, "sch"))});
await eda.dmt_EditorControl.waitForDocumentReady(${JSON.stringify(needUuid(cfg, "sch"))}, 30000);
return await eda.sch_Netlist.getNetlist('Protel2');`;
			const nl = parseProtel2(await call(cfg, owned, args.session, code, void 0, 12e4));
			const actual = {};
			for (const [ref, pins] of Object.entries(nl.comps)) for (const [pin, net] of Object.entries(pins)) actual[`${ref}|${pin}`] = net;
			if (args.compareFile) {
				const expected = JSON.parse(fs.readFileSync(args.compareFile, "utf8"));
				return {
					nets: Object.keys(nl.nets).length,
					...diffNets(actual, expected)
				};
			}
			return {
				nets: Object.keys(nl.nets).length,
				comps: Object.keys(nl.comps).length,
				netlist: nl.nets
			};
		}
	}));
}
export { Config, apply, inject, name, needUuid, projectIds };
