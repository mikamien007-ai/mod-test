/**
 * DestinyPoetry - Private Profile automation
 * Runtime owner: Tavern Helper / SillyTavern.
 * Writer scope: RelationshipList.*.PrivateProfile and Date.PhysioTick.
 */

const PRIVATE_HISTORY_LIMIT = 10;
const SPERM_VIABILITY_DAYS = 5;
const CHANCE_BY_DAYS_BEFORE_OVULATION = Object.freeze({ 0: 30, 1: 25, 2: 20, 3: 15, 4: 10, 5: 5 });
const CONCEPTION_SCOPE_RETRY_DELAYS_MS = Object.freeze([0, 100, 300, 800, 1500]);
const PRIVATE_RUNTIME_KEY = '__DestinyPoetryPrivateAutomation';
const statRoot = value => value?.stat_data && typeof value.stat_data === 'object' ? value.stat_data : value;
const pad2 = value => String(value).padStart(2, '0');

const parseDay = value => {
    const source = String(value || '').trim();
    if (!source) return null;
    let year, month, day;
    const canonical = /Năm\s*(\d+)\s*-\s*Tháng\s*(\d+)\s*-\s*Ngày\s*(\d+)/i.exec(source);
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

const daySignature = value => {
    const day = parseDay(value);
    return day === null ? `invalid:${String(value || '').trim()}` : formatDay(day);
};

const raceDefaults = race => {
    const source = String(race || '').toLowerCase();
    const rows = [
        ['hồ ly', 30, 280, 14], ['tinh linh', 35, 300, 18], ['long', 42, 540, 20],
        ['thú nhân', 26, 200, 10], ['thiên sứ', 28, 300, 14], ['dực', 28, 300, 14],
        ['nữ thần', 28, 365, 16], ['thần', 28, 365, 16], ['người', 28, 280, 12],
        ['nhân tộc', 28, 280, 12],
    ];
    return rows.find(row => source.includes(row[0])) || null;
};

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
    if (result < referenceDay) result += cycleLength;
    return result;
};

const getConceptionChance = (occurredDay, ovulationDay, modifier) => {
    const base = CHANCE_BY_DAYS_BEFORE_OVULATION[ovulationDay - occurredDay];
    return Number.isFinite(base) ? _.clamp(Math.round(base * modifier / 100), 0, 95) : 0;
};

const isPendingCheck = check => (check?.Status || 'Pending') === 'Pending'
    && (check?.Result || 'Pending') === 'Pending'
    && (Number(check?.DiceRoll) || 0) === 0;

const conceptionEventRefs = data => {
    const refs = [];
    _.forEach(statRoot(data)?.RelationshipList || {}, (character, characterKey) => {
        const reproductive = character?.PrivateProfile?.ReproductiveStatus || {};
        _.forEach(reproductive.ConceptionChecks || {}, (check, eventKey) => {
            refs.push({
                characterKey,
                eventKey,
                sequence: Number(check?.Sequence) || 0,
                occurredAt: daySignature(check?.OccurredAt),
            });
        });
    });
    return _.sortBy(refs, ref => `${ref.characterKey}\u0000${ref.eventKey}`);
};

const eventRefKey = ref => [ref.characterKey, ref.eventKey, ref.sequence, ref.occurredAt].join('\u0000');
const createSyncJob = (runtime, variables) => {
    const root = statRoot(variables) || {};
    const lastMessageId = Number(getLastMessageId());
    return {
        messageId: Number.isInteger(runtime.lastAssistantMessageId)
            ? runtime.lastAssistantMessageId
            : Number.isInteger(lastMessageId) ? lastMessageId : null,
        worldTime: root.World?.Time || '',
        eventRefs: conceptionEventRefs(root),
    };
};

const sameUpdatedSource = (candidate, job) => {
    const candidateRoot = statRoot(candidate) || {};
    if (!job?.worldTime || (candidateRoot.World?.Time || '') !== job.worldTime) return false;
    if (!candidateRoot.RelationshipList || typeof candidateRoot.RelationshipList !== 'object') return false;
    if (!job.eventRefs?.length) return true;
    const actual = new Set(conceptionEventRefs(candidateRoot).map(eventRefKey));
    return job.eventRefs.every(ref => actual.has(eventRefKey(ref)));
};

