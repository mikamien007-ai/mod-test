/**
 * DestinyPoetry - Private Profile automation
 * Runtime owner: Tavern Helper / SillyTavern.
 * Writer scope: RelationshipList.*.PrivateProfile and Date.PhysioTick.
 */

const PRIVATE_HISTORY_LIMIT = 10;
const SPERM_VIABILITY_DAYS = 5;
const OVULATION_HISTORY_LIMIT = 12;
const MAX_OVULATION_EGGS = 8;
const CHANCE_BY_OVULATION_OFFSET = Object.freeze({ '-5': 5, '-4': 10, '-3': 15, '-2': 25, '-1': 30, 0: 20, 1: 5 });
const CYCLE_STATES = new Set(['Active', 'SuspendedPregnancy', 'PostpartumAmenorrhea']);
const DEFAULT_REPRODUCTIVE_CONFIG = Object.freeze({
    cycleLengthDays: 28,
    gestationDays: 280,
    pubertyAge: 14,
    postpartumRecoveryDays: 42,
    ovulationEggWeights: Object.freeze({ 1: 99, 2: 1 }),
});
const PRIVATE_RUNTIME_KEY = '__DestinyPoetryPrivateAutomation';
const INTERNAL_EJACULATION_EVENT_TYPE = 'InternalEjaculation';
const INTERNAL_EJACULATION_POSITION = 'Xuất tinh bên trong âm đạo';
const PROTECTION_STATES = new Set(['None', 'Failed', 'Effective', 'Unknown']);
const statRoot = value => value?.stat_data && typeof value.stat_data === 'object' ? value.stat_data : value;
const pad2 = value => String(value).padStart(2, '0');
const pad6 = value => String(value).padStart(6, '0');

const parseDay = value => {
    const source = String(value || '').trim();
    if (!source) return null;
    let year, month, day;
    // World.Time in this card is emitted in both forms:
    // "... Năm 488-Tháng ..." and "... 488-Tháng ...".
    const canonical = /(?:Năm\s*)?(\d{3,6})\s*-\s*Tháng\s*(\d+)\s*-\s*Ngày\s*(\d+)/i.exec(source);
    const vietnamese = /Ngày\s*(\d+)\s*tháng\s*(\d+)\s*năm\s*(\d+)/i.exec(source);
    const iso = /(?:^|\D)(\d{3,6})-(\d{1,2})-(\d{1,2})(?:\D|$)/.exec(source);
    if (canonical) [, year, month, day] = canonical;
    else if (vietnamese) [, day, month, year] = vietnamese;
    else if (iso) [, year, month, day] = iso;
    else return null;
    const y = Number(year), m = Number(month), d = Number(day);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
    return Date.UTC(y, m - 1, d) / 864e5;
};

const formatDay = epochDay => {
    const date = new Date(epochDay * 864e5);
    return `Năm ${date.getUTCFullYear()}-Tháng ${pad2(date.getUTCMonth() + 1)}-Ngày ${pad2(date.getUTCDate())}`;
};

const raceDefaults = race => {
    const source = String(race || '').toLowerCase();
    const rows = [
        ['hồ ly', 30, 280, 14], ['tinh linh', 35, 300, 18], ['long', 42, 540, 20],
        ['thú nhân', 26, 200, 10], ['thiên sứ', 28, 300, 14], ['dực', 28, 300, 14],
        ['nữ thần', 28, 365, 16], ['thần', 28, 365, 16], ['người', 28, 280, 12],
        ['nhân tộc', 28, 280, 12],
    ];
    const row = rows.find(candidate => source.includes(candidate[0]));
    return {
        ...DEFAULT_REPRODUCTIVE_CONFIG,
        cycleLengthDays: row?.[1] || DEFAULT_REPRODUCTIVE_CONFIG.cycleLengthDays,
        gestationDays: row?.[2] || DEFAULT_REPRODUCTIVE_CONFIG.gestationDays,
        pubertyAge: row?.[3] || DEFAULT_REPRODUCTIVE_CONFIG.pubertyAge,
    };
};

const chooseWeightedEggCount = weights => {
    const entries = Object.entries(weights || {})
        .map(([count, weight]) => [_.clamp(Math.round(Number(count) || 1), 1, MAX_OVULATION_EGGS), Math.max(0, Math.round(Number(weight) || 0))])
        .filter(([, weight]) => weight > 0);
    if (!entries.length) return 1;
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    const roll = _.random(1, total);
    let cursor = 0;
    for (const [count, weight] of entries) {
        cursor += weight;
        if (roll <= cursor) return count;
    }
    return 1;
};

const ovulationRecordKey = ovulationDay => `ovulation-${ovulationDay}`;

const getCycleSnapshot = (lastStartDay, cycleLength, worldDay) => {
    const elapsed = Math.max(0, worldDay - lastStartDay);
    const shiftedCycles = Math.floor(elapsed / cycleLength);
    const cycleStartDay = lastStartDay + shiftedCycles * cycleLength;
    const cycleDay = worldDay - cycleStartDay + 1;
    const ovulationCycleDay = _.clamp(Math.round(cycleLength / 2), 1, cycleLength);
    const menstrualEndDay = _.clamp(Math.round(cycleLength * 0.15), 1, cycleLength);
    const phase = cycleDay <= menstrualEndDay ? 'Kinh nguyệt'
        : cycleDay < ovulationCycleDay ? 'Nang trứng'
            : cycleDay === ovulationCycleDay ? 'Rụng trứng' : 'Hoàng thể';
    return {
        cycleStartDay, cycleDay, ovulationCycleDay,
        ovulationDay: cycleStartDay + ovulationCycleDay - 1,
        phase,
        progressPercent: _.clamp(Math.round(cycleDay / cycleLength * 100), 1, 100),
        expectedEndDay: cycleStartDay + cycleLength,
    };
};

