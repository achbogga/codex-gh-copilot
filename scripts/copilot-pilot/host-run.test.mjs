import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runHost } from "./host-run.mjs";

const model = {
  id: "test-model",
  policy: { state: "enabled" },
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
  capabilities: {
    supports: { tool_calls: true, streaming: true, reasoning_effort: ["max"] },
    limits: { max_context_window_tokens: 1050000, max_prompt_tokens: 922000 },
  },
};

test(
  "host launcher preserves exported credentials, PATH, home access and child exit status",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "copilot-host-test-")),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "project"),
      bin = join(root, "bin"),
      stateDir = join(root, "state");
    await mkdir(directory);
    await mkdir(bin);
    await writeFile(join(root, "outside-project.txt"), "host file");
    const tool = join(bin, "host-test-tool"),
      codexBin = join(bin, "fake-codex");
    await writeFile(tool, "#!/bin/sh\nprintf host-tool-ok\n");
    await chmod(tool, 0o700);
    await writeFile(
      codexBin,
      `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const args = process.argv.slice(2);
const settings = args.filter((_, i) => args[i - 1] === '-c');
fs.writeFileSync(path.join(process.env.HOME, 'result.json'), JSON.stringify({
  cwd: process.cwd(), home: process.env.HOME,
  tool: cp.execFileSync('host-test-tool', {encoding:'utf8'}),
  outside: fs.readFileSync(path.join(process.env.HOME, 'outside-project.txt'), 'utf8'),
  credentials: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.OPENAI_API_KEY, process.env.COPILOT_GITHUB_TOKEN, process.env.COPILOT_PILOT_TOKEN],
  state: process.env.CODEX_HOME,
  yolo: args.filter(arg => arg === '--yolo').length,
  sandbox: args[args.indexOf('--sandbox') + 1],
  approvals: args.includes('--ask-for-approval'),
  environmentPolicy: settings.find(value => value.startsWith('shell_environment_policy=')),
}));
process.exit(7);
`,
    );
    await chmod(codexBin, 0o700);
    const environment = {
      HOME: root,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GH_TOKEN: "fake-gh",
      GITHUB_TOKEN: "fake-github",
      OPENAI_API_KEY: "fake-openai",
      COPILOT_GITHUB_TOKEN: "fake-copilot",
      COPILOT_PILOT_TOKEN: "fake-pilot",
    };
    let closed = false;
    const result = await runHost({
      directory,
      codexBin,
      stateDir,
      model: model.id,
      environment,
      args: ["--yolo"],
      connect: async (options) => {
        assert.deepEqual(options.environment, environment);
        return {
          transport: async () => Response.json({ data: [model] }),
          close: async () => {
            closed = true;
          },
        };
      },
    });
    assert.equal(result, 7);
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "result.json"), "utf8")),
      {
        cwd: directory,
        home: root,
        tool: "host-tool-ok",
        outside: "host file",
        credentials: [
          "fake-gh",
          "fake-github",
          "fake-openai",
          "fake-copilot",
          "fake-pilot",
        ],
        state: stateDir,
        yolo: 1,
        sandbox: "danger-full-access",
        approvals: false,
        environmentPolicy:
          'shell_environment_policy={inherit="all",ignore_default_excludes=true}',
      },
    );
    assert.equal(closed, true);
    assert.deepEqual(await readdir(stateDir), []);
  },
);

test("host launcher closes the SDK and removes transient state when the model is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-host-denied-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let closed = false;
  await assert.rejects(
    runHost({
      directory: root,
      stateDir: root,
      model: "unavailable",
      codexBin: "must-not-launch",
      connect: async () => ({
        transport: async () => Response.json({ data: [model] }),
        close: async () => {
          closed = true;
        },
      }),
    }),
    /not enabled/,
  );
  assert.equal(closed, true);
  assert.deepEqual(await readdir(root), []);
});
