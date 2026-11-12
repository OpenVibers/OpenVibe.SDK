'use strict';
/**
 * openvibe-sdk/agents/blueprint: make your own agent (agent-blueprints.md, 2026-11-12). A blueprint
 * (agents.blueprint@1) is an agent as one small document of ten parts: face, brain, knows, hands, places, memory,
 * rules, when, makes and team, with `inputs` an installer fills and `needs` they must connect. These are pure
 * functions; nothing here calls a network or stores anything.
 *
 *   validate(doc)                        → { ok, errors: [{ at, why }] }: the shape and the rules a schema cannot say
 *   withDefaults(doc)                    → a copy with every absent part at its safe default
 *   asks(doc, { describe })              → what installing it lets it do, in words: [{ key, part, words, ask }]
 *   wider(oldDoc, newDoc)                → what a new version asks for that the old one did not ([] = not wider)
 *   unagreed(doc, agreed)                → the asks an install has not agreed to yet
 *   fill(doc, inputs)                    → a copy with {{inputs}} replaced, typed and checked (throws BlueprintError)
 *   compile(doc, { install, inputs, text, context, tryIt })
 *                                        → { start, loop, dispatch, place, memory, team }: one run of it
 *   estimate(doc, choices, { turns })    → { usd_per_run, choice, free_on, why } through agents/dispatch
 *   ref(doc) / parseRef('bp_…@3')        → the version's address, and back
 *
 * The rules beyond the schema (Contracts validates the shape with the schema itself; validate() here keeps the
 * rules so a browser, Link or a CLI can check a draft without a schema validator):
 *   - a blueprint carries no secret: a string that looks like a key, a token or a private key is refused;
 *   - every {{input}} it uses is declared in INPUTS;
 *   - level `full` needs a budget (run_usd or day_usd);
 *   - a `machine:` tool needs a place to run on (PLACES other than none); a `robot:` tool needs `robot` in
 *     PLACES.NEEDS or a robot in NEEDS; `shared` places say what they need (a blueprint never names a machine);
 *   - served as an MCP tool, it has an answer shape (MAKES.SCHEMA) and an input shape (SERVE.INPUT);
 *   - a team's roles are other blueprints at fixed versions, never itself.
 * The floor is not a field: money, passwords, deletions, new recipients and posting in a person's name ask at every
 * level (FLOOR), whatever a blueprint says; products enforce it at their gates, and compile() says it in the prompt.
 */

const dispatch = require('./dispatch');

const BP_ID = /^bp_[A-Za-z0-9_-]{3,40}$/;
const BP_REF = /^(bp_[A-Za-z0-9_-]{3,40})@([1-9][0-9]{0,5})$/;
const TOOL = new RegExp('^(?:'
    + 'ov:[a-z][a-z0-9-]{0,40}(?:\\.[a-z0-9_-]{1,60}){1,4}'
    + '|tools:[a-z0-9][a-z0-9-]{0,60}(?:\\.[a-z0-9_-]{1,60}){0,3}'
    + '|connect:[a-z0-9][a-z0-9-]{0,60}(?:\\.[a-z0-9_-]{1,60}){0,3}'
    + '|mcp:https://[^\\s]{4,1800}'
    + '|machine:(?:files|shell|desk|browser|screen)'
    + '|robot:[a-z0-9_][a-z0-9_.-]{0,80}'
    + '|harness:(?:auto|dsh|codex|claude-code|opencode|hermes|gemini)'
    + '|agent:(?:bp_[A-Za-z0-9_-]{3,40}(?:@[1-9][0-9]{0,5})?|agt_[A-Za-z0-9]{6,40})'
    + ')$');
const INPUT_RE = /\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/g;

