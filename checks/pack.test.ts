import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// The repo runs every package from source, so a leftover relative import or a missing build
// would only show up for someone installing from npm. These checks pack each package, install
// the tarballs into an empty project outside the repo, and run plain JavaScript against them.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (command: string, args: string[], cwd: string) =>
    execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let app = "", tarballs: string[] = [];
const work = await mkdtemp(join(tmpdir(), "aum-pack-"));
after(() => rm(work, { recursive: true, force: true, maxRetries: 3 }));

before(async () => {
    const packed = join(work, "tarballs");
    app = join(work, "app");
    await mkdir(packed); await mkdir(app);
    run("npm", ["run", "build"], ROOT);
    for (const folder of [ROOT, join(ROOT, "packages", "harness")]) run("npm", ["pack", "--pack-destination", packed], folder);
    tarballs = (await readdir(packed)).map(name => join(packed, name));
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
    run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", ...tarballs], app);
});

test("each package ships only built files, and none reaches the core by path", async () => {
    for (const tarball of tarballs) {
        const files = run("tar", ["-tzf", tarball], ROOT).split("\n").filter(Boolean);
        const source = files.filter(file => file.endsWith(".ts") && !file.endsWith(".d.ts"));
        assert.deepEqual(source, [], `${tarball} ships source`);
    }
    const built = await readFile(join(app, "node_modules/@aum/harness/dist/providers/pi/model.js"), "utf8");
    assert.doesNotMatch(built, /\.\.\/src|\.ts"/);
});

// Pi's faux provider answers through Pi's real request path, so this runs the installed core,
// Pi provider, coding tools and saved session together with no network and no key.
test("an installed project runs an agent by package name, with no TypeScript", async () => {
    await writeFile(join(app, "run.js"), `
        import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
        import { Agent, bind, lineageContext, rules } from "@aum/core";
        import { PiCatalog, createPiModel } from "@aum/harness/providers/pi";
        import { createCodingTools } from "@aum/harness/tools/coding";
        import { openSession } from "@aum/harness/sessions/jsonl";
        const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] }), models = createModels();
        models.setProvider(faux.provider);
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall("read", { path: "package.json" })], { stopReason: "toolUse" }),
            fauxAssistantMessage([fauxText("read it")]),
        ]);
        const model = createPiModel({ models, model: faux.getModel() });
        const tools = createCodingTools(".").map(bind);
        const agent = new Agent({ session: await openSession("sessions", "one"),
            getBindings: () => ({ model, tools, context: lineageContext(""), authorize: rules({ read: "allow" }) }) });
        const result = await agent.run("Read package.json").result;
        const catalog = new PiCatalog();
        console.log(result.status, result.cycles, catalog.families().length >= 40, catalog.load("openai/gpt-5-mini").reasoning);`);
    assert.equal(run("node", ["run.js"], app).trim(), "completed 2 true medium");
    const saved = (await readFile(join(app, "sessions", "one.jsonl"), "utf8")).trim().split("\n");
    assert.equal(saved.length, 4);
});