const getNextOvulationDay = (lastStartDay, cycleLength, referenceDay) => {
    const ovulationOffset = _.clamp(Math.round(cycleLength / 2), 1, cycleLength) - 1;
    const cycleIndex = Math.floor((referenceDay - lastStartDay) / cycleLength);
    let result = lastStartDay + cycleIndex * cycleLength + ovulationOffset;
    // The released egg remains fertilizable through the following day. Only
    // events later than that belong to the next cycle's ovulation window.
    if (referenceDay > result + 1) result += cycleLength;
    return result;
};

const getConceptionChance = (occurredDay, ovulationDay, modifier) => {
    const base = CHANCE_BY_OVULATION_OFFSET[occurredDay - ovulationDay];
    return Number.isFinite(base) ? _.clamp(Math.round(base * modifier / 100), 0, 95) : 0;
};

const isPendingCheck = check => (check?.Status || 'Pending') === 'Pending'
    && (check?.Result || 'Pending') === 'Pending'
    && (Number(check?.DiceRoll) || 0) === 0;

const privateProfileSections = new Set([
    'OutfitDetails', 'Body', 'Physiology', 'ReproductiveStatus', 'SexualHistory', 'EventFacts', 'Children', 'SecretNotes',
]);
const decodePointerSegment = value => String(value).replace(/~1/g, '/').replace(/~0/g, '~');
const encodePointerSegment = value => String(value).replace(/~/g, '~0').replace(/\//g, '~1');
const pointerSegments = path => String(path || '').split('/').slice(1).map(decodePointerSegment);
const pointerPath = segments => `/${segments.map(encodePointerSegment).join('/')}`;
const pathShape = path => String(path || '').startsWith('/') ? 'pointer' : 'dot';
const pathSegments = path => pathShape(path) === 'pointer'
    ? pointerSegments(path)
    : _.toPath(String(path || '')).map(String);
const dotPath = segments => segments.map((segment, index) => {
    if (/^[^.\[\]]+$/.test(segment)) return `${index ? '.' : ''}${segment}`;
    return `[${JSON.stringify(segment)}]`;
}).join('');
const formatPath = (segments, shape) => shape === 'pointer' ? pointerPath(segments) : dotPath(segments);
const decodeCommandKey = value => {
    if (typeof value !== 'string') return String(value);
    const text = value.trim();
    if (text.startsWith('"')) {
        try { return String(JSON.parse(text)); } catch { return value; }
    }
    if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
    return value;
};
const normalizePrivateSegments = segments => {
    if (segments[0] !== 'RelationshipList' || segments[2] === 'PrivateProfile' || !privateProfileSections.has(segments[2])) {
        return { changed: false, segments };
    }
    return { changed: true, segments: [...segments.slice(0, 2), 'PrivateProfile', ...segments.slice(2)] };
};
const normalizeCommandOperation = operation => ({ set: 'replace', add: 'insert', delete: 'remove' })[operation] || operation;
const pointerValue = (root, path) => pointerSegments(path).reduce((value, key) => value?.[key], root);
const setPointerValue = (root, path, value) => {
    const segments = pointerSegments(path);
    if (!segments.length || segments.includes('-')) return false;
    let cursor = root;
    for (const key of segments.slice(0, -1)) {
        if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
        cursor = cursor[key];
    }
    cursor[segments.at(-1)] = value;
    return true;
};
const commandParts = command => {
    const operationKey = Object.prototype.hasOwnProperty.call(command || {}, 'op') ? 'op'
        : Object.prototype.hasOwnProperty.call(command || {}, 'type') ? 'type' : null;
    if (!operationKey) return null;
    const rawOperation = String(command[operationKey]).toLowerCase();
    const operation = normalizeCommandOperation(rawOperation);
    if (typeof command?.path === 'string') {
        const segments = pathSegments(command.path);
        return {
            operationKey, shape: 'patch', operation, segments, path: pointerPath(segments), value: command.value,
            writePath(nextSegments) { command.path = formatPath(nextSegments, pathShape(command.path)); },
            writeValue(value) { command.value = value; },
        };
    }
    if (!Array.isArray(command?.args) || typeof command.args[0] !== 'string') return null;
    const splitInsert = operation === 'insert' && command.args.length >= 3;
    const originalPathShape = pathShape(command.args[0]);
    const parentSegments = pathSegments(command.args[0]);
    const segments = splitInsert ? [...parentSegments, decodeCommandKey(command.args[1])] : parentSegments;
    return {
        operationKey, shape: splitInsert ? 'args-insert' : 'args', operation, segments,
        path: pointerPath(segments), value: command.args[splitInsert ? 2 : 1],
        writePath(nextSegments) {
            command.args[0] = formatPath(splitInsert ? nextSegments.slice(0, -1) : nextSegments, originalPathShape);
        },
        writeValue(value) { command.args[splitInsert ? 2 : 1] = value; },
    };
};
const setCommandValue = (parts, value) => {
    parts.writeValue(value);
};
const replaceWithPatchCommand = (command, operation, path, value) => {
    const reason = command.reason;
    for (const key of Object.keys(command)) delete command[key];
    Object.assign(command, { op: operation, path, value });
    if (reason !== undefined) command.reason = reason;
};
const previewCommands = (root, commands, excludedCommand = null) => {
    for (const command of commands) {
        if (command === excludedCommand) continue;
        const parts = commandParts(command);
        if (!parts || parts.path.includes('/ConceptionChecks/')) continue;
        if (parts.operation === 'insert' || parts.operation === 'replace') {
            setPointerValue(root, parts.path, _.cloneDeep(parts.value));
        } else if (parts.operation === 'delta') {
            const current = Number(pointerValue(root, parts.path));
            const delta = Number(parts.value);
            if (Number.isFinite(current) && Number.isFinite(delta)) setPointerValue(root, parts.path, current + delta);
        }
    }
};
const upsertAuthoritativeCommand = (root, commands, path, value) => {
    const existing = commands.find(command => commandParts(command)?.path === path);
    const operation = pointerValue(root, path) === undefined ? 'insert' : 'replace';
    if (existing) {
        replaceWithPatchCommand(existing, operation, path, value);
    } else commands.push({ op: operation, path, value });
    setPointerValue(root, path, _.cloneDeep(value));
};
const hasCommandPath = (commands, path) => commands.some(command => commandParts(command)?.path === path);
const startsWithSegments = (segments, prefix) => prefix.every((segment, index) => segments[index] === segment);
const managedPrivateTargets = characterKey => [
    ['RelationshipList', characterKey, 'PrivateProfile', 'ReproductiveStatus', 'ConceptionChecks'],
    ['RelationshipList', characterKey, 'PrivateProfile', 'ReproductiveStatus', 'OvulationRecords'],
    ['RelationshipList', characterKey, 'PrivateProfile', 'Physiology', 'CycleState'],
    ['RelationshipList', characterKey, 'PrivateProfile', 'Physiology', 'PostpartumStartTime'],
    ['RelationshipList', characterKey, 'PrivateProfile', 'Physiology', 'CycleResumeTime'],
    ['RelationshipList', characterKey, 'PrivateProfile', 'SexualHistory', 'Positions', INTERNAL_EJACULATION_POSITION],
];
const stripManagedPrivateValues = (parts, normalizedSegments) => {
    if (!['insert', 'replace'].includes(parts.operation) || !parts.value || typeof parts.value !== 'object' || Array.isArray(parts.value)) return false;
    if (normalizedSegments[0] !== 'RelationshipList') return false;
    let nextValue = parts.value;
    let changed = false;
    const characterKeys = normalizedSegments.length >= 2 ? [normalizedSegments[1]] : Object.keys(nextValue);
    for (const characterKey of characterKeys) {
        for (const target of managedPrivateTargets(characterKey)) {
            if (!startsWithSegments(target, normalizedSegments) || target.length === normalizedSegments.length) continue;
            const relative = target.slice(normalizedSegments.length);
            if (!_.has(nextValue, relative)) continue;
            if (!changed) nextValue = _.cloneDeep(nextValue);
            _.unset(nextValue, relative);
            changed = true;
        }
    }
    if (changed) setCommandValue(parts, nextValue);
    return changed;
};
const cycleDayFromProgress = (progressPercent, cycleLength) => {
    const progress = Number(progressPercent);
    if (!(cycleLength > 0) || !(progress > 0)) return 0;
    return _.clamp(Math.round(progress * cycleLength / 100), 1, cycleLength);
};
const repairCycleAnchor = (root, commands, characterKey, { requireExplicitClaim }) => {
    const character = root.RelationshipList?.[characterKey];
    const P = character?.PrivateProfile?.Physiology;
    if (!P) return false;
    if (character?.PrivateProfile?.ReproductiveStatus?.IsPregnant || (P.CycleState && P.CycleState !== 'Active')) return false;
    const prefix = `/RelationshipList/${characterKey}/PrivateProfile/Physiology`;
    if (hasCommandPath(commands, `${prefix}/LastStartTime`)) return false;
    if (requireExplicitClaim && !(
        hasCommandPath(commands, `${prefix}/CurrentPhase`)
        && hasCommandPath(commands, `${prefix}/CycleProgressPercent`)
    )) return false;
    const worldDay = parseDay(root.World?.Time);
    const cycleLength = Math.round(Number(P.CycleLengthDays));
    const claimedCycleDay = cycleDayFromProgress(P.CycleProgressPercent, cycleLength);
    if (worldDay === null || !(cycleLength > 0) || !claimedCycleDay || !P.CurrentPhase) return false;
    const claimedStartDay = worldDay - claimedCycleDay + 1;
    const claimedSnapshot = getCycleSnapshot(claimedStartDay, cycleLength, worldDay);
    if (claimedSnapshot.phase !== P.CurrentPhase || claimedSnapshot.cycleDay !== claimedCycleDay) return false;
    const storedStartDay = parseDay(P.LastStartTime);
    if (storedStartDay !== null) {
        const storedSnapshot = getCycleSnapshot(storedStartDay, cycleLength, worldDay);
        if (storedSnapshot.phase === P.CurrentPhase && storedSnapshot.cycleDay === claimedCycleDay) return false;
    }
    upsertAuthoritativeCommand(root, commands, `${prefix}/LastStartTime`, formatDay(claimedStartDay));
    upsertAuthoritativeCommand(root, commands, `${prefix}/ExpectedEndTime`, formatDay(claimedSnapshot.expectedEndDay));
    console.warn(`[DestinyPoetry] Đã sửa mốc chu kỳ của ${characterKey} từ pha/tiến độ nhất quán: ${formatDay(claimedStartDay)}.`);
    return true;
};
const synchronizeCycleCommands = (variables, commands) => {
    if (!Array.isArray(commands)) return;
    const root = _.cloneDeep(statRoot(variables) || {});
    const characterKeys = Object.keys(root.RelationshipList || {});
    for (const characterKey of characterKeys) repairCycleAnchor(root, commands, characterKey, { requireExplicitClaim: false });
    previewCommands(root, commands);
    for (const characterKey of characterKeys) repairCycleAnchor(root, commands, characterKey, { requireExplicitClaim: true });
    const outcome = buildPrivateUpdate(root, { resolveConception: false });
    _.forEach(outcome.payload?.RelationshipList || {}, (characterPatch, characterKey) => {
        const profilePatch = characterPatch?.PrivateProfile || {};
        const authoritativeFields = [
            ['Physiology', 'CycleLengthDays'],
            ['Physiology', 'CycleState'],
            ['Physiology', 'LastStartTime'],
            ['Physiology', 'ExpectedEndTime'],
            ['Physiology', 'CurrentPhase'],
            ['Physiology', 'CycleProgressPercent'],
            ['Physiology', 'PostpartumStartTime'],
            ['Physiology', 'CycleResumeTime'],
            ['ReproductiveStatus', 'GestationDays'],
            ['ReproductiveStatus', 'Fertility'],
            ['ReproductiveStatus', 'OvulationStatus'],
            ['ReproductiveStatus', 'FertilizableEggCount'],
            ['ReproductiveStatus', 'OvulationRecords'],
            ['ReproductiveStatus', 'PregnancyProgressPercent'],
            ['ReproductiveStatus', 'CurrentFetusCount'],
        ];
        for (const [section, field] of authoritativeFields) {
            if (!Object.prototype.hasOwnProperty.call(profilePatch?.[section] || {}, field)) continue;
            const path = `/RelationshipList/${characterKey}/PrivateProfile/${section}/${field}`;
            upsertAuthoritativeCommand(root, commands, path, profilePatch[section][field]);
        }
    });
};
const normalizePrivateProfileCommands = (variables, commands) => {
    if (!Array.isArray(commands)) return;
    const root = statRoot(variables) || {};
    for (let index = commands.length - 1; index >= 0; index -= 1) {
        const command = commands[index];
        if (!command || typeof command !== 'object') continue;
        const parts = commandParts(command);
        if (!parts) {
            const serialized = JSON.stringify(command);
            if (serialized.includes('SexualHistory') || serialized.includes('ConceptionChecks') || serialized.includes('EventFacts')) {
                console.warn('[DestinyPoetry] Đã chặn command riêng tư có cấu trúc không nhận diện được.');
                commands.splice(index, 1);
            }
            continue;
        }
        const normalized = normalizePrivateSegments(parts.segments);
        if (normalized.changed) {
            parts.writePath(normalized.segments);
            console.warn(`[DestinyPoetry] Đã chuẩn hóa path riêng tư: ${pointerPath(normalized.segments)}.`);
        }
        const normalizedPath = pointerPath(normalized.segments);
        const managedTarget = normalized.segments[0] === 'RelationshipList' && normalized.segments.length >= 2
            ? managedPrivateTargets(normalized.segments[1]).some(target => startsWithSegments(normalized.segments, target))
            : false;
        if (managedTarget) {
            console.warn(`[DestinyPoetry] Đã chặn AI ghi vào trường do private automation quản lý: ${normalizedPath}.`);
            commands.splice(index, 1);
            continue;
        }
        if (stripManagedPrivateValues(parts, normalized.segments)) {
            console.warn(`[DestinyPoetry] Đã loại trường do private automation quản lý khỏi command cha: ${normalizedPath}.`);
        }
        const isSexualPosition = normalized.segments[0] === 'RelationshipList'
            && normalized.segments[2] === 'PrivateProfile'
            && normalized.segments[3] === 'SexualHistory'
            && normalized.segments[4] === 'Positions'
            && normalized.segments.length > 5;
        if (!isSexualPosition || parts.operation !== 'delta') continue;
        const current = pointerValue(root, normalizedPath);
        if (Number.isFinite(Number(current)) && current !== '') continue;
        if (current === undefined) {
            const parentPath = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
            const parent = pointerValue(root, parentPath);
            if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
                replaceWithPatchCommand(command, 'insert', normalizedPath, parts.value);
                console.warn(`[DestinyPoetry] Đã đổi delta thành insert cho Positions chưa tồn tại: ${normalizedPath}.`);
                continue;
            }
        }
        console.warn(`[DestinyPoetry] Đã chặn bộ đếm Positions không hợp lệ tại ${normalizedPath}: giá trị hiện tại không phải số.`);
        commands.splice(index, 1);
    }
};