const privateWriteSignature = data => {
    const root = statRoot(data) || {};
    const profiles = [];
    _.forEach(root.RelationshipList || {}, (character, characterKey) => {
        if (character?.PrivateProfile) profiles.push([characterKey, character.PrivateProfile]);
    });
    return JSON.stringify([
        root.World?.Time || '', data?.Date?.PhysioTick || '',
        _.sortBy(profiles, value => value[0]),
    ]);
};

const isPrivateWriteEcho = (runtime, variables) => {
    if (runtime.isApplyingPrivateUpdate) return true;
    if (!runtime.lastPrivateWriteSignature) return false;
    if (privateWriteSignature(variables) !== runtime.lastPrivateWriteSignature) return false;
    runtime.lastPrivateWriteSignature = '';
    return true;
};

const legacyPrivateProfilePathPattern = /^\/RelationshipList\/([^/]+)\/(SexualHistory|ReproductiveStatus)(?:\/(.*))?$/;
const decodePointerSegment = value => String(value).replace(/~1/g, '/').replace(/~0/g, '~');
const pointerSegments = path => String(path || '').split('/').slice(1).map(decodePointerSegment);
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
    const pathKey = typeof command?.path === 'string' ? 'path'
        : Array.isArray(command?.args) && typeof command.args[0] === 'string' ? 'args' : null;
    if (!operationKey || !pathKey) return null;
    return {
        operationKey,
        pathKey,
        operation: String(command[operationKey]).toLowerCase(),
        path: pathKey === 'path' ? command.path : command.args[0],
        value: pathKey === 'path' ? command.value : command.args[1],
    };
};
const setCommandValue = (command, parts, value) => {
    if (parts.pathKey === 'path') command.value = value;
    else command.args[1] = value;
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
        const parts = commandParts(existing);
        existing[parts.operationKey] = operation;
        setCommandValue(existing, parts, value);
    } else commands.push({ op: operation, path, value });
    setPointerValue(root, path, _.cloneDeep(value));
};
const hasCommandPath = (commands, path) => commands.some(command => commandParts(command)?.path === path);
const cycleDayFromProgress = (progressPercent, cycleLength) => {
    const progress = Number(progressPercent);
    if (!(cycleLength > 0) || !(progress > 0)) return 0;
    return _.clamp(Math.round(progress * cycleLength / 100), 1, cycleLength);
};
const repairCycleAnchor = (root, commands, characterKey, { requireExplicitClaim }) => {
    const character = root.RelationshipList?.[characterKey];
    const P = character?.PrivateProfile?.Physiology;
    if (!P) return false;
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
            ['Physiology', 'LastStartTime'],
            ['Physiology', 'ExpectedEndTime'],
            ['Physiology', 'CurrentPhase'],
            ['Physiology', 'CycleProgressPercent'],
            ['ReproductiveStatus', 'GestationDays'],
            ['ReproductiveStatus', 'Fertility'],
            ['ReproductiveStatus', 'OvulationStatus'],
            ['ReproductiveStatus', 'FertilizableEggCount'],
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
        const operationKey = Object.prototype.hasOwnProperty.call(command, 'op') ? 'op'
            : Object.prototype.hasOwnProperty.call(command, 'type') ? 'type' : null;
        const pathKey = typeof command.path === 'string' ? 'path'
            : Array.isArray(command.args) && typeof command.args[0] === 'string' ? 'args' : null;
        if (!operationKey || !pathKey) continue;
        const sourcePath = pathKey === 'path' ? command.path : command.args[0];
        const match = legacyPrivateProfilePathPattern.exec(sourcePath);
        const normalizedPath = match
            ? `/RelationshipList/${match[1]}/PrivateProfile/${match[2]}${match[3] ? `/${match[3]}` : ''}`
            : sourcePath;
        if (!match && !normalizedPath.includes('/PrivateProfile/SexualHistory')) continue;
        if (pathKey === 'path') command.path = normalizedPath;
        else command.args[0] = normalizedPath;
        if (!normalizedPath.includes('/PrivateProfile/SexualHistory/Positions/')) continue;
        if (String(command[operationKey]).toLowerCase() !== 'delta') continue;
        const current = pointerValue(root, normalizedPath);
        if (Number.isFinite(Number(current)) && current !== '') continue;
        if (current === undefined) {
            const parentPath = normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
            const parent = pointerValue(root, parentPath);
            if (parent && typeof parent === 'object' && !Array.isArray(parent)) {
                command[operationKey] = 'insert';
                continue;
            }
        }
        console.warn(`[DestinyPoetry] Đã chặn bộ đếm Positions không hợp lệ tại ${normalizedPath}: giá trị hiện tại không phải số.`);
        commands.splice(index, 1);
    }
};

