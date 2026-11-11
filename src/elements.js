'use strict';
/**
 * openvibe-sdk/elements — the element runtime every product uses.
 *
 * An Element is a look, a recipe (triggers → conditions → actions) and, only when a recipe is not
 * enough, a mod. This module is the one place that decides whether an element is well formed and
 * whether a press runs:
 *
 *   validate(element)                 → { valid, errors: [{ path, message }] }, plain reasons
 *   run(recipe, trigger, ctx)         → the host's decision and the action requests, in order
 *   reduce(state, actions)            → the element's own store after screen.counter/screen.state
 *
 * `run` is deliberately not a command path of its own. It checks the element's declared
 * capabilities, the presser's role, the live and robot-turn conditions, the chance, the cooldowns,
 * the daily caps, then asks the owner (channel points, `ctx.spend`) and only then sends each action
 * to `ctx.send`. The product that owns an action authorises it again; Bot checks turns, Stop, the
 * e-stop and the owner's limits, Live checks points and its own route, Chat checks its content rules.
 * An element never adds a power.
 *
 * The host contract (`ctx`) is small on purpose:
 *
 *   { now?, random?, isLive?, robotInTurn?, subject?, role?,
 *     element: { id?, name?, capabilities: [...] },
 *     actor: { subject?, role?, name? },
 *     limits: { cooldown({scope, elementId, actorId}) → ms remaining,
 *               dailyCount({scope, elementId, actorId, day}) → count,
 *               hit({elementId, actorId, at, day}) → void },
 *     spend({points, elementId, actorId, idempotencyKey, at}) → {ok, reason?, message?},
 *     refund?({...same}) → void,
 *     send(action, {element, actor, trigger, product}) → {ok, result?, reason?, message?} }
 *
 * A product that sends an action to a machine it does not own must keep that product's own checks:
 * this module refuses early where it can, and refuses to send an action the element did not declare.
 */
const ROLES = ['everyone', 'follower', 'subscriber', 'vip', 'operator', 'owner'];
const ROLE_RANK = { everyone: 0, follower: 1, subscriber: 2, vip: 3, operator: 4, owner: 5 };

const PRODUCTS = {
    'robot.drive_pulse': 'bot', 'robot.head_preset': 'bot', 'robot.headlight': 'bot', 'robot.say': 'bot', 'robot.macro': 'bot',
    'chat.message': 'chat', 'chat.pin': 'chat', 'chat.poll': 'chat',
    'screen.alert': 'live', 'screen.animation': 'live', 'screen.confetti': 'live', 'screen.sound': 'live',
    'screen.tts': 'live', 'screen.counter': 'live', 'screen.state': 'live', 'screen.visibility': 'live',
    'screen.scene': 'live', 'stream.clip': 'live', 'stream.moment': 'live', 'stream.title': 'live',
    'stream.category': 'live', 'webhook.call': 'live',
    'ai.ask': 'ai', 'actor.task': 'actor', 'money.tip_goal': 'billing',
};
const ACTION_KINDS = Object.keys(PRODUCTS);
const TRIGGER_KINDS = [
    'press', 'hold', 'double_press', 'key', 'gamepad', 'chat_command', 'chat_text', 'follow', 'tip',
    'ai_moment', 'rundown_topic', 'timer', 'schedule', 'robot_telemetry', 'robot_event', 'stream_start',
    'stream_end', 'viewer_count', 'element_event',
];
const ACTION_SET = new Set(ACTION_KINDS);
const TRIGGER_SET = new Set(TRIGGER_KINDS);
const ROBOT_ACTIONS = ACTION_KINDS.filter((k) => k.startsWith('robot.'));
const ROBOT_SET = new Set(ROBOT_ACTIONS);