const consumePrivateEventFacts = sourceData => {
    const root = statRoot(sourceData) || {};
    const worldDay = parseDay(root.World?.Time);
    const factsPresent = Object.values(root.RelationshipList || {}).some(character => {
        const facts = character?.PrivateProfile?.EventFacts;
        return facts && typeof facts === 'object' && !Array.isArray(facts) && Object.keys(facts).length > 0;
    });
    if (!factsPresent) return { consumed: 0, rejected: 0, reason: '' };
    if (worldDay === null) return { consumed: 0, rejected: 0, reason: 'InvalidWorldTime' };

    let consumed = 0;
    let rejected = 0;
    _.forEach(root.RelationshipList || {}, (character, characterKey) => {
        const profile = character?.PrivateProfile;
        const facts = profile?.EventFacts;
        if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return;
        profile.ReproductiveStatus ||= {};
        profile.ReproductiveStatus.ConceptionChecks ||= {};
        profile.SexualHistory ||= {};
        profile.SexualHistory.Positions ||= {};
        const checks = profile.ReproductiveStatus.ConceptionChecks;
        let sequence = Math.max(0, ...Object.values(checks).map(check => Number(check?.Sequence) || 0)) + 1;

        for (const [temporaryKey, sourceFact] of Object.entries(facts)) {
            const fact = sourceFact && typeof sourceFact === 'object' && !Array.isArray(sourceFact) ? sourceFact : null;
            const partnerCharacterKey = String(fact?.PartnerCharacterKey || '').trim();
            const protectionState = String(fact?.ProtectionState || 'Unknown');
            const valid = fact?.Type === INTERNAL_EJACULATION_EVENT_TYPE
                && partnerCharacterKey
                && PROTECTION_STATES.has(protectionState);
            delete facts[temporaryKey];
            if (!valid) {
                rejected += 1;
                console.warn(`[DestinyPoetry] Đã loại EventFacts không hợp lệ của ${characterKey}: ${temporaryKey}.`);
                continue;
            }
            let eventKey = `internal-${pad6(sequence)}`;
            while (Object.prototype.hasOwnProperty.call(checks, eventKey)) {
                sequence += 1;
                eventKey = `internal-${pad6(sequence)}`;
            }
            const currentCount = Math.max(0, Math.round(Number(profile.SexualHistory.Positions[INTERNAL_EJACULATION_POSITION]) || 0));
            profile.SexualHistory.Positions[INTERNAL_EJACULATION_POSITION] = currentCount + 1;
            checks[eventKey] = {
                Sequence: sequence,
                OccurredAt: formatDay(worldDay),
                PartnerCharacterKey: partnerCharacterKey,
                ProtectionState: protectionState,
                Status: 'Pending',
                Result: 'Pending',
            };
            sequence += 1;
            consumed += 1;
        }
        if (!Object.keys(facts).length) delete profile.EventFacts;
    });
    return { consumed, rejected, reason: '' };
};

