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

const privateProfileSections = new Set([
    'OutfitDetails', 'Body', 'Physiology', 'ReproductiveStatus', 'SexualHistory', 'Children', 'SecretNotes',
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
const setCommandValue = (command, parts, value) => {
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
        const parts = commandParts(command);
        if (!parts) {
            if (JSON.stringify(command).includes('SexualHistory')) {
                console.warn('[DestinyPoetry] Đã chặn command SexualHistory có cấu trúc không nhận diện được.');
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

const internalEjaculationPositionPathPattern = /^\/RelationshipList\/([^/]+)\/PrivateProfile\/SexualHistory\/Positions\/Xuất tinh bên trong âm đạo$/;
const conceptionInsertPathPattern = /^\/RelationshipList\/([^/]+)\/PrivateProfile\/ReproductiveStatus\/ConceptionChecks\/([^/]+)$/;
const messageText = message => {
    const value = message?.message ?? message?.mes ?? message?.content ?? message?.data?.message;
    return typeof value === 'string' ? value : '';
};
const narrativeBeforeVariableUpdate = text => String(text || '')
    .split(/<UpdateVariable\b|Cập nhật biến số đầy đủ|🔥\s*Tiến Độ Tương Tác/i, 1)[0]
    .trim();
const latestAssistantNarrative = runtime => {
    let storedText = '';
    try {
        if (typeof getChatMessages === 'function' && typeof getLastMessageId === 'function') {
            const messageId = Number(getLastMessageId());
            const messages = Number.isInteger(messageId)
                ? getChatMessages(messageId, { role: 'assistant', include_swipes: false })
                : [];
            if (Array.isArray(messages)) storedText = messageText(messages.at(-1));
            else storedText = messageText(messages);
        }
    } catch (error) {
        console.warn(`[DestinyPoetry] Không đọc được chính văn mới nhất để kiểm chứng sự kiện: ${error?.message || error}.`);
    }
    return narrativeBeforeVariableUpdate(runtime?.latestGeneratedText || storedText || '');
};
const hasConfirmedInternalEjaculation = narrative => {
    const text = String(narrative || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    const positivePatterns = [
        /xuất\s+tinh(?:\s+\S+){0,5}\s+(?:(?:vào|ở)\s+)?(?:bên\s+)?trong(?:\s+(?:âm đạo|cô ấy|nàng|luna|vợ))?/iu,
        /xuất\s+ra(?:\s+\S+){0,4}\s+(?:(?:vào|ở)\s+)?(?:bên\s+)?trong(?:\s+(?:âm đạo|cô ấy|nàng|luna|vợ))?/iu,
        /xuất\s+(?:vào|ở)\s+(?:bên\s+)?trong(?:\s+(?:âm đạo|cô ấy|nàng|luna|vợ))?/iu,
        /(?:phóng|bắn|phun)\s+(?:tinh|tinh dịch)(?:\s+\S+){0,5}\s+(?:(?:vào|ở)\s+)?(?:bên\s+)?trong/iu,
        /tinh dịch.{0,80}(?:phun|bắn|trào|đổ|chảy|lấp đầy).{0,80}(?:bên trong|âm đạo|tử cung)/iu,
        /(?:bên trong|âm đạo|tử cung).{0,80}(?:đầy|ngập).{0,40}tinh dịch/iu,
        /(?:ejaculat(?:ed|es|ing)?|came|cum(?:s|med|ming)?)\s+(?:deep\s+)?inside/iu,
    ];
    const disqualifyingPatterns = [
        /(?:chưa|không\s+hề|chẳng|suýt|sắp|định|muốn|sẽ|có\s+thể|chuẩn\s+bị)\s+(?:\S+\s+){0,3}(?:xuất|phóng|bắn)/iu,
        /(?:xuất|phóng|bắn)\s*(?:tinh)?(?:\s+\S+){0,4}\s+(?:ra\s+ngoài|bên\s+ngoài)/iu,
        /(?:not|never|almost|will|would|might|plans?\s+to|about\s+to)\s+(?:\S+\s+){0,3}(?:ejaculat|cum|came)/iu,
    ];
    for (const clause of text.split(/[.!?。！？]+/)) {
        if (positivePatterns.some(pattern => pattern.test(clause))
            && !disqualifyingPatterns.some(pattern => pattern.test(clause))) return true;
    }
    return false;
};
const guardInternalEjaculationCommands = (commands, narrative) => {
    if (!Array.isArray(commands)) return;
    const positionCharacters = new Set();
    const conceptionCharacters = new Set();
    for (const command of commands) {
        const parts = commandParts(command);
        if (!parts) continue;
        const positionMatch = internalEjaculationPositionPathPattern.exec(parts.path);
        if (positionMatch && ['insert', 'replace', 'delta'].includes(parts.operation)) {
            positionCharacters.add(decodePointerSegment(positionMatch[1]));
        }
        const conceptionMatch = conceptionInsertPathPattern.exec(parts.path);
        if (conceptionMatch && parts.operation === 'insert') {
            conceptionCharacters.add(decodePointerSegment(conceptionMatch[1]));
        }
    }
    if (!positionCharacters.size && !conceptionCharacters.size) return;
    const sourceNarrative = typeof narrative === 'function' ? narrative() : narrative;
    const confirmed = hasConfirmedInternalEjaculation(sourceNarrative);
    const invalidCharacters = new Set([...positionCharacters, ...conceptionCharacters].filter(characterKey => (
        !confirmed || !positionCharacters.has(characterKey) || !conceptionCharacters.has(characterKey)
    )));
    if (!invalidCharacters.size) return;
    for (let index = commands.length - 1; index >= 0; index -= 1) {
        const parts = commandParts(commands[index]);
        if (!parts) continue;
        const positionMatch = internalEjaculationPositionPathPattern.exec(parts.path);
        const conceptionMatch = conceptionInsertPathPattern.exec(parts.path);
        const characterKey = decodePointerSegment(positionMatch?.[1] ?? conceptionMatch?.[1] ?? '');
        if (invalidCharacters.has(characterKey) && (positionMatch || (conceptionMatch && parts.operation === 'insert'))) {
            commands.splice(index, 1);
        }
    }
    console.warn(`[DestinyPoetry] Đã chặn cập nhật xuất tinh trong/kiểm tra thụ thai thiếu bằng chứng chính văn hoặc thiếu cặp operation nguyên tử: ${[...invalidCharacters].join(', ')}.`);
};
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
    applyPrivatePayload(nextData, payload, cleanupPaths);
    runtime.isApplyingPrivateUpdate = true;
    runtime.lastPrivateWriteSignature = privateWriteSignature(nextData);
    try {
        await Mvu.replaceMvuData(nextData, { type: 'message', message_id: messageId });
    } finally {
        runtime.isApplyingPrivateUpdate = false;
    }
    return true;
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
    const { payload, cleanupPaths, reason } = buildPrivateUpdate(variables, { resolveConception: true });
    if (reason) {
        console.warn(`[DestinyPoetry] Same-turn private resolution deferred: ${reason}.`);
        return false;
    }
    if (payload || cleanupPaths.length) applyPrivatePayload(variables, payload, cleanupPaths);
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
    if (!Mvu.events?.BEFORE_MESSAGE_UPDATE) throw new Error('Mvu.events.BEFORE_MESSAGE_UPDATE không khả dụng trong runtime hiện tại.');
    const previous = window[PRIVATE_RUNTIME_KEY];
    if (previous?.destroy) previous.destroy();
    const runtime = {
        queue: Promise.resolve(), lastAssistantMessageId: null, needsReconciliation: true,
        pendingJob: null, isApplyingPrivateUpdate: false, lastPrivateWriteSignature: '',
        latestGeneratedText: '', subscriptions: [],
    };
    runtime.destroy = () => runtime.subscriptions.splice(0).forEach(stopSubscription);
    window[PRIVATE_RUNTIME_KEY] = runtime;
    const commandParsedSubscription = (typeof eventMakeFirst === 'function' ? eventMakeFirst : eventOn)(
        Mvu.events.COMMAND_PARSED,
        (variables, commands) => {
            normalizePrivateProfileCommands(variables, commands);
            guardInternalEjaculationCommands(commands, () => latestAssistantNarrative(runtime));
            runtime.latestGeneratedText = '';
            synchronizeCycleCommands(variables, commands);
        },
    );
    runtime.subscriptions.push(commandParsedSubscription);
    if (typeof iframe_events !== 'undefined' && iframe_events?.GENERATION_ENDED) {
        runtime.subscriptions.push(eventOn(iframe_events.GENERATION_ENDED, text => {
            runtime.latestGeneratedText = String(text || '');
        }));
    }
    runtime.subscriptions.push(eventOn(Mvu.events.BEFORE_MESSAGE_UPDATE, resolveBeforeMessageUpdate));
    console.log('[DestinyPoetry] Private automation đã tải');
    eventEmit('[DestinyPoetry] Private automation đã tải');
};

$(() => {
    initPrivateAutomation().catch(error => console.error('[DestinyPoetry] Private automation init error:', error));
});