const conceptionInsertPathPattern = /^\/RelationshipList\/([^/]+)\/PrivateProfile\/ReproductiveStatus\/ConceptionChecks\/([^/]+)$/;
const enrichConceptionCommands = (variables, commands) => {
    if (!Array.isArray(commands)) return;
    const previewRoot = _.cloneDeep(statRoot(variables) || {});
    previewCommands(previewRoot, commands);
    for (const command of commands) {
        const parts = commandParts(command);
        const match = parts && parts.operation === 'insert' ? conceptionInsertPathPattern.exec(parts.path) : null;
        if (!match || !parts.value || typeof parts.value !== 'object' || Array.isArray(parts.value)) continue;
        const characterKey = decodePointerSegment(match[1]);
        const eventKey = decodePointerSegment(match[2]);
        const character = previewRoot.RelationshipList?.[characterKey];
        if (!character?.PrivateProfile) continue;

        const sourceCheck = _.cloneDeep(parts.value);
        const isolatedRoot = {
            World: _.cloneDeep(previewRoot.World || {}),
            Date: {},
            RelationshipList: { [characterKey]: _.cloneDeep(character) },
        };
        isolatedRoot.RelationshipList[characterKey].PrivateProfile.ReproductiveStatus ||= {};
        isolatedRoot.RelationshipList[characterKey].PrivateProfile.ReproductiveStatus.ConceptionChecks = {
            [eventKey]: sourceCheck,
        };
        const outcome = buildPrivateUpdate(isolatedRoot, { resolveConception: true });
        const profilePatch = outcome.payload?.RelationshipList?.[characterKey]?.PrivateProfile;
        const resolvedCheck = profilePatch?.ReproductiveStatus?.ConceptionChecks?.[eventKey];
        if (!resolvedCheck) continue;

        setCommandValue(command, parts, resolvedCheck);
        setPointerValue(previewRoot, parts.path, _.cloneDeep(resolvedCheck));
        if (resolvedCheck.Result !== 'Conceived') continue;

        const authoritativeFields = [
            ['ReproductiveStatus', 'FertilizationStatus'],
            ['ReproductiveStatus', 'FertilizationTime'],
            ['ReproductiveStatus', 'IsPregnant'],
            ['ReproductiveStatus', 'PregnancyProgressPercent'],
            ['ReproductiveStatus', 'CurrentFetusCount'],
            ['ReproductiveStatus', 'Fertility'],
            ['ReproductiveStatus', 'OvulationStatus'],
            ['ReproductiveStatus', 'FertilizableEggCount'],
            ['SexualHistory', 'PregnancyCount'],
        ];
        for (const [section, field] of authoritativeFields) {
            if (!Object.prototype.hasOwnProperty.call(profilePatch?.[section] || {}, field)) continue;
            const path = `/RelationshipList/${match[1]}/PrivateProfile/${section}/${field}`;
            upsertAuthoritativeCommand(previewRoot, commands, path, profilePatch[section][field]);
        }
    }
};

const hasPrivateState = data => {
    const root = statRoot(data) || {};
    return Boolean(root.World?.Time && root.RelationshipList && typeof root.RelationshipList === 'object');
};

const candidateMessageIds = (runtime, job = null) => {
    const last = Number(getLastMessageId());
    const ids = [job?.messageId, runtime.lastAssistantMessageId];
    if (Number.isInteger(last)) for (let id = last; id >= Math.max(0, last - 6); id -= 1) ids.push(id);
    return _.uniq(ids.filter(Number.isInteger));
};

const waitForRetry = delayMs => delayMs > 0
    ? new Promise(resolve => setTimeout(resolve, delayMs))
    : Promise.resolve();

const readMvuScope = async messageId => {
    if (typeof Mvu?.getMvuData === 'function') {
        return await Mvu.getMvuData({ type: 'message', message_id: messageId });
    }
    return getVariables({ type: 'message', message_id: messageId });
};

const findLatestMvuScope = async runtime => {
    for (const messageId of candidateMessageIds(runtime)) {
        try {
            const data = await readMvuScope(messageId);
            if (hasPrivateState(data)) return { messageId, data };
        } catch (_) { /* Absent floors are expected in short chats. */ }
    }
    return null;
};