const hasPrivateState = data => {
    const root = statRoot(data) || {};
    return Boolean(root.World?.Time && root.RelationshipList && typeof root.RelationshipList === 'object');
};

const buildPrivateUpdate = (sourceData, { resolveConception }) => {
    const root = statRoot(sourceData) || {};
    const worldTime = root.World?.Time || '';
    const worldDay = parseDay(worldTime);
    if (worldDay === null) return { payload: null, cleanupPaths: [], reason: 'InvalidWorldTime' };
    const relationshipPatch = {};
    const cleanupPaths = [];
    let dirty = false;

    _.forEach(root.RelationshipList || {}, (character, characterKey) => {
        const eligibility = character?.PrivateEligibility;
        if (!(eligibility && (eligibility.Gender === 'female' || eligibility.Gender === 'other'))) return;
        const profile = character.PrivateProfile || {};
        const P = { ...(profile.Physiology || {}) };
        const R = { ...(profile.ReproductiveStatus || {}) };
        const H = { ...(profile.SexualHistory || {}) };
        const characterPatch = { PrivateProfile: {} };
        const setSection = (section, current, key, value) => {
            if (_.isEqual(current[key], value)) return;
            current[key] = value;
            characterPatch.PrivateProfile[section] ||= {};
            characterPatch.PrivateProfile[section][key] = value;
            dirty = true;
        };
        const setP = (key, value) => setSection('Physiology', P, key, value);
        const setR = (key, value) => setSection('ReproductiveStatus', R, key, value);
        const setH = (key, value) => setSection('SexualHistory', H, key, value);

        const defaults = raceDefaults(character.Race);
        const sourceCycleLength = Number(P.CycleLengthDays) > 0 ? Math.round(Number(P.CycleLengthDays)) : 0;
        const sourceLastStartDay = parseDay(P.LastStartTime);
        const hasUsableCycleSource = sourceCycleLength > 0 && sourceLastStartDay !== null && sourceLastStartDay <= worldDay;
        const checks = { ...(R.ConceptionChecks || {}) };
        let ovulationRecords = { ...(R.OvulationRecords || {}) };
        let ovulationRecordsChanged = false;
        const ensureOvulationRecord = (cycleStartDay, ovulationDay) => {
            const key = ovulationRecordKey(ovulationDay);
            const existing = ovulationRecords[key];
            const existingEggCount = Math.round(Number(existing?.EggCount));
            if (existing && existingEggCount >= 1 && existingEggCount <= MAX_OVULATION_EGGS) {
                return { key, record: { ...existing, EggCount: existingEggCount } };
            }
            const record = {
                CycleStartTime: formatDay(cycleStartDay),
                OvulationTime: formatDay(ovulationDay),
                EggCount: chooseWeightedEggCount(defaults.ovulationEggWeights),
            };
            ovulationRecords[key] = record;
            ovulationRecordsChanged = true;
            return { key, record };
        };
        const pending = resolveConception
            ? _.sortBy(_.toPairs(checks).filter(([, check]) => isPendingCheck(check)), ([, check]) => Number(check?.Sequence) || Number.MAX_SAFE_INTEGER)
            : [];
        const cycleLength = sourceCycleLength || defaults.cycleLengthDays;
        const gestationDays = Number(R.GestationDays) > 0 ? Math.round(Number(R.GestationDays)) : defaults.gestationDays;
        const pubertyAge = defaults.pubertyAge;
        const age = Number(character.AgeYears) || 0;
        const prepubertal = sourceCycleLength === 0 && age > 0 && age < pubertyAge;
        const mayBootstrapCycle = !pending.length && age >= pubertyAge;
        let activeCycleLength = sourceCycleLength;
        let activeLastStartDay = sourceLastStartDay;
        let cycleState = CYCLE_STATES.has(P.CycleState) ? P.CycleState : (R.IsPregnant ? 'SuspendedPregnancy' : 'Active');
        let pregnancyActive = Boolean(R.IsPregnant);

        if (prepubertal) {
            if (P.CycleState && P.CycleState !== 'Active') setP('CycleState', 'Active');
            setR('Fertility', 'Chưa trưởng thành');
            setR('OvulationStatus', 'Chưa bắt đầu');
            setR('FertilizableEggCount', 0);
        } else {
            if (!(Number(R.GestationDays) > 0)) setR('GestationDays', gestationDays);
            let automaticPostpartumStartDay = null;
            if (pregnancyActive) {
                const fertilizationDay = parseDay(R.FertilizationTime);
                const dueDay = fertilizationDay !== null && fertilizationDay <= worldDay
                    ? fertilizationDay + gestationDays
                    : null;
                if (dueDay !== null && worldDay >= dueDay) {
                    pregnancyActive = false;
                    automaticPostpartumStartDay = dueDay;
                    setR('IsPregnant', false);
                    setR('PregnancyProgressPercent', 0);
                    setR('CurrentFetusCount', 0);
                    cycleState = 'PostpartumAmenorrhea';
                    setP('CycleState', cycleState);
                    setP('PostpartumStartTime', formatDay(dueDay));
                    setP('CycleResumeTime', formatDay(dueDay + defaults.postpartumRecoveryDays));
                }
            }
            if (pregnancyActive) {
                cycleState = 'SuspendedPregnancy';
                setP('CycleState', cycleState);
                setP('PostpartumStartTime', '');
                setP('CycleResumeTime', '');
                setP('CycleReturnConfirmedAt', '');
                setR('Fertility', 'Ngừng (mang thai)');
                setR('OvulationStatus', 'Không rụng trứng');
                setR('FertilizableEggCount', 0);
                const fertilizationDay = parseDay(R.FertilizationTime);
                if (fertilizationDay !== null && fertilizationDay <= worldDay) {
                    setR('PregnancyProgressPercent', Math.min(99, Math.round((worldDay - fertilizationDay) / gestationDays * 100)));
                }
            } else {
                if (cycleState === 'SuspendedPregnancy') {
                    cycleState = 'PostpartumAmenorrhea';
                    setP('CycleState', cycleState);
                    setP('PostpartumStartTime', formatDay(worldDay));
                    setP('CycleResumeTime', formatDay(worldDay + defaults.postpartumRecoveryDays));
                }
                if (cycleState === 'PostpartumAmenorrhea') {
                    setR('Fertility', 'Chưa trở lại sau thai kỳ');
                    setR('OvulationStatus', 'Chưa trở lại sau thai kỳ');
                    setR('FertilizableEggCount', 0);
                    setR('PregnancyProgressPercent', 0);
                    setR('CurrentFetusCount', 0);
                    const confirmedReturnDay = parseDay(P.CycleReturnConfirmedAt);
                    const scheduledResumeDay = automaticPostpartumStartDay !== null
                        ? automaticPostpartumStartDay + defaults.postpartumRecoveryDays
                        : parseDay(P.CycleResumeTime);
                    const resumeDay = confirmedReturnDay !== null && confirmedReturnDay <= worldDay
                        ? confirmedReturnDay
                        : scheduledResumeDay !== null && scheduledResumeDay <= worldDay ? scheduledResumeDay : null;
                    if (resumeDay !== null) {
                        cycleState = 'Active';
                        activeCycleLength = cycleLength;
                        activeLastStartDay = resumeDay;
                        setP('CycleState', cycleState);
                        setP('PostpartumStartTime', '');
                        setP('CycleResumeTime', '');
                        setP('CycleReturnConfirmedAt', '');
                        if (!(sourceCycleLength > 0)) setP('CycleLengthDays', activeCycleLength);
                    }
                }
                if (cycleState === 'Active') {
                    setP('CycleState', cycleState);
                    if (!hasUsableCycleSource && activeLastStartDay === null && mayBootstrapCycle) {
                        activeCycleLength = cycleLength;
                        activeLastStartDay = worldDay;
                        setP('CycleLengthDays', activeCycleLength);
                        setP('LastStartTime', formatDay(activeLastStartDay));
                    }
                    if (activeCycleLength > 0 && activeLastStartDay !== null && activeLastStartDay <= worldDay) {
                        if (P.LastStartTime !== formatDay(activeLastStartDay)) setP('LastStartTime', formatDay(activeLastStartDay));
                        const cycle = getCycleSnapshot(activeLastStartDay, activeCycleLength, worldDay);
                        if (cycle.cycleStartDay !== activeLastStartDay) setP('LastStartTime', formatDay(cycle.cycleStartDay));
                        setP('ExpectedEndTime', formatDay(cycle.expectedEndDay));
                        setP('CurrentPhase', cycle.phase);
                        setP('CycleProgressPercent', cycle.progressPercent);
                        const ovulatingToday = cycle.ovulationDay === worldDay;
                        const eggCount = ovulatingToday
                            ? ensureOvulationRecord(cycle.cycleStartDay, cycle.ovulationDay).record.EggCount
                            : 0;
                        setR('Fertility', ovulatingToday ? 'Cao' : 'Bình thường');
                        setR('OvulationStatus', ovulatingToday ? 'Đang rụng trứng' : 'Không rụng trứng');
                        setR('FertilizableEggCount', eggCount);
                        setR('PregnancyProgressPercent', 0);
                        setR('CurrentFetusCount', 0);
                    }
                }
            }
        }

        if (resolveConception) {
            const rawModifier = Number(R.ConceptionRateModifierPercent ?? 100);
            const modifier = Number.isFinite(rawModifier) ? _.clamp(Math.round(rawModifier), 0, 300) : 100;
            let pregnant = pregnancyActive;
            let checksChanged = false;
            const replaceCheck = (eventKey, value) => {
                if (_.isEqual(checks[eventKey], value)) return;
                checks[eventKey] = value;
                checksChanged = true;
            };
            for (const [eventKey, sourceCheck] of pending) {
                const check = { ...sourceCheck };
                const protection = check.ProtectionState || 'Unknown';
                const skip = (reason, factors) => replaceCheck(eventKey, {
                    ...check, Status: 'Skipped', ChancePercent: 0, DiceRoll: 0, Result: 'Skipped',
                    PendingReason: 'None', Factors: factors, SkipReason: reason,
                    OvulationRecordKey: '', OvulatedEggCount: 0, FertilizedEggCount: 0, AdditionalEggDiceRolls: [],
                });
                if (pregnant) { skip('AlreadyPregnant', ['Đã mang thai']); continue; }
                if (cycleState === 'PostpartumAmenorrhea') { skip('PostpartumAmenorrhea', ['Chu kỳ chưa trở lại sau thai kỳ']); continue; }
                if (protection === 'Effective') { skip('EffectiveProtection', ['Biện pháp tránh thai có hiệu lực']); continue; }
                if (protection === 'Unknown') {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'None', Factors: ['Chưa xác định trạng thái tránh thai'], SkipReason: '', OvulationRecordKey: '', OvulatedEggCount: 0, FertilizedEggCount: 0, AdditionalEggDiceRolls: [] });
                    continue;
                }
                if (prepubertal || modifier === 0) { skip('NoConceptionCapability', ['Không có khả năng thụ thai']); continue; }
                const occurredDay = parseDay(check.OccurredAt);
                if (occurredDay === null || occurredDay > worldDay) {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'InvalidDate', Factors: ['Thời điểm sự kiện không hợp lệ'], SkipReason: '', OvulationRecordKey: '', OvulatedEggCount: 0, FertilizedEggCount: 0, AdditionalEggDiceRolls: [] });
                    continue;
                }
                if (!hasUsableCycleSource) {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'MissingCycleData', Factors: ['Thiếu dữ liệu chu kỳ'], SkipReason: '', OvulationRecordKey: '', OvulatedEggCount: 0, FertilizedEggCount: 0, AdditionalEggDiceRolls: [] });
                    continue;
                }
                const effectiveCycleLength = sourceCycleLength;
                const lastStartDay = sourceLastStartDay;
                const ovulationDay = getNextOvulationDay(lastStartDay, effectiveCycleLength, occurredDay);
                const viableUntil = occurredDay + SPERM_VIABILITY_DAYS;
                const chance = getConceptionChance(occurredDay, ovulationDay, modifier);
                const resolveDay = Math.max(occurredDay, ovulationDay);
                const scheduling = { OccurredAt: formatDay(occurredDay), ResolveAt: formatDay(resolveDay), SpermViableUntil: formatDay(viableUntil), ChancePercent: chance };
                if (ovulationDay > viableUntil || chance <= 0) {
                    replaceCheck(eventKey, { ...check, ...scheduling, Status: 'Skipped', DiceRoll: 0, Result: 'Skipped', PendingReason: 'None', Factors: [`Sự kiện nằm ngoài cửa sổ từ ${SPERM_VIABILITY_DAYS} ngày trước đến 1 ngày sau rụng trứng`], SkipReason: 'NoFertilizableEggInWindow', OvulationRecordKey: '', OvulatedEggCount: 0, FertilizedEggCount: 0, AdditionalEggDiceRolls: [] });
                    continue;
                }
                if (worldDay < resolveDay) {
                    replaceCheck(eventKey, { ...check, ...scheduling, Status: 'Pending', DiceRoll: 0, Result: 'Pending', PendingReason: 'WaitingForOvulation', Factors: [`Chờ rụng trứng vào ${formatDay(ovulationDay)}`, `Hệ số sinh sản: ${modifier}%`, `Tránh thai: ${protection}`], SkipReason: '', OvulationRecordKey: '', OvulatedEggCount: 0, FertilizedEggCount: 0, AdditionalEggDiceRolls: [] });
                    continue;
                }
                const ovulationOffset = _.clamp(Math.round(effectiveCycleLength / 2), 1, effectiveCycleLength) - 1;
                const cycleStartDay = ovulationDay - ovulationOffset;
                const { key: resolvedOvulationRecordKey, record: resolvedOvulationRecord } = ensureOvulationRecord(cycleStartDay, ovulationDay);
                const ovulatedEggCount = resolvedOvulationRecord.EggCount;
                const roll = _.random(1, 100);
                const conceived = roll <= chance;
                let fertilizedEggCount = conceived ? 1 : 0;
                const additionalEggDiceRolls = [];
                if (conceived) {
                    for (let eggIndex = 1; eggIndex < ovulatedEggCount; eggIndex += 1) {
                        const extraRoll = _.random(1, 100);
                        additionalEggDiceRolls.push(extraRoll);
                        if (extraRoll <= chance) fertilizedEggCount += 1;
                    }
                }
                replaceCheck(eventKey, {
                    ...check, ...scheduling,
                    Status: 'Resolved', DiceRoll: roll, Result: conceived ? 'Conceived' : 'NotConceived', PendingReason: 'None',
                    OvulationRecordKey: resolvedOvulationRecordKey, OvulatedEggCount: ovulatedEggCount,
                    FertilizedEggCount: fertilizedEggCount, AdditionalEggDiceRolls: additionalEggDiceRolls,
                    Factors: [`Độ lệch so với ngày rụng trứng: ${occurredDay - ovulationDay} ngày`, `Số trứng đã rụng: ${ovulatedEggCount}`, `Xác suất: ${chance}%`, `Hệ số sinh sản: ${modifier}%`, `Tránh thai: ${protection}`],
                    SkipReason: '',
                });
                if (!conceived) continue;
                pregnant = true;
                setR('FertilizationStatus', 'Đã thụ thai');
                setR('FertilizationTime', formatDay(resolveDay));
                setR('IsPregnant', true);
                setR('PregnancyProgressPercent', Math.min(100, Math.round((worldDay - resolveDay) / gestationDays * 100)));
                setR('CurrentFetusCount', fertilizedEggCount);
                setR('Fertility', 'Ngừng (mang thai)');
                setR('OvulationStatus', 'Không rụng trứng');
                setR('FertilizableEggCount', 0);
                cycleState = 'SuspendedPregnancy';
                setP('CycleState', cycleState);
                setP('PostpartumStartTime', '');
                setP('CycleResumeTime', '');
                setP('CycleReturnConfirmedAt', '');
                setH('PregnancyCount', Math.max(0, Math.round(Number(H.PregnancyCount) || 0)) + 1);
            }
            const settled = _.sortBy(_.toPairs(checks).filter(([, check]) => check?.Status === 'Resolved' || check?.Status === 'Skipped'), ([, check]) => Number(check?.Sequence) || 0);
            for (const [eventKey] of settled.slice(0, Math.max(0, settled.length - PRIVATE_HISTORY_LIMIT))) {
                delete checks[eventKey];
                cleanupPaths.push(`RelationshipList.${characterKey}.PrivateProfile.ReproductiveStatus.ConceptionChecks.${eventKey}`);
                checksChanged = true;
            }
            if (checksChanged) setR('ConceptionChecks', checks);
        }
        const protectedOvulationKeys = new Set(Object.values(checks).map(check => check?.OvulationRecordKey).filter(Boolean));
        const sortedOvulationEntries = _.sortBy(_.toPairs(ovulationRecords), ([, record]) => parseDay(record?.OvulationTime) ?? Number.MIN_SAFE_INTEGER);
        let removableCount = Math.max(0, sortedOvulationEntries.length - OVULATION_HISTORY_LIMIT);
        for (const [key] of sortedOvulationEntries) {
            if (removableCount <= 0) break;
            if (protectedOvulationKeys.has(key)) continue;
            delete ovulationRecords[key];
            ovulationRecordsChanged = true;
            removableCount -= 1;
        }
        if (ovulationRecordsChanged) setR('OvulationRecords', ovulationRecords);
        if (Object.keys(characterPatch.PrivateProfile).length) relationshipPatch[characterKey] = characterPatch;
    });

    const payload = {};
    if (Object.keys(relationshipPatch).length) payload.RelationshipList = relationshipPatch;
    if (sourceData?.Date?.PhysioTick !== worldTime) { payload.Date = { PhysioTick: worldTime }; dirty = true; }
    return { payload: dirty ? payload : null, cleanupPaths, reason: '' };
};