const STATES = ['draft', 'published', 'retired'];
const VISIBILITY = ['private', 'link', 'public'];
const LEVELS = ['ask', 'auto-edits', 'approve-for-me', 'full'];
const WHO = ['owner', 'list', 'followers', 'anyone'];
const MEMORY = ['none', 'thread', 'person', 'team'];
const PLACES = ['none', 'own', 'shared', 'openvibe', 'sandbox'];
const PLACE_NEEDS = ['gpu', 'desk', 'browser', 'linux', 'windows', 'macos', 'android', 'robot'];
const WHEN = ['manual', 'chat', 'feed', 'comments', 'git', 'composer', 'notifications', 'mail', 'schedule', 'goal', 'event', 'webhook', 'machine'];
const INPUT_TYPES = ['text', 'number', 'boolean', 'choice', 'channel', 'room', 'repository', 'machine', 'url'];
const FLOOR = ['money', 'password', 'deletion', 'new-recipient', 'post-as-you'];
const FLOOR_WORDS = 'spending money, a password, deleting anything, a new recipient, and posting in your name';

/** Strings that look like a credential. A blueprint is shared and public; a secret never belongs in one. */
const SECRET_RE = [
    /\bsk-[A-Za-z0-9_-]{16,}/, /\bsk-ant-[A-Za-z0-9_-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /\bAIza[0-9A-Za-z_-]{35}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bhbt_[A-Za-z0-9]{20,}/, /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

class BlueprintError extends Error {
    constructor(errors) {
        super(errors.map((e) => `${e.at}: ${e.why}`).join('; '));
        this.name = 'BlueprintError';
        this.errors = errors;
    }
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const copy = (v) => JSON.parse(JSON.stringify(v));
const rank = (list, v) => list.indexOf(v);

/** Every string in a document, with where it is. */
function strings(v, at = '', out = []) {
    if (typeof v === 'string') out.push([at || '/', v]);
    else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}/${i}`, out));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) strings(x, `${at}/${k}`, out);
    return out;
}

/** The {{inputs}} a document uses: in its instructions, greeting and triggers. */
function usedInputs(doc) {
    const places = [
        ['/knows/instructions', doc.knows && doc.knows.instructions],
        ['/face/greeting', doc.face && doc.face.greeting],
        ...arr(doc.when).flatMap((w, i) => [[`/when/${i}/rule`, w && w.rule], [`/when/${i}/where/id`, w && w.where && w.where.id]]),
    ];
    const out = [];
    for (const [at, s] of places) {
        if (typeof s !== 'string') continue;
        for (const m of s.matchAll(INPUT_RE)) out.push({ at, id: m[1] });
    }
    return out;
}

/**
 * Check a blueprint. Returns { ok, errors: [{ at, why }] }; `at` is a JSON pointer. It checks the parts a person
 * edits and every rule above; a service also validates the whole shape against Contracts' agents.blueprint@1.
 */
function validate(doc) {
    const errors = [];
    const bad = (at, why) => errors.push({ at, why });
    if (!isObj(doc)) return { ok: false, errors: [{ at: '/', why: 'a blueprint is an object' }] };

    if (!BP_ID.test(String(doc.id || ''))) bad('/id', 'an id is bp_ and 3 to 40 letters, digits, - or _');
    if (!Number.isInteger(doc.version) || doc.version < 1) bad('/version', 'a version is a whole number from 1');
    if (!STATES.includes(doc.state)) bad('/state', `one of ${STATES.join(', ')}`);
    if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 60) bad('/name', 'a name of 1 to 60 characters');
    if (typeof doc.summary !== 'string' || !doc.summary.trim() || doc.summary.length > 300) bad('/summary', 'a summary of 1 to 300 characters');
    if (!isObj(doc.author) || !['user', 'service'].includes(doc.author.type) || !doc.author.id) bad('/author', 'who made it: { type: user | service, id }');
    if (!VISIBILITY.includes(doc.visibility)) bad('/visibility', `one of ${VISIBILITY.join(', ')}`);
    if (doc.state === 'published' && !doc.published_at) bad('/published_at', 'a published version says when');
    if (doc.forked_from != null && !BP_REF.test(String(doc.forked_from))) bad('/forked_from', 'a version: bp_…@N');
    if (!isObj(doc.knows) || typeof doc.knows.instructions !== 'string' || !doc.knows.instructions.trim()) bad('/knows/instructions', 'it needs instructions');

    for (const [at, s] of strings(doc)) if (SECRET_RE.some((re) => re.test(s))) bad(at, 'this looks like a key or a token: a blueprint carries no secret (the installer connects their own)');

    const declared = new Map();
    arr(doc.inputs).forEach((inp, i) => {
        if (!isObj(inp) || !/^[a-z][a-z0-9_]{0,30}$/.test(String(inp.id || ''))) return bad(`/inputs/${i}/id`, 'an input id is lower case: a-z, 0-9, _');
        if (declared.has(inp.id)) bad(`/inputs/${i}/id`, `${inp.id} is declared twice`);
        if (!INPUT_TYPES.includes(inp.type)) bad(`/inputs/${i}/type`, `one of ${INPUT_TYPES.join(', ')}`);
        if (inp.type === 'choice' && arr(inp.choices).length < 2) bad(`/inputs/${i}/choices`, 'a choice needs two or more choices');
        declared.set(inp.id, inp);
    });
    for (const u of usedInputs(doc)) if (!declared.has(u.id)) bad(u.at, `{{${u.id}}} is not one of its inputs`);

    const brain = isObj(doc.brain) ? doc.brain : {};
    if (brain.pick === 'exact' && !brain.model) bad('/brain/model', 'an exact pick names the model');
    if (brain.pick === 'size' && !brain.size) bad('/brain/size', 'a size pick names the size');
    for (const r of arr(brain.rungs)) if (!dispatch.RUNGS.includes(r)) bad('/brain/rungs', `${r} is not a rung (${dispatch.RUNGS.join(', ')})`);

    const tools = arr(doc.hands && doc.hands.tools);
    tools.forEach((t, i) => {
        if (!isObj(t) || !TOOL.test(String(t.tool || ''))) return bad(`/hands/tools/${i}/tool`, `${t && t.tool} is not a tool OpenVibe knows (ov:, tools:, connect:, mcp:https://, machine:, robot:, harness:, agent:)`);
        if (!['allow', 'ask'].includes(t.mode)) bad(`/hands/tools/${i}/mode`, 'allow or ask');
    });

    const places = isObj(doc.places) ? doc.places : {};
    const order = arr(places.order).length ? places.order : ['none'];
    for (const p of order) if (!PLACES.includes(p)) bad('/places/order', `${p} is not a kind of place (${PLACES.join(', ')}); a blueprint never names a machine, the install does`);
    for (const n of arr(places.needs)) if (!PLACE_NEEDS.includes(n)) bad('/places/needs', `${n} is not something a place can have`);
    const runsSomewhere = order.some((p) => p !== 'none');
    if (tools.some((t) => /^machine:/.test(t && t.tool)) && !runsSomewhere) bad('/places/order', 'a machine: tool needs a place to run on');
    const robotNeeded = arr(places.needs).includes('robot') || arr(doc.needs).some((n) => n && n.kind === 'robot');
    if (tools.some((t) => /^robot:/.test(t && t.tool)) && !robotNeeded) bad('/places/needs', 'a robot: tool needs a robot (robot in places.needs, or a robot in needs)');
    if (order.includes('shared') && !arr(places.needs).length) bad('/places/needs', 'a shared place says what it needs (gpu, desk, …), so the installer picks a machine that has it');

    const memory = doc.memory;
    if (memory != null && (!isObj(memory) || !MEMORY.includes(memory.scope))) bad('/memory/scope', `one of ${MEMORY.join(', ')}`);

    const rules = isObj(doc.rules) ? doc.rules : {};
    if (rules.level != null && !LEVELS.includes(rules.level)) bad('/rules/level', `one of ${LEVELS.join(', ')}`);
    if (rules.level === 'full' && !(isObj(rules.budget) && (rules.budget.run_usd != null || rules.budget.day_usd != null))) bad('/rules/budget', 'level full needs a budget (run_usd or day_usd)');
    if (rules.who != null && !(isObj(rules.who) && WHO.includes(rules.who.may))) bad('/rules/who/may', `one of ${WHO.join(', ')}`);

    arr(doc.when).forEach((w, i) => {
        if (!isObj(w) || !WHEN.includes(w.kind)) return bad(`/when/${i}/kind`, `one of ${WHEN.join(', ')}`);
        if (w.kind === 'schedule' && !/^\S+(?: \S+){4}$/.test(String(w.cron || ''))) bad(`/when/${i}/cron`, 'a schedule has five cron fields');
        if (w.kind === 'event' && !/^[a-z][a-z0-9]{0,40}(?:\.[a-z0-9_]{1,60}){1,4}$/.test(String(w.event || ''))) bad(`/when/${i}/event`, 'an event is an OpenVibe.Events type (live.stream.started)');
    });

    const makes = isObj(doc.makes) ? doc.makes : {};
    const serve = isObj(makes.serve) ? makes.serve : {};
    if (serve.mcp === true && !isObj(makes.schema)) bad('/makes/schema', 'served as a tool, it says the shape of its answer');
    if (serve.mcp === true && !isObj(serve.input)) bad('/makes/serve/input', 'served as a tool, it says the shape of what a caller sends');

    if (doc.team != null) {
        const team = doc.team;
        if (!isObj(team) || !/^[a-z][a-z0-9-]{0,60}$/.test(String(team.play || ''))) bad('/team/play', 'a play id');
        const roles = isObj(team && team.roles) ? Object.entries(team.roles) : [];
        if (!roles.length) bad('/team/roles', 'a team has roles');
        for (const [role, r] of roles) {
            const m = BP_REF.exec(String(r || ''));
            if (!m) bad(`/team/roles/${role}`, 'a role is another blueprint at a fixed version: bp_…@N');
            else if (m[1] === doc.id) bad(`/team/roles/${role}`, 'a blueprint cannot be a role in its own team');
        }
    }
    return { ok: errors.length === 0, errors };
}

/** A copy with every absent part at its safe default: talks only, asks first, keeps nothing, starts when asked. */
function withDefaults(doc) {
    const d = copy(doc || {});
    d.inputs = arr(d.inputs);
    d.needs = arr(d.needs);
    d.face = { glyph: 'sparkle', voice: null, ...(d.face || {}) };
    d.brain = { pick: 'auto', rungs: dispatch.RUNGS.slice(), depth: 'balanced', advisor: null, decisions: false, ...(d.brain || {}) };
    d.knows = { skills: [], knowledge: [], examples: [], ...(d.knows || {}) };
    d.hands = { tools: [], search: false, ...(d.hands || {}) };
    d.places = { order: ['none'], needs: [], ...(d.places || {}) };
    d.memory = { scope: 'none', keep_days: null, ...(d.memory || {}) };
    const rules = d.rules || {};
    d.rules = { level: 'ask', ...rules, budget: { run_usd: 0.25, day_usd: 2, ...(rules.budget || {}) }, who: rules.who || { may: 'owner' } };
    d.when = arr(d.when);
    d.makes = { answer: ['text'], schema: null, ...(d.makes || {}) };
    d.makes.serve = { a2a: false, mcp: false, ...(d.makes.serve || {}) };
    if (d.team === undefined) d.team = null;
    return d;
}

/** A tool's id in words, when no catalogue describes it: ov:live.chat.post → "live: chat post". */
function toolWords(tool) {
    const [ns, rest = ''] = String(tool).split(/:(.*)/s);
    if (ns === 'mcp') return `your own tool server at ${rest.replace(/^https:\/\//, '').split('/')[0]}`;
    if (ns === 'machine') return { files: 'files on its machine', shell: 'a terminal on its machine', desk: 'a private desk on its machine', browser: 'a browser on its machine', screen: 'the screen of its machine' }[rest] || rest;
    if (ns === 'robot') return `the robot's ${rest.replace(/[._]/g, ' ')}`;
    if (ns === 'harness') return rest === 'auto' ? 'a coding agent' : `the coding agent ${rest}`;
    if (ns === 'agent') return `another agent (${rest})`;
    const [product, ...parts] = rest.split('.');
    return `${product}: ${parts.join(' ').replace(/[_-]/g, ' ')}`.trim();
}

const money = (n) => (n < 1 ? `${Math.round(n * 100)}¢` : `$${Number(n).toFixed(2).replace(/\.00$/, '')}`);

/**
 * What installing it lets it do, in words, for the install screen and for `agreed` (by key). Each item:
 * { key, part, words, ask } where ask true means every use asks first. `describe(tool)` may return better words
 * from a catalogue (the one MCP endpoint's tool list); absent, the id is put in words.
 */
function asks(doc, { describe } = {}) {
    const d = withDefaults(doc);
    const out = [];
    const add = (key, part, words, ask = false) => out.push({ key, part, words, ask });
    for (const t of d.hands.tools) {
        const w = (describe && describe(t.tool)) || toolWords(t.tool);
        add(`hands:${t.tool}`, 'hands', t.mode === 'ask' ? `uses ${w} (asks you first each time)` : `uses ${w}`, t.mode === 'ask');
    }
    if (d.hands.search) add('hands:search', 'hands', 'finds more OpenVibe tools when it needs them (each asks you first)', true);
    for (const p of d.places.order) {
        if (p === 'none') continue;
        const needs = d.places.needs.length ? ` that has ${d.places.needs.join(', ')}` : '';
        add(`places:${p}`, 'places', {
            own: `runs work on a machine of yours${needs}`,
            shared: `runs work on a machine shared with you${needs} (that machine's grant still applies)`,
            openvibe: 'runs work on an OpenVibe computer',
            sandbox: 'runs work in a throwaway sandbox',
        }[p]);
    }
    if (d.memory.scope !== 'none') {
        const keep = d.memory.keep_days ? ` for ${d.memory.keep_days} days` : '';
        add(`memory:${d.memory.scope}`, 'memory', { thread: `remembers within a conversation${keep}`, person: `remembers what it learns about your work${keep}`, team: `shares what it remembers with its team${keep}` }[d.memory.scope]);
    }
    if (d.rules.level !== 'ask') {
        add(`rules:level:${d.rules.level}`, 'rules', {
            'auto-edits': 'edits and runs its own work without asking',
            'approve-for-me': 'answers its own questions for you, within its budget',
            full: 'acts without asking, within its budget',
        }[d.rules.level]);
    }
    const b = d.rules.budget;
    add(`rules:budget:${b.run_usd != null ? b.run_usd : '-'}/${b.day_usd != null ? b.day_usd : '-'}`, 'rules',
        `spends at most ${[b.run_usd != null && `${money(b.run_usd)} a run`, b.day_usd != null && `${money(b.day_usd)} a day`].filter(Boolean).join(' and ') || 'what you allow'}`);
    if (d.rules.who.may !== 'owner') add(`rules:who:${d.rules.who.may}`, 'rules', { list: 'can be asked by people you list', followers: 'can be asked by your followers', anyone: 'can be asked by anyone where it is' }[d.rules.who.may]);
    for (const w of d.when) {
        if (w.kind === 'manual' || w.kind === 'composer') continue;
        const key = w.kind === 'event' ? `when:event:${w.event}` : `when:${w.kind}`;
        const words = w.kind === 'schedule' ? `starts on a schedule (${w.cron}${w.tz ? ` ${w.tz}` : ''})`
            : w.kind === 'event' ? `starts when ${w.event} happens`
                : `starts from ${w.kind}${w.rule ? `: ${w.rule}` : ''}`;
        if (!out.some((o) => o.key === key)) add(key, 'when', words);
    }
    if (d.makes.serve.a2a) add('makes:a2a', 'makes', 'other agents can ask it (only the people its rules allow)');
    if (d.makes.serve.mcp) add('makes:mcp', 'makes', 'apps can use it as a tool (only the people its rules allow)');
    if (d.team) for (const [role, r] of Object.entries(d.team.roles || {})) add(`team:${role}:${r}`, 'team', `works with ${r} as its ${role}`);
    return out;
}

/**
 * What NEW asks for that OLD did not: new tools, a tool from ask to allow, a wider place, more memory, a higher
 * level, a bigger budget, more people who may ask, a new trigger, being served, a new team member. [] means a
 * version an install with updates "same-or-less" takes without asking.
 */
function wider(oldDoc, newDoc) {
    const a = withDefaults(oldDoc);
    const b = withDefaults(newDoc);
    const out = [];
    const oldAsks = new Map(asks(a).map((x) => [x.key, x]));
    const mode = (d) => new Map(d.hands.tools.map((t) => [t.tool, t.mode]));
    const am = mode(a);
    for (const x of asks(b)) {
        if (x.part === 'rules' || x.part === 'memory') continue; // compared by rank below
        if (oldAsks.has(x.key)) {
            if (x.part === 'hands' && x.key !== 'hands:search' && am.get(x.key.slice(6)) === 'ask' && !x.ask) out.push({ key: x.key, words: `${x.words} without asking first` });
            continue;
        }
        out.push({ key: x.key, words: x.words });
    }
    if (rank(LEVELS, b.rules.level) > rank(LEVELS, a.rules.level)) out.push({ key: `rules:level:${b.rules.level}`, words: asks(b).find((x) => x.key === `rules:level:${b.rules.level}`).words });
    if (rank(WHO, b.rules.who.may) > rank(WHO, a.rules.who.may)) out.push({ key: `rules:who:${b.rules.who.may}`, words: asks(b).find((x) => x.key === `rules:who:${b.rules.who.may}`).words });
    if (rank(MEMORY, b.memory.scope) > rank(MEMORY, a.memory.scope) || ((b.memory.keep_days == null) !== (a.memory.keep_days == null) && b.memory.keep_days == null && b.memory.scope !== 'none') || (a.memory.keep_days != null && b.memory.keep_days != null && b.memory.keep_days > a.memory.keep_days)) {
        out.push({ key: `memory:${b.memory.scope}`, words: (asks(b).find((x) => x.part === 'memory') || { words: 'remembers more' }).words });
    }
    const more = (x, y) => (y == null && x != null) || (x != null && y != null && y > x);
    if (more(a.rules.budget.run_usd, b.rules.budget.run_usd) || more(a.rules.budget.day_usd, b.rules.budget.day_usd)) {
        const bud = asks(b).find((x) => x.key.startsWith('rules:budget:'));
        out.push({ key: bud.key, words: bud.words });
    }
    return out;
}

/** The asks of DOC an install has not agreed to (its `agreed` keys). */
function unagreed(doc, agreed) {
    const have = new Set(arr(agreed));
    return asks(doc).filter((x) => !have.has(x.key));
}

/** Check INPUTS against the declared inputs: required, typed, a choice from its list; defaults filled. */
function inputValues(doc, inputs) {
    const errors = [];
    const values = {};
    const given = isObj(inputs) ? inputs : {};
    for (const inp of arr(doc.inputs)) {
        let v = given[inp.id];
        if (v === undefined || v === '') v = inp.default;
        if (v === undefined) { if (inp.required) errors.push({ at: `/inputs/${inp.id}`, why: `${inp.label || inp.id} is needed` }); continue; }
        if (inp.type === 'number') { v = Number(v); if (!Number.isFinite(v)) errors.push({ at: `/inputs/${inp.id}`, why: 'a number' }); }
        else if (inp.type === 'boolean') v = v === true || v === 'true';
        else v = String(v);
        if (inp.type === 'choice' && !arr(inp.choices).includes(v)) errors.push({ at: `/inputs/${inp.id}`, why: `one of ${arr(inp.choices).join(', ')}` });
        if (inp.type === 'url' && !/^https:\/\//.test(v)) errors.push({ at: `/inputs/${inp.id}`, why: 'an https address' });
        if (typeof v === 'string' && v.length > 2000) errors.push({ at: `/inputs/${inp.id}`, why: 'at most 2000 characters' });
        values[inp.id] = v;
    }
    for (const k of Object.keys(given)) if (!arr(doc.inputs).some((i) => i.id === k)) errors.push({ at: `/inputs/${k}`, why: 'not one of its inputs' });
    return { values, errors };
}

/** A copy with {{inputs}} replaced. Throws BlueprintError when an input is missing, mistyped or unknown. */
function fill(doc, inputs) {
    const { values, errors } = inputValues(doc, inputs);
    for (const u of usedInputs(doc)) if (!(u.id in values) && !arr(doc.inputs).some((i) => i.id === u.id)) errors.push({ at: u.at, why: `{{${u.id}}} is not one of its inputs` });
    if (errors.length) throw new BlueprintError(errors);
    const sub = (s) => (typeof s === 'string' ? s.replace(INPUT_RE, (_, id) => (id in values ? String(values[id]) : '')) : s);
    const d = copy(doc);
    if (d.knows) d.knows.instructions = sub(d.knows.instructions);
    if (d.face && d.face.greeting) d.face.greeting = sub(d.face.greeting);
    for (const w of arr(d.when)) {
        if (w.rule) w.rule = sub(w.rule);
        if (w.where && w.where.id) w.where.id = sub(w.where.id);
    }
    return d;
}

const ref = (doc) => `${doc.id}@${doc.version}`;
function parseRef(s) {
    const m = BP_REF.exec(String(s || ''));
    return m ? { id: m[1], version: Number(m[2]) } : null;
}

/** The Dispatcher's need for this brain: capabilities and, for a size pick, the tier. */
function needOf(brain, tools) {
    const caps = new Set(arr(brain.caps));
    if (tools.length) caps.add('tools');
    const need = { caps: [...caps] };
    if (brain.pick === 'size' && brain.size) need.tier = brain.size;
    return need;
}

/**
 * One run of a blueprint. INSTALL (agents.install@1) supplies the agent, inputs and machines; without one (TRY_IT
 * or a run of a version once), every tool asks first and the budget is at most 5¢. Returns:
 *   start:    agents.run-start@1 (text, agent or blueprint, play, budget, depth, context)
 *   loop:     { system, tools: [{ name, mode }], search, budget, schema }   what agents/loop needs
 *   dispatch: { pin, rungs, maxPrice, need, advisor, decisions }           what agents/dispatch needs
 *   place:    { order, needs, machines }                                    where its work may run
 *   memory:   { scope, remember, keep_days }
 *   team:     the play and its roles, or null
 */
function compile(doc, { install = null, inputs, text = '', context, tryIt = false } = {}) {
    const v = validate(doc);
    if (!v.ok) throw new BlueprintError(v.errors);
    const once = tryIt || !install;
    const d = withDefaults(fill(doc, inputs !== undefined ? inputs : (install && install.inputs) || {}));
    const tools = d.hands.tools.map((t) => ({ name: t.tool, mode: once ? 'ask' : t.mode }));
    const budget = {};
    if (d.rules.budget.run_usd != null) budget.usd = d.rules.budget.run_usd;
    if (d.rules.budget.run_seconds != null) budget.seconds = d.rules.budget.run_seconds;
    if (d.rules.budget.run_steps != null) budget.steps = d.rules.budget.run_steps;
    if (once) budget.usd = Math.min(budget.usd != null ? budget.usd : 0.05, 0.05);

    const lines = [d.knows.instructions.trim()];
    if (d.face.tone) lines.push(`How you talk: ${d.face.tone}`);
    if (d.memory.remember && d.memory.scope !== 'none') lines.push(`Worth remembering: ${d.memory.remember}`);
    lines.push(`Always ask the person first before ${FLOOR_WORDS}, whatever else you are allowed.`);

    const start = { text: String(text || ''), title: d.name };
    if (install && !tryIt) start.agent = install.agent; else start.blueprint = ref(doc);
    if (d.team) start.play = d.team.play;
    if (Object.keys(budget).length) start.budget = budget;
    if (d.brain.depth) start.depth = d.brain.depth;
    if (context) start.context = context;

    return {
        start,
        loop: { system: lines.join('\n\n'), tools, search: !!d.hands.search, budget, schema: isObj(d.makes.schema) ? d.makes.schema : null },
        dispatch: {
            pin: d.brain.pick === 'exact' ? d.brain.model : null,
            rungs: arr(d.brain.rungs).length ? d.brain.rungs.slice() : dispatch.RUNGS.slice(),
            maxPrice: d.brain.max_usd_per_m != null ? d.brain.max_usd_per_m : null,
            need: needOf(d.brain, tools),
            advisor: d.brain.advisor || null,
            decisions: !!d.brain.decisions,
        },
        place: { order: d.places.order.slice(), needs: d.places.needs.slice(), machines: (install && install.places) || { own: [], shared: [] } },
        memory: { scope: d.memory.scope, remember: d.memory.remember || null, keep_days: d.memory.keep_days },
        team: d.team ? copy(d.team) : null,
    };
}

/**
 * What one run costs on the cheapest choice that can do it (Exchange's choices merged with the person's own, as
 * agents/dispatch takes them). TURNS model calls of TOKENS each (defaults: 4 turns of 2000 in, 800 out). FREE_ON
 * lists the rungs among the person's choices on which it costs nothing (their machine, a plan, the allowance).
 */
function estimate(doc, choices, { turns = 4, tokens = { tokensIn: 2000, tokensOut: 800 } } = {}) {
    const d = withDefaults(doc);
    const rungs = new Set(arr(d.brain.rungs).length ? d.brain.rungs : dispatch.RUNGS);
    const maxPrice = d.brain.max_usd_per_m;
    const allowed = arr(choices).filter((c) => c && rungs.has(c.rung)
        && (maxPrice == null || !c.price || ((c.price.in || 0) <= maxPrice && (c.price.out || 0) <= maxPrice)));
    const need = needOf(d.brain, d.hands.tools);
    const pin = d.brain.pick === 'exact' ? d.brain.model : null;
    const p = dispatch.pick(allowed, { need, pin, tokens });
    if (!p.choice) return { usd_per_run: null, choice: null, free_on: [], why: p.why || 'nothing it may use can do it' };
    const usd = Math.round(dispatch.estimate(p.choice, tokens) * turns * 1e6) / 1e6;
    const free = dispatch.ladder(allowed, { need, tokens }).filter((c) => dispatch.estimate(c, tokens) === 0).map((c) => c.rung);
    return { usd_per_run: usd, choice: p.choice, free_on: [...new Set(free)], why: p.why };
}

module.exports = {
    validate, withDefaults, asks, wider, unagreed, fill, compile, estimate, ref, parseRef, toolWords,
    BlueprintError, FLOOR, LEVELS, PLACES, MEMORY, WHO, WHEN, INPUT_TYPES, TOOL, BP_REF,
};