const findUpdatedMvuScope = async (runtime, job) => {
    const matches = [];
    const checkedIds = candidateMessageIds(runtime, job);
    for (const messageId of checkedIds) {
        try {
            const data = await readMvuScope(messageId);
            if (sameUpdatedSource(data, job)) matches.push({ messageId, data });
        } catch (_) { /* Continue checking bounded candidates. */ }
    }
    const preferredMessageId = Number.isInteger(job?.messageId) ? job.messageId : runtime.lastAssistantMessageId;
    const preferred = Number.isInteger(preferredMessageId)
        ? matches.find(match => match.messageId === preferredMessageId)
        : null;
    if (preferred) return { scope: preferred, matchCount: matches.length, checkedIds };
    return { scope: matches.length === 1 ? matches[0] : null, matchCount: matches.length, checkedIds };
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
        const pending = resolveConception
            ? _.sortBy(_.toPairs(checks).filter(([, check]) => isPendingCheck(check)), ([, check]) => Number(check?.Sequence) || Number.MAX_SAFE_INTEGER)
            : [];
        const cycleLength = sourceCycleLength || defaults?.[1] || 28;
        const gestationDays = Number(R.GestationDays) > 0 ? Math.round(Number(R.GestationDays)) : defaults?.[2] || 280;
        const pubertyAge = defaults?.[3] || 14;
        const age = Number(character.AgeYears) || 0;
        const prepubertal = sourceCycleLength === 0 && age > 0 && age < pubertyAge;
        const mayBootstrapCycle = !pending.length && age >= pubertyAge;
        let activeCycleLength = sourceCycleLength;
        let activeLastStartDay = sourceLastStartDay;

        if (prepubertal) {
            setR('Fertility', 'Chưa trưởng thành');
            setR('OvulationStatus', 'Chưa bắt đầu');
            setR('FertilizableEggCount', 0);
        } else {
            if (!(Number(R.GestationDays) > 0)) setR('GestationDays', gestationDays);
            if (!hasUsableCycleSource && mayBootstrapCycle) {
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
                if (R.IsPregnant) {
                    setR('Fertility', 'Ngừng (mang thai)');
                    setR('OvulationStatus', 'Không rụng trứng');
                    setR('FertilizableEggCount', 0);
                    const fertilizationDay = parseDay(R.FertilizationTime);
                    if (fertilizationDay !== null && fertilizationDay <= worldDay) {
                        setR('PregnancyProgressPercent', Math.min(100, Math.round((worldDay - fertilizationDay) / gestationDays * 100)));
                    }
                } else {
                    const ovulatingToday = cycle.ovulationDay === worldDay;
                    setR('Fertility', ovulatingToday ? 'Cao' : 'Bình thường');
                    setR('OvulationStatus', ovulatingToday ? 'Đang rụng trứng' : 'Không rụng trứng');
                    setR('FertilizableEggCount', ovulatingToday ? 1 : 0);
                    setR('PregnancyProgressPercent', 0);
                    setR('CurrentFetusCount', 0);
                }
            }
        }

        if (resolveConception) {
            const rawModifier = Number(R.ConceptionRateModifierPercent ?? 100);
            const modifier = Number.isFinite(rawModifier) ? _.clamp(Math.round(rawModifier), 0, 300) : 100;
            let pregnant = Boolean(R.IsPregnant);
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
                });
                if (pregnant) { skip('AlreadyPregnant', ['Đã mang thai']); continue; }
                if (protection === 'Effective') { skip('EffectiveProtection', ['Biện pháp tránh thai có hiệu lực']); continue; }
                if (protection === 'Unknown') {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'None', Factors: ['Chưa xác định trạng thái tránh thai'], SkipReason: '' });
                    continue;
                }
                if (prepubertal || modifier === 0) { skip('NoConceptionCapability', ['Không có khả năng thụ thai']); continue; }
                const occurredDay = parseDay(check.OccurredAt);
                if (occurredDay === null || occurredDay > worldDay) {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'InvalidDate', Factors: ['Thời điểm sự kiện không hợp lệ'], SkipReason: '' });
                    continue;
                }
                if (!hasUsableCycleSource) {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'MissingCycleData', Factors: ['Thiếu dữ liệu chu kỳ'], SkipReason: '' });
                    continue;
                }
                const effectiveCycleLength = sourceCycleLength;
                const lastStartDay = sourceLastStartDay;
                const ovulationDay = getNextOvulationDay(lastStartDay, effectiveCycleLength, occurredDay);
                const viableUntil = occurredDay + SPERM_VIABILITY_DAYS;
                const chance = getConceptionChance(occurredDay, ovulationDay, modifier);
                const scheduling = { OccurredAt: formatDay(occurredDay), ResolveAt: formatDay(ovulationDay), SpermViableUntil: formatDay(viableUntil), ChancePercent: chance };
                if (ovulationDay > viableUntil || chance <= 0) {
                    replaceCheck(eventKey, { ...check, ...scheduling, Status: 'Skipped', DiceRoll: 0, Result: 'Skipped', PendingReason: 'None', Factors: [`Ngày rụng trứng nằm ngoài cửa sổ ${SPERM_VIABILITY_DAYS} ngày`], SkipReason: 'NoFertilizableEggInWindow' });
                    continue;
                }
                if (worldDay < ovulationDay) {
                    replaceCheck(eventKey, { ...check, ...scheduling, Status: 'Pending', DiceRoll: 0, Result: 'Pending', PendingReason: 'WaitingForOvulation', Factors: [`Chờ rụng trứng vào ${formatDay(ovulationDay)}`, `Hệ số sinh sản: ${modifier}%`, `Tránh thai: ${protection}`], SkipReason: '' });
                    continue;
                }
                const roll = _.random(1, 100);
                const conceived = roll <= chance;
                replaceCheck(eventKey, { ...check, ...scheduling, Status: 'Resolved', DiceRoll: roll, Result: conceived ? 'Conceived' : 'NotConceived', PendingReason: 'None', Factors: [`Cách ngày rụng trứng: ${ovulationDay - occurredDay} ngày`, `Xác suất: ${chance}%`, `Hệ số sinh sản: ${modifier}%`, `Tránh thai: ${protection}`], SkipReason: '' });
                if (!conceived) continue;
                pregnant = true;
                setR('FertilizationStatus', 'Đã thụ thai');
                setR('FertilizationTime', formatDay(ovulationDay));
                setR('IsPregnant', true);
                setR('PregnancyProgressPercent', Math.min(100, Math.round((worldDay - ovulationDay) / gestationDays * 100)));
                setR('CurrentFetusCount', 1);
                setR('Fertility', 'Ngừng (mang thai)');
                setR('OvulationStatus', 'Không rụng trứng');
                setR('FertilizableEggCount', 0);
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
        if (Object.keys(characterPatch.PrivateProfile).length) relationshipPatch[characterKey] = characterPatch;
    });

    const payload = {};
    if (Object.keys(relationshipPatch).length) payload.RelationshipList = relationshipPatch;
    if (sourceData?.Date?.PhysioTick !== worldTime) { payload.Date = { PhysioTick: worldTime }; dirty = true; }
    return { payload: dirty ? payload : null, cleanupPaths, reason: '' };
};