const applyPrivatePayload = (targetData, payload, cleanupPaths = []) => {
    const targetRoot = statRoot(targetData);
    if (payload?.RelationshipList) {
        _.forEach(payload.RelationshipList, (characterPatch, characterKey) => {
            const current = targetRoot.RelationshipList?.[characterKey] || {};
            const merged = _.mergeWith({}, current, characterPatch, (_oldValue, newValue) => Array.isArray(newValue) ? newValue : undefined);
            _.set(targetRoot, ['RelationshipList', characterKey], merged);
        });
    }
    if (payload?.Date) targetData.Date = { ...(targetData.Date || {}), ...payload.Date };
    for (const path of cleanupPaths) _.unset(targetRoot, path);
    return targetData;
};

const resolveBeforeMessageUpdate = context => {
    const variables = context?.variables;
    if (!hasPrivateState(variables)) return false;
    const factOutcome = consumePrivateEventFacts(variables);
    if (factOutcome.reason) {
        console.warn(`[DestinyPoetry] Same-turn private event consumption deferred: ${factOutcome.reason}.`);
        return false;
    }
    const { payload, cleanupPaths, reason } = buildPrivateUpdate(variables, { resolveConception: true });
    if (reason) {
        console.warn(`[DestinyPoetry] Same-turn private resolution deferred: ${reason}.`);
        return false;
    }
    if (payload || cleanupPaths.length) applyPrivatePayload(variables, payload, cleanupPaths);
    return true;
};