const ID_RE = {
    element: /^el_[0-9A-HJKMNP-TV-Z]{26}$/,
    mod: /^mod_[0-9A-HJKMNP-TV-Z]{26}$/,
    key: /^[a-z][a-z0-9_]{0,31}$/,
    token: /^[a-z][a-z0-9-]{0,39}$/,
    component: /^[a-z][a-z0-9-]{0,63}$/,
    icon: /^[a-z][a-z0-9-]{1,31}$/,
    command: /^![a-z0-9_-]{1,32}$/,
    hex64: /^[0-9a-f]{64}$/,
    semver: /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/,
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max = 400) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isInt = (v, min = -Infinity, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min = -Infinity, max = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

// ── Action and trigger checks ──────────────────────────────────────────────
// One small check per kind, the same fields ui.action@1 and ui.trigger@1 declare. It is duplicated
// on purpose: the contract is the wire shape, and this is the host's own last look before it calls
// a product. A drift is a bug found here or in a consumer's contract check, never a power.
const ACTIONS = {
    'robot.drive_pulse': (a) => (['forward', 'back', 'left', 'right', 'spin_left', 'spin_right'].includes(a.direction) && isInt(a.ms, 50, 3000) && (a.speed === undefined || isNum(a.speed, 0.1, 1))) || 'direction and ms (50–3000) are required',
    'robot.head_preset': (a) => ['up', 'center', 'down'].includes(a.preset) || 'preset is up, center or down',
    'robot.headlight': (a) => typeof a.on === 'boolean' || 'on is required (true or false)',
    'robot.say': (a) => isText(a.text, 300) || 'text (300 characters at most) is required',
    'robot.macro': (a) => isText(a.macro, 40) || 'macro is required',
    'chat.message': (a) => isText(a.text, 400) || 'text (400 characters at most) is required',
    'chat.pin': (a) => ['trigger', 'latest'].includes(a.source) || 'source is trigger or latest',
    'chat.poll': (a) => (isText(a.question, 200) && Array.isArray(a.options) && a.options.length >= 2 && a.options.length <= 10 && new Set(a.options).size === a.options.length && a.options.every((o) => isText(o, 80))) || 'question and 2–10 distinct options are required',
    'screen.alert': (a) => (isText(a.title, 80) && (a.text === undefined || isText(a.text, 200))) || 'title is required',
    'screen.animation': (a) => isText(a.name, 40) || 'name is required',
    'screen.confetti': (a) => (a.intensity === undefined || ['low', 'medium', 'high'].includes(a.intensity)) || 'intensity is low, medium or high',
    'screen.sound': (a) => (isText(a.sound, 80) && (a.volume === undefined || isNum(a.volume, 0, 1))) || 'sound is required',
    'screen.tts': (a) => (isText(a.text, 300) && isText(a.voice, 40)) || 'text and voice are required',
    'screen.counter': (a) => (ID_RE.key.test(String(a.key)) && isInt(a.by, -1000, 1000)) || 'key and by (-1000–1000) are required',
    'screen.state': (a) => (ID_RE.key.test(String(a.key)) && isValidValue(a.value)) || 'key and a value (a boolean, a number, a short string or a list of those) are required',
    'screen.visibility': (a) => (ID_RE.element.test(String(a.element)) && typeof a.visible === 'boolean') || 'element and visible are required',
    'screen.scene': (a) => isText(a.scene, 40) || 'scene is required',
    'stream.clip': (a) => (a.seconds === undefined || isInt(a.seconds, 5, 30)) || 'seconds is 5–30',
    'stream.moment': (a) => (a.label === undefined || isText(a.label, 120)) || 'label is 120 characters at most',
    'stream.title': (a) => isText(a.title, 140) || 'title is required',
    'stream.category': (a) => isText(a.category, 80) || 'category is required',
    'ai.ask': (a) => (isText(a.prompt, 500) && (a.model === undefined || isText(a.model, 80)) && (a.max_cost_usd === undefined || isNum(a.max_cost_usd, 0, 1))) || 'prompt is required',
    'actor.task': (a) => isText(a.task, 8000) || 'task is required',
    'webhook.call': (a) => /^[a-z][a-z0-9_-]{0,31}$/.test(String(a.endpoint)) || 'endpoint is required (a name, never a URL)',
    'money.tip_goal': (a) => isText(a.goal, 40) || 'goal is required',
};

const TRIGGERS = {
    press: () => true,
    hold: (t) => isInt(t.ms, 300, 10000) || 'ms is 300–10000',
    double_press: (t) => (t.within_ms === undefined || isInt(t.within_ms, 100, 2000)) || 'within_ms is 100–2000',
    key: (t) => (/^[A-Za-z0-9+_.-]{1,40}$/.test(String(t.key)) && (t.modifiers === undefined || (Array.isArray(t.modifiers) && t.modifiers.length <= 4 && t.modifiers.every((m) => ['ctrl', 'alt', 'shift', 'meta'].includes(m))))) || 'key is required',
    gamepad: (t) => (/^[a-z][a-z0-9_.-]{0,39}$/.test(String(t.button)) && (t.index === undefined || isInt(t.index, 0, 7))) || 'button is required',
    chat_command: (t) => ID_RE.command.test(String(t.command)) || 'command is a lowercase !command',
    chat_text: (t) => (Array.isArray(t.words) && t.words.length >= 1 && t.words.length <= 16 && t.words.every((w) => isText(w, 40))) || 'words (1–16) are required',
    follow: () => true,
    tip: (t) => (t.min === undefined || isInt(t.min, 0)) || 'min is a whole number',
    ai_moment: () => true,
    rundown_topic: (t) => (t.words === undefined || (Array.isArray(t.words) && t.words.length <= 8 && t.words.every((w) => isText(w, 40)))) || 'words (at most 8) must be text',
    timer: (t) => (isInt(t.every_seconds, 5, 86400) && (t.start === undefined || ['live', 'always'].includes(t.start))) || 'every_seconds (5–86400) is required',
    schedule: (t) => (/^[0-9*/, -]{9,80}$/.test(String(t.cron)) && isText(t.timezone, 64)) || 'cron and timezone are required',
    robot_telemetry: (t) => (['battery_percent', 'latency_ms', 'stuck', 'temperature_c'].includes(t.metric) && ['lt', 'gt'].includes(t.op) && isNum(t.value) && (t.for_seconds === undefined || isInt(t.for_seconds, 0, 3600))) || 'metric, op and value are required',
    robot_event: (t) => ['estop', 'stopped', 'disconnected', 'command_refused', 'button'].includes(t.event) || 'event is required',
    stream_start: () => true,
    stream_end: () => true,
    viewer_count: (t) => (['above', 'below'].includes(t.op) && isInt(t.count, 0, 100000000)) || 'op and count are required',
    element_event: (t) => (ID_RE.element.test(String(t.element_id)) && (t.event === undefined || ['pressed', 'state', 'shown'].includes(t.event))) || 'element_id is required',
};

function isValidValue(v) {
    if (typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= 200;
    if (Array.isArray(v)) return v.length <= 64 && v.every((x) => (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 200));
    return false;
}

// ── validate ──────────────────────────────────────────────────────────────
/**
 * Validate one element (a draft or a stored one) against the catalogs and the element's own
 * declarations. → { valid, errors: [{ path, message }] }. The messages are plain words the editor
 * can show after "Can't do that: ".
 */
function validate(element) {
    const errors = [];
    const bad = (path, message) => { errors.push({ path, message }); };
    if (!isObject(element)) return { valid: false, errors: [{ path: '', message: 'An element is an object.' }] };
    if (element.id !== undefined && !ID_RE.element.test(String(element.id))) bad('/id', 'The element id is not an el_ id.');
    if (!isText(element.name, 80)) bad('/name', 'An element needs a name of 80 characters at most.');
    if (element.description !== undefined && !isText(element.description, 500)) bad('/description', 'The description is 500 characters at most.');
    if (!isObject(element.author) || !isText(element.author.name, 80)) bad('/author', 'An element needs an author name.');
    if (!['private', 'link', 'gallery'].includes(element.sharing)) bad('/sharing', 'Sharing is private, link or gallery.');

    const look = element.look;
    if (!isObject(look)) bad('/look', 'An element needs a look.');
    else {
        if (!ID_RE.component.test(String(look.component))) bad('/look/component', 'The look names a design component.');
        if (!isText(look.label, 40)) bad('/look/label', 'The label is 1–40 characters.');
        if (look.icon !== undefined && !ID_RE.icon.test(String(look.icon))) bad('/look/icon', 'The icon names a glyph.');
        if (look.props !== undefined) {
            if (!isObject(look.props) || Object.keys(look.props).length > 20) bad('/look/props', 'Props are an object of at most 20 values.');
            else for (const [k, v] of Object.entries(look.props)) {
                if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(k)) bad(`/look/props/${k}`, 'A prop name starts lower-case.');
                if (!isValidValue(v) || Array.isArray(v)) bad(`/look/props/${k}`, 'A prop is a number, a string (200 characters) or a boolean.');
            }
        }
        const style = look.style;
        if (style !== undefined) {
            if (!isObject(style)) bad('/look/style', 'The style is an object.');
            else {
                if (style.tint !== undefined && !ID_RE.token.test(String(style.tint))) bad('/look/style/tint', 'The tint is a theme token.');
                if (style.shape !== undefined && !['round', 'pill', 'square'].includes(style.shape)) bad('/look/style/shape', 'The shape is round, pill or square.');
                if (style.opacity !== undefined && !isNum(style.opacity, 0.4, 1)) bad('/look/style/opacity', 'The opacity is 0.4–1.');
                if (style.show_label !== undefined && typeof style.show_label !== 'boolean') bad('/look/style/show_label', 'show_label is a boolean.');
            }
        }
    }

    const recipe = element.recipe;
    if (!isObject(recipe)) bad('/recipe', 'An element needs a recipe.');
    else {
        if (!Array.isArray(recipe.triggers) || recipe.triggers.length < 1 || recipe.triggers.length > 8) bad('/recipe/triggers', 'A recipe has 1–8 triggers.');
        else recipe.triggers.forEach((t, i) => {
            if (!isObject(t)) return bad(`/recipe/triggers/${i}`, 'A trigger is an object.');
            if (!TRIGGER_SET.has(t.kind)) return bad(`/recipe/triggers/${i}/kind`, `"${t.kind}" is not a trigger.`);
            const r = TRIGGERS[t.kind](t);
            if (r !== true) bad(`/recipe/triggers/${i}`, r);
        });
        if (recipe.conditions !== undefined) {
            const c = recipe.conditions;
            if (!isObject(c)) bad('/recipe/conditions', 'Conditions are an object.');
            else {
                if (c.role !== undefined && !ROLES.includes(c.role)) bad('/recipe/conditions/role', 'The role is everyone, follower, subscriber, vip, operator or owner.');
                if (c.cost !== undefined && (!isObject(c.cost) || !isInt(c.cost.points, 1, 1000000))) bad('/recipe/conditions/cost', 'A cost is channel points, 1–1000000.');
                if (c.cooldown !== undefined) {
                    if (!isObject(c.cooldown)) bad('/recipe/conditions/cooldown', 'Cooldowns are an object.');
                    else {
                        if (c.cooldown.per_person_seconds !== undefined && !isInt(c.cooldown.per_person_seconds, 0, 86400)) bad('/recipe/conditions/cooldown', 'The per-person cooldown is 0–86400 seconds.');
                        if (c.cooldown.overall_seconds !== undefined && !isInt(c.cooldown.overall_seconds, 0, 86400)) bad('/recipe/conditions/cooldown', 'The overall cooldown is 0–86400 seconds.');
                    }
                }
                if (c.daily_cap !== undefined) {
                    if (!isObject(c.daily_cap)) bad('/recipe/conditions/daily_cap', 'A daily cap is an object.');
                    else {
                        if (c.daily_cap.per_person !== undefined && !isInt(c.daily_cap.per_person, 1, 10000)) bad('/recipe/conditions/daily_cap', 'The per-person daily cap is 1–10000.');
                        if (c.daily_cap.overall !== undefined && !isInt(c.daily_cap.overall, 1, 1000000)) bad('/recipe/conditions/daily_cap', 'The overall daily cap is 1–1000000.');
                    }
                }
                if (c.live_only !== undefined && typeof c.live_only !== 'boolean') bad('/recipe/conditions/live_only', 'live_only is a boolean.');
                if (c.robot_turn_only !== undefined && typeof c.robot_turn_only !== 'boolean') bad('/recipe/conditions/robot_turn_only', 'robot_turn_only is a boolean.');
                if (c.chance !== undefined && (!isObject(c.chance) || !isInt(c.chance.one_in, 1, 1000000))) bad('/recipe/conditions/chance', 'A chance is one_in, 1–1000000.');
            }
        }
        if (!Array.isArray(recipe.actions) || recipe.actions.length < 1 || recipe.actions.length > 16) bad('/recipe/actions', 'A recipe has 1–16 actions.');
        else recipe.actions.forEach((a, i) => {
            if (!isObject(a)) return bad(`/recipe/actions/${i}`, 'An action is an object.');
            if (!ACTION_SET.has(a.kind)) return bad(`/recipe/actions/${i}/kind`, `"${a.kind}" is not an action.`);
            if (a.product !== PRODUCTS[a.kind]) return bad(`/recipe/actions/${i}/product`, `${a.kind} is authorised by ${PRODUCTS[a.kind]} only.`);
            const r = ACTIONS[a.kind](a);
            if (r !== true) bad(`/recipe/actions/${i}`, r);
        });
    }

    if (!Array.isArray(element.capabilities) || element.capabilities.length < 1 || element.capabilities.length > 32) bad('/capabilities', 'An element declares 1–32 capabilities.');
    else {
        if (new Set(element.capabilities).size !== element.capabilities.length) bad('/capabilities', 'A capability is declared once.');
        for (const c of element.capabilities) if (!ACTION_SET.has(c)) bad('/capabilities', `"${c}" is not an action an element can declare.`);
        if (isObject(recipe) && Array.isArray(recipe.actions)) {
            const declared = new Set(element.capabilities);
            for (const a of recipe.actions) if (isObject(a) && ACTION_SET.has(a.kind) && !declared.has(a.kind)) bad('/recipe/actions', `The recipe uses ${a.kind}, which the element did not declare.`);
        }
    }

    if (element.initial_state !== undefined) {
        if (!isObject(element.initial_state)) bad('/initial_state', 'The initial state is an object.');
        else {
            if (Object.keys(element.initial_state).length > 32) bad('/initial_state', 'The state holds at most 32 keys.');
            for (const [k, v] of Object.entries(element.initial_state)) {
                if (!ID_RE.key.test(k)) bad(`/initial_state/${k}`, 'A state key is lower-case and 32 characters at most.');
                if (!isValidValue(v)) bad(`/initial_state/${k}`, 'A state value is a boolean, a number, a short string or a list of those.');
            }
        }
    }

    if (element.mod !== undefined) {
        const m = element.mod;
        if (!isObject(m)) bad('/mod', 'The mod reference is an object.');
        else {
            if (!ID_RE.mod.test(String(m.id))) bad('/mod/id', 'The mod id is a mod_ id.');
            if (!ID_RE.semver.test(String(m.version))) bad('/mod/version', 'The mod version is semver.');
            if (!ID_RE.hex64.test(String(m.sha256))) bad('/mod/sha256', 'The mod digest is a sha256 hex string.');
            if (m.capabilities !== undefined) {
                if (!Array.isArray(m.capabilities) || m.capabilities.length > 32) bad('/mod/capabilities', 'The mod capabilities are an array of at most 32.');
                else {
                    const declared = new Set(Array.isArray(element.capabilities) ? element.capabilities : []);
                    for (const c of m.capabilities) {
                        if (!ACTION_SET.has(c)) bad('/mod/capabilities', `"${c}" is not a capability.`);
                        else if (!declared.has(c)) bad('/mod/capabilities', `The mod asks for ${c}, which the element did not declare.`);
                    }
                }
            }
        }
    }
    return { valid: errors.length === 0, errors };
}

// ── run ───────────────────────────────────────────────────────────────────
function refuse(code, message, extra = {}) {
    return { ok: false, code, message, ...extra };
}

/** Whether the fired trigger is one the recipe listens for. chat_command compares its command. */
function triggerMatches(recipe, trigger) {
    if (!isObject(trigger) || !TRIGGER_SET.has(trigger.kind)) return false;
    return (recipe.triggers || []).some((t) => {
        if (!isObject(t) || t.kind !== trigger.kind) return false;
        if (t.kind === 'chat_command') return String(t.command) === String(trigger.command);
        if (t.kind === 'chat_text') return Array.isArray(t.words) && (!Array.isArray(trigger.words) || trigger.words.some((w) => t.words.includes(w)));
        if (t.kind === 'element_event') return String(t.element_id) === String(trigger.element_id);
        if (t.kind === 'viewer_count') return t.op === trigger.op && t.count === trigger.count;
        if (t.kind === 'robot_event') return t.event === trigger.event;
        return true;
    });
}

/**
 * Run one fired trigger of one element in the host.
 *
 * Returns { ok: true, actions: [{action, result}], pointsSpent } or
 * { ok: false, code, message, retryAfterMs?, refusedAction?, refunded? }. Codes are:
 * invalid, trigger, capability, role, not_live, robot_turn, chance, cooldown, daily_cap, points,
 * limits, action. It never charges money: ctx.spend is the channel-points owner.
 */
async function run(recipe, trigger, ctx = {}) {
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const element = isObject(ctx.element) ? ctx.element : {};
    const actor = isObject(ctx.actor) ? ctx.actor : {};
    const elementId = element.id || '';
    const actorId = actor.subject || actor.name || '';

    if (!isObject(recipe) || !Array.isArray(recipe.actions) || recipe.actions.length < 1) return refuse('invalid', 'This element has nothing to do.');
    if (!triggerMatches(recipe, trigger)) return refuse('trigger', 'This element does not listen for that.');

    const declared = new Set(Array.isArray(element.capabilities) ? element.capabilities : []);
    if (!declared.size) return refuse('capability', 'This element has no declared capabilities.');
    for (const action of recipe.actions) {
        if (!isObject(action) || !ACTION_SET.has(action.kind)) return refuse('invalid', 'This element has an action I do not know.');
        if (!declared.has(action.kind)) return refuse('capability', `This element did not declare ${action.kind}.`, { refusedAction: action.kind });
        if (action.product !== PRODUCTS[action.kind]) return refuse('capability', `${action.kind} is authorised by ${PRODUCTS[action.kind]} only.`, { refusedAction: action.kind });
        const bad = ACTIONS[action.kind](action);
        if (bad !== true) return refuse('invalid', `The ${action.kind} action is not complete: ${bad}.`);
    }

    const conditions = isObject(recipe.conditions) ? recipe.conditions : {};
    const role = conditions.role || 'everyone';
    const actorRole = ROLES.includes(actor.role) ? actor.role : 'everyone';
    if ((ROLE_RANK[actorRole] || 0) < (ROLE_RANK[role] || 0)) {
        return refuse('role', role === 'owner' ? 'Only the channel owner can use this.' : `Only ${role}s can use this.`);
    }
    if (conditions.live_only && ctx.isLive !== true) return refuse('not_live', 'This element works only while the channel is live.');
    if (recipe.actions.some((a) => ROBOT_SET.has(a.kind))) {
        if (ctx.robotInTurn === false) return refuse('robot_turn', 'It is not this person\'s turn with the robot.');
        if (conditions.robot_turn_only && ctx.robotInTurn !== true) return refuse('robot_turn', 'This element works only during the presser\'s robot turn.');
    }
    if (conditions.chance && conditions.chance.one_in > 1) {
        const random = typeof ctx.random === 'function' ? ctx.random : Math.random;
        if (Math.floor(random() * conditions.chance.one_in) !== 0) return refuse('chance', 'The odds did not come up this time.');
    }

    const lim = isObject(ctx.limits) ? ctx.limits : null;
    const cooldown = conditions.cooldown || {};
    if (lim && typeof lim.cooldown === 'function') {
        for (const scope of ['person', 'overall']) {
            const seconds = scope === 'person' ? cooldown.per_person_seconds : cooldown.overall_seconds;
            if (!seconds) continue;
            const left = Number(await lim.cooldown({ scope, elementId, actorId, at: now })) || 0;
            if (left > 0) return refuse('cooldown', `This is on cooldown; try again in ${Math.ceil(left / 1000)} seconds.`, { retryAfterMs: left, scope });
        }
    }
    const cap = conditions.daily_cap || {};
    if (lim && typeof lim.dailyCount === 'function') {
        for (const scope of ['person', 'overall']) {
            const max = scope === 'person' ? cap.per_person : cap.overall;
            if (!max) continue;
            const used = Number(await lim.dailyCount({ scope, elementId, actorId, day })) || 0;
            if (used >= max) return refuse('daily_cap', 'The daily limit for this element has been reached.', { scope });
        }
    }

    const points = isObject(conditions.cost) ? conditions.cost.points : 0;
    let charged = false;
    if (points) {
        if (typeof ctx.spend !== 'function') return refuse('points', `This press costs ${points} channel points, which I cannot check here.`);
        let paid;
        try { paid = await ctx.spend({ points, elementId, actorId, subject: actor.subject || null, at: now }); }
        catch (e) { return refuse('points', (e && e.message) || 'The channel points could not be checked.'); }
        if (!paid || paid.ok !== true) return refuse('points', (paid && (paid.message || paid.reason)) || `Not enough channel points for this (it needs ${points}).`);
        charged = true;
    }
    if (lim && typeof lim.hit === 'function') {
        try { await lim.hit({ elementId, actorId, at: now, day }); }
        catch (e) {
            if (charged && typeof ctx.refund === 'function') { try { await ctx.refund({ points, elementId, actorId, subject: actor.subject || null, at: now }); } catch { /* the owner's ledger decides */ } }
            return refuse('limits', 'The element\'s limits could not be recorded, so nothing ran.');
        }
    }

    const done = [];
    for (const action of recipe.actions) {
        let result;
        try { result = await ctx.send(action, { element, actor, trigger, product: PRODUCTS[action.kind] }); }
        catch (e) { result = { ok: false, message: (e && e.message) || 'The product did not answer.' }; }
        if (!result || result.ok !== true) {
            let refunded = false;
            if (charged && typeof ctx.refund === 'function') {
                try { await ctx.refund({ points, elementId, actorId, subject: actor.subject || null, at: now }); refunded = true; } catch { /* the ledger decides */ }
            }
            const why = (result && (result.message || result.reason)) || 'refused';
            return refuse('action', `${PRODUCTS[action.kind]} refused ${action.kind}: ${why}`, { refusedAction: action.kind, actions: done, refunded, pointsSpent: refunded ? 0 : points });
        }
        done.push({ action, result: result.result === undefined ? null : result.result });
    }
    return { ok: true, actions: done, pointsSpent: points };
}

// ── reduce: the element's own store ───────────────────────────────────────
/**
 * Apply the state actions among `actions` to an element's store. Returns
 * { values, revision, changed, errors }: revision grows by one when anything changed, and an
 * invalid change is reported without touching the store. Only screen.counter and screen.state
 * touch state; every other action is the product's business.
 */
function reduce(state, actions, { maxKeys = 32 } = {}) {
    const base = isObject(state) ? state : {};
    const values = isObject(base.values) ? { ...base.values } : {};
    let revision = isInt(base.revision, 0) ? base.revision : 0;
    let changed = false;
    const errors = [];
    for (const action of Array.isArray(actions) ? actions : []) {
        if (!isObject(action)) continue;
        if (action.kind !== 'screen.counter' && action.kind !== 'screen.state') continue;
        if (!ID_RE.key.test(String(action.key))) { errors.push({ path: `/values/${action.key}`, message: 'A state key is lower-case and 32 characters at most.' }); continue; }
        if (action.kind === 'screen.counter') {
            if (!isInt(action.by, -1000, 1000)) { errors.push({ path: `/values/${action.key}`, message: 'A counter moves by a whole number from -1000 to 1000.' }); continue; }
            const prev = values[action.key] === undefined ? 0 : values[action.key];
            if (typeof prev !== 'number' || !Number.isFinite(prev)) { errors.push({ path: `/values/${action.key}`, message: 'That counter is not a number.' }); continue; }
            if (!(action.key in values) && Object.keys(values).length >= maxKeys) { errors.push({ path: `/values/${action.key}`, message: `The state holds at most ${maxKeys} keys.` }); continue; }
            const next = prev + action.by;
            if (!Number.isFinite(next)) { errors.push({ path: `/values/${action.key}`, message: 'That counter cannot go further.' }); continue; }
            if (next !== prev) { values[action.key] = next; changed = true; }
        } else {
            if (!isValidValue(action.value)) { errors.push({ path: `/values/${action.key}`, message: 'A state value is a boolean, a number, a short string or a list of those.' }); continue; }
            if (!(action.key in values) && Object.keys(values).length >= maxKeys) { errors.push({ path: `/values/${action.key}`, message: `The state holds at most ${maxKeys} keys.` }); continue; }
            if (JSON.stringify(values[action.key]) !== JSON.stringify(action.value)) { values[action.key] = action.value; changed = true; }
        }
    }
    if (changed) revision += 1;
    return { values, revision, changed, errors };
}

module.exports = {
    validate, run, reduce,
    isValidValue,
    PRODUCTS, ACTION_KINDS, ACTION_SET, TRIGGER_KINDS, TRIGGER_SET, ROBOT_ACTIONS, ROLES, ROLE_RANK,
};
