// Test instrumentation only. Leaf tools and prompt assembly are real;
// every model/network dispatch is deliberately stopped before transport.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Plugin, Model, Provider } from '@opencode/plugin';
const posix = (p) => p.replaceAll('\\', '/');
const textOf = (r) => typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
const items = (r) => Array.isArray(r) ? r : r.data;
function resourceUnder(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'SKILL.md') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { const nested = resourceUnder(p); if (nested) return nested; }
    else if (/\.(md|py)$/.test(entry.name)) return p;
  }
}
export default Plugin.define({
  id: 'ars-installation-test-probe',
  async setup(ctx) {
    const root = ctx.location.directory;
    const registrations = [];
    const providerID = Provider.ID.make('ars-install-test');
    const modelID = Model.ID.make('never-dispatch');
    registrations.push(await ctx.provider.transform((e) => e.add({
      info: { ...Provider.Info.empty(providerID), activation: 'enabled',
        package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://127.0.0.1:1/never' } },
      models: [{ ...Model.Info.default(providerID, modelID), enabled: true,
        limit: { context: 300000, input: 280000, output: 1000 } }],
    })));
    registrations.push(await ctx.session.hook('title', (e) => { e.result = 'isolated installation probe'; }));
    registrations.push(await ctx.session.hook('http.request', () => { throw new Error('fixture forbids model HTTP'); }));
    registrations.push(await ctx.session.hook('experimental.ws.handshake', () => { throw new Error('fixture forbids model WebSocket'); }));
    const captures = new Map();
    registrations.push(await ctx.session.hook('context', (e) => {
      if (!captures.has(e.sessionID)) throw new Error('fixture forbids unrequested model work');
      const expected = captures.get(e.sessionID);
      const assembled = e.system.map((p) => p.text ?? '').join('\n').replaceAll('\r\n', '\n');
      writeFileSync(join(root, 'instruction-probe.json'), JSON.stringify({
        assembled: true, instructionLoaded: !expected || assembled.includes(expected.replaceAll('\r\n', '\n')),
        canonicalRouting: assembled.includes('<!-- routing-core:begin -->'),
        commandRootBound: JSON.stringify(e.messages).includes(posix(root)),
        home: posix(homedir()), directory: posix(root),
      }, null, 2));
      throw new Error('fixture captured assembled instructions; inference intentionally forbidden');
    }));
    const evaluations = [];
    registrations.push(await ctx.permission.hook('evaluate', (e) => {
      evaluations.push({ action: e.action, agent: e.agent, resources: [...e.resources], effect: e.effect, message: e.message });
    }));
    registrations.push(await ctx.command.transform((e) => e.add({
      name: 'installation-test-probe', description: 'Isolated host test only',
      async execute({ sessionID, prompt }) {
        const tools = await ctx.tool.list();
        const context = (id, agent = 'build') => ({ sessionID: id, agent,
          messageID: 'msg_installfixture', id: 'installfixture',
          signal: AbortSignal.timeout(30000), progress: async () => {} });
        if (prompt.text === 'inventory') {
          const skills = items(await ctx.skill.list());
          const agents = items(await ctx.agent.list());
          const commands = items(await ctx.command.list());
          const loader = tools.find((t) => t.id === 'skill');
          const reader = tools.find((t) => t.id === 'read');
          if (!loader || !reader) throw new Error('native skill/read tools missing');
          const loaded = [];
          for (const id of ['academic-paper','academic-paper-reviewer','academic-pipeline','deep-research','sr-screener']) {
            const info = skills.find((s) => s.id === id);
            if (!info) throw new Error(`native skill ${id} missing`);
            const body = textOf(await loader.execute({ id }, context(sessionID)));
            const resource = resourceUnder(dirname(info.path));
            if (!resource) throw new Error(`no supporting resource for ${id}`);
            const firstLine = readFileSync(resource, 'utf8').split(/\r?\n/).find((line) => line.length > 20);
            const read = textOf(await reader.execute({ path: resource }, context(sessionID)));
            loaded.push({ id, path: posix(info.path), bodyLoaded: body.includes('Step 0') && body.includes('routing-core:begin'),
              resource: posix(resource), resourceRead: Boolean(firstLine && read.includes(firstLine)),
              contentDigest: createHash('sha256').update(info.content).digest('hex') });
          }
          const status = tools.find((t) => t.id === 'ars_opencode_status');
          const actualStatus = status ? await status.execute({}, context(sessionID)) : null;
          writeFileSync(join(root, 'installation-inventory.json'), JSON.stringify({
            home: posix(homedir()), directory: posix(root), skills: loaded,
            agents: agents.map((a) => ({ id: a.id, system: a.system, mode: a.mode, model: a.model, permissions: a.permissions })),
            commands: commands.map((c) => c.name), toolIDs: tools.map((t) => t.id), status: actualStatus,
          }, null, 2));
          return;
        }
        if (prompt.text === 'context') {
          const plugin = tools.some((t) => t.id === 'ars_opencode_status');
          const local = join(root, '.opencode', 'ars-instructions.md');
          const global = join(process.env.XDG_CONFIG_HOME, 'opencode', 'ars-instructions.md');
          const expected = !plugin && existsSync(local) ? readFileSync(local, 'utf8')
            : !plugin && existsSync(global) ? readFileSync(global, 'utf8') : '';
          const session = await ctx.session.create({ title: 'fixture context capture', agent: 'build' });
          captures.set(session.id, expected);
          try {
            await ctx.session.switchModel({ sessionID: session.id, model: { providerID, id: modelID } });
            if (plugin) await ctx.session.command({ sessionID: session.id, name: 'ars-full', text: 'installation check only' });
            else await ctx.session.prompt({ sessionID: session.id, text: 'installation instruction assembly only' });
            try { await ctx.session.wait({ sessionID: session.id }); } catch { /* capture deliberately aborts inference */ }
            if (!existsSync(join(root, 'instruction-probe.json'))) throw new Error('no assembled instruction capture');
          } finally {
            captures.delete(session.id);
            await ctx.session.remove({ sessionID: session.id });
          }
          return;
        }
        if (prompt.text === 'writes') {
          const statusTool = tools.find((t) => t.id === 'ars_opencode_status');
          const writer = tools.find((t) => t.id === 'write');
          if (!statusTool || !writer) throw new Error('ARS status or native write tool absent');
          const before = await statusTool.execute({}, context(sessionID));
          if (before.metadata?.guard !== 'active') throw new Error('ARS guard is not active; no writes attempted');
          const results = [];
          for (const [agent, phase, expected] of [
            ['research-architect-agent', 1, 'allow'], ['research-architect-agent', 3, 'deny'],
            ['synthesis-agent', 3, 'allow'], ['synthesis-agent', 1, 'deny'],
          ]) {
            const dir = join(root, `phase${phase}_installation`);
            mkdirSync(dir, { recursive: true });
            const file = join(dir, `${agent}-${expected}.md`);
            const session = await ctx.session.create({ title: 'zero-inference write probe', agent });
            evaluations.length = 0;
            let actual = 'allow', error;
            try { await writer.execute({ path: file, content: `fixture ${posix(root)}\n` }, context(session.id, agent)); }
            catch (e) { actual = 'deny'; error = String(e.message ?? e); }
            finally { await ctx.session.remove({ sessionID: session.id }); }
            results.push({ agent, expected, actual, error, file: posix(file),
              exists: existsSync(file), content: existsSync(file) ? readFileSync(file, 'utf8') : null,
              evaluations: [...evaluations], arsDeny: evaluations.some((e) => e.effect === 'deny' && e.message?.startsWith('ARS scope guard:')) });
          }
          const after = await statusTool.execute({}, context(sessionID));
          writeFileSync(join(root, 'installation-writes.json'), JSON.stringify({
            directory: posix(root), guardBefore: before.metadata.guard, guardAfter: after.metadata.guard, results,
          }, null, 2));
          return;
        }
        throw new Error('unknown fixture probe mode');
      },
    })));
    return async () => { for (const r of registrations.reverse()) await r.dispose(); };
  },
});