const stopSubscription = subscription => {
    if (typeof subscription === 'function') subscription();
    else if (typeof subscription?.stop === 'function') subscription.stop();
};

const initPrivateAutomation = async () => {
    await waitGlobalInitialized('Mvu');
    if (!Mvu.events?.BEFORE_MESSAGE_UPDATE) throw new Error('Mvu.events.BEFORE_MESSAGE_UPDATE không khả dụng trong runtime hiện tại.');
    const previous = window[PRIVATE_RUNTIME_KEY];
    if (previous?.destroy) previous.destroy();
    const runtime = { subscriptions: [] };
    runtime.destroy = () => runtime.subscriptions.splice(0).forEach(stopSubscription);
    window[PRIVATE_RUNTIME_KEY] = runtime;
    const commandParsedSubscription = (typeof eventMakeFirst === 'function' ? eventMakeFirst : eventOn)(
        Mvu.events.COMMAND_PARSED,
        (variables, commands) => {
            normalizePrivateProfileCommands(variables, commands);
            synchronizeCycleCommands(variables, commands);
        },
    );
    runtime.subscriptions.push(commandParsedSubscription);
    runtime.subscriptions.push(eventOn(Mvu.events.BEFORE_MESSAGE_UPDATE, resolveBeforeMessageUpdate));
    console.log('[DestinyPoetry] Private automation đã tải');
    eventEmit('[DestinyPoetry] Private automation đã tải');
};

$(() => {
    initPrivateAutomation().catch(error => console.error('[DestinyPoetry] Private automation init error:', error));
});