const applyPrivateUpdate = async (runtime, messageId, sourceData, options) => {
    const { payload, cleanupPaths, reason } = buildPrivateUpdate(sourceData, options);
    if (reason) {
        console.warn(`[DestinyPoetry] Private automation deferred: ${reason}.`);
        return false;
    }
    if (!payload && !cleanupPaths.length) return true;
    if (typeof Mvu?.replaceMvuData !== 'function') throw new Error('Mvu.replaceMvuData không khả dụng trong runtime hiện tại.');
    const nextData = _.cloneDeep(sourceData);
    const nextRoot = statRoot(nextData);
    if (payload?.RelationshipList) {
        _.forEach(payload.RelationshipList, (characterPatch, characterKey) => {
            const current = nextRoot.RelationshipList?.[characterKey] || {};
            const merged = _.mergeWith({}, current, characterPatch, (_oldValue, newValue) => Array.isArray(newValue) ? newValue : undefined);
            _.set(nextRoot, ['RelationshipList', characterKey], merged);
        });
    }
    if (payload?.Date) nextData.Date = { ...(nextData.Date || {}), ...payload.Date };
    for (const path of cleanupPaths) _.unset(nextRoot, path);
    runtime.isApplyingPrivateUpdate = true;
    runtime.lastPrivateWriteSignature = privateWriteSignature(nextData);
    try {
        await Mvu.replaceMvuData(nextData, { type: 'message', message_id: messageId });
    } finally {
        runtime.isApplyingPrivateUpdate = false;
    }
    return true;
};

const enqueue = (runtime, task) => {
    runtime.queue = runtime.queue.then(task, task).catch(error => console.error('[DestinyPoetry] Private automation error:', error));
    return runtime.queue;
};
const physioTick = runtime => enqueue(runtime, async () => {
    const scope = await findLatestMvuScope(runtime);
    if (!scope) return false;
    const applied = await applyPrivateUpdate(runtime, scope.messageId, scope.data, { resolveConception: true });
    if (applied) runtime.needsReconciliation = false;
    return applied;
});
const syncPendingJob = runtime => {
    return enqueue(runtime, async () => {
        const job = runtime.pendingJob;
        if (!job) return;
        let lastMatchCount = 0;
        let checkedIds = [];
        for (const delayMs of CONCEPTION_SCOPE_RETRY_DELAYS_MS) {
            await waitForRetry(delayMs);
            const result = await findUpdatedMvuScope(runtime, job);
            lastMatchCount = result.matchCount;
            checkedIds = result.checkedIds;
            if (!result.scope) continue;
            const applied = await applyPrivateUpdate(runtime, result.scope.messageId, result.scope.data, { resolveConception: true });
            if (applied) {
                runtime.needsReconciliation = false;
                if (runtime.pendingJob === job) runtime.pendingJob = null;
            }
            return;
        }
        runtime.needsReconciliation = true;
        console.warn(`[DestinyPoetry] Post-MVU private sync deferred: chưa tìm thấy đúng tầng sau khi chờ lưu chat; matches=${lastMatchCount}, checked=[${checkedIds.join(',')}].`);
    });
};
const syncAfterMvuUpdate = (runtime, variables) => {
    if (isPrivateWriteEcho(runtime, variables)) return runtime.queue;
    runtime.pendingJob = createSyncJob(runtime, variables);
    return syncPendingJob(runtime);
};
const stopSubscription = subscription => {
    if (typeof subscription === 'function') subscription();
    else if (typeof subscription?.stop === 'function') subscription.stop();
};

const initPrivateAutomation = async () => {
    await waitGlobalInitialized('Mvu');
    const previous = window[PRIVATE_RUNTIME_KEY];
    if (previous?.destroy) previous.destroy();
    const runtime = {
        queue: Promise.resolve(), lastAssistantMessageId: null, needsReconciliation: true,
        pendingJob: null, isApplyingPrivateUpdate: false, lastPrivateWriteSignature: '', subscriptions: [],
    };
    runtime.destroy = () => runtime.subscriptions.splice(0).forEach(stopSubscription);
    window[PRIVATE_RUNTIME_KEY] = runtime;
    runtime.subscriptions.push(eventOn(tavern_events.MESSAGE_RECEIVED, messageId => {
        if (Number.isInteger(Number(messageId))) runtime.lastAssistantMessageId = Number(messageId);
    }));
    runtime.subscriptions.push(eventOn(tavern_events.MESSAGE_UPDATED, messageId => {
        if (runtime.pendingJob) syncPendingJob(runtime);
        else if (runtime.needsReconciliation) physioTick(runtime);
    }));
    runtime.subscriptions.push(eventOn(tavern_events.GENERATION_AFTER_COMMANDS, () => physioTick(runtime)));
    runtime.subscriptions.push(eventOn(Mvu.events.VARIABLE_INITIALIZED, variables => {
        if (runtime.pendingJob) syncPendingJob(runtime);
        else syncAfterMvuUpdate(runtime, variables);
    }));
    const commandParsedSubscription = (typeof eventMakeFirst === 'function' ? eventMakeFirst : eventOn)(
        Mvu.events.COMMAND_PARSED,
        (variables, commands) => {
            normalizePrivateProfileCommands(variables, commands);
            synchronizeCycleCommands(variables, commands);
            enrichConceptionCommands(variables, commands);
        },
    );
    runtime.subscriptions.push(commandParsedSubscription);
    runtime.subscriptions.push(eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => syncAfterMvuUpdate(runtime, variables)));
    console.log('[DestinyPoetry] Private automation đã tải');
    eventEmit('[DestinyPoetry] Private automation đã tải');
    physioTick(runtime);
};

$(() => {
    initPrivateAutomation().catch(error => console.error('[DestinyPoetry] Private automation init error:', error));
});
