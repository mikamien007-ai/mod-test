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

const pendingCheckKeys = data => {
    const keys = [];
    _.forEach(statRoot(data)?.RelationshipList || {}, (character, characterKey) => {
        _.forEach(character?.PrivateProfile?.ReproductiveStatus?.ConceptionChecks || {}, (check, eventKey) => {
            if (isPendingCheck(check)) keys.push(`${characterKey}\u0000${eventKey}\u0000${Number(check?.Sequence) || 0}\u0000${check?.OccurredAt || ''}`);
        });
    });
    return keys.sort();
};

const sameUpdatedSource = (candidate, eventData) => {
    const expectedRoot = statRoot(eventData) || {};
    const candidateRoot = statRoot(candidate) || {};
    const expectedWorldTime = expectedRoot.World?.Time || '';
    if (!expectedWorldTime || (candidateRoot.World?.Time || '') !== expectedWorldTime) return false;
    if (!candidateRoot.RelationshipList || typeof candidateRoot.RelationshipList !== 'object') return false;
    const expectedKeys = pendingCheckKeys(expectedRoot);
    if (!expectedKeys.length) return true;
    const actual = new Set(pendingCheckKeys(candidateRoot));
    return expectedKeys.every(key => actual.has(key));
};

const privatePositionPathPattern = /^\/RelationshipList\/([^/]+)\/SexualHistory\/Positions\/(.+)$/;
const decodePointerSegment = value => String(value).replace(/~1/g, '/').replace(/~0/g, '~');
const pointerSegments = path => String(path || '').split('/').slice(1).map(decodePointerSegment);
const pointerValue = (root, path) => pointerSegments(path).reduce((value, key) => value?.[key], root);
const normalizePrivatePositionCommands = (variables, commands) => {
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
        const match = privatePositionPathPattern.exec(sourcePath);
        const normalizedPath = match
            ? `/RelationshipList/${match[1]}/PrivateProfile/SexualHistory/Positions/${match[2]}`
            : sourcePath;
        if (!normalizedPath.includes('/PrivateProfile/SexualHistory/Positions/')) continue;
        if (pathKey === 'path') command.path = normalizedPath;
        else command.args[0] = normalizedPath;
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

const hasPrivateState = data => {
    const root = statRoot(data) || {};
    return Boolean(root.World?.Time && root.RelationshipList && typeof root.RelationshipList === 'object');
};

const candidateMessageIds = runtime => {
    const last = Number(getLastMessageId());
    const ids = [runtime.lastAssistantMessageId];
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

const findUpdatedMvuScope = async (runtime, variables) => {
    const matches = [];
    const checkedIds = candidateMessageIds(runtime);
    for (const messageId of checkedIds) {
        try {
            const data = await readMvuScope(messageId);
            if (sameUpdatedSource(data, variables)) matches.push({ messageId, data });
        } catch (_) { /* Continue checking bounded candidates. */ }
    }
    const preferred = Number.isInteger(runtime.lastAssistantMessageId)
        ? matches.find(match => match.messageId === runtime.lastAssistantMessageId)
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
        const cycleLength = Number(P.CycleLengthDays) > 0 ? Math.round(Number(P.CycleLengthDays)) : defaults?.[1] || 28;
        const gestationDays = Number(R.GestationDays) > 0 ? Math.round(Number(R.GestationDays)) : defaults?.[2] || 280;
        const pubertyAge = defaults?.[3] || 14;
        const age = Number(character.AgeYears) || 0;
        const evidence = [character.Background, character.Appearance, ...(Array.isArray(character.Identity) ? character.Identity : [])].filter(Boolean).join(' | ');
        const prepubertal = (age > 0 && age < pubertyAge)
            || /(?:ấu\s*nữ|bé\s*gái|trẻ\s*em|chưa\s*(?:dậy|qua\s*tuổi\s*dậy)\s*thì|prepubescent|prepubertal)/i.test(evidence);

        if (prepubertal) {
            setR('Fertility', 'Chưa trưởng thành');
            setR('OvulationStatus', 'Chưa bắt đầu');
            setR('FertilizableEggCount', 0);
        } else {
            if (!(Number(P.CycleLengthDays) > 0)) setP('CycleLengthDays', cycleLength);
            if (!(Number(R.GestationDays) > 0)) setR('GestationDays', gestationDays);
            let lastStartDay = parseDay(P.LastStartTime);
            if (lastStartDay === null || lastStartDay > worldDay) {
                lastStartDay = worldDay;
                setP('LastStartTime', formatDay(lastStartDay));
            } else if (P.LastStartTime !== formatDay(lastStartDay)) setP('LastStartTime', formatDay(lastStartDay));
            const cycle = getCycleSnapshot(lastStartDay, cycleLength, worldDay);
            if (cycle.cycleStartDay !== lastStartDay) setP('LastStartTime', formatDay(cycle.cycleStartDay));
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

        if (resolveConception) {
            const checks = { ...(R.ConceptionChecks || {}) };
            const pending = _.sortBy(_.toPairs(checks).filter(([, check]) => isPendingCheck(check)), ([, check]) => Number(check?.Sequence) || Number.MAX_SAFE_INTEGER);
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
                if (prepubertal || modifier === 0) { skip('NoConceptionCapability', ['Không có khả năng thụ thai']); continue; }
                const occurredDay = parseDay(check.OccurredAt);
                if (occurredDay === null || occurredDay > worldDay) {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'InvalidDate', Factors: ['Thời điểm sự kiện không hợp lệ'], SkipReason: '' });
                    continue;
                }
                const effectiveCycleLength = Number(P.CycleLengthDays) || 0;
                const lastStartDay = parseDay(P.LastStartTime);
                if (!(effectiveCycleLength > 0) || lastStartDay === null) {
                    replaceCheck(eventKey, { ...check, Status: 'Pending', Result: 'Pending', DiceRoll: 0, PendingReason: 'MissingCycleData', Factors: ['Thiếu dữ liệu chu kỳ'], SkipReason: '' });
                    continue;
                }
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

const applyPrivateUpdate = async (messageId, sourceData, options) => {
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
    await Mvu.replaceMvuData(nextData, { type: 'message', message_id: messageId });
    return true;
};

const enqueue = (runtime, task) => {
    runtime.queue = runtime.queue.then(task, task).catch(error => console.error('[DestinyPoetry] Private automation error:', error));
    return runtime.queue;
};
const physioTick = runtime => enqueue(runtime, async () => {
    const scope = await findLatestMvuScope(runtime);
    if (!scope) return false;
    const applied = await applyPrivateUpdate(scope.messageId, scope.data, { resolveConception: true });
    if (applied) runtime.needsReconciliation = false;
    return applied;
});
const syncAfterMvuUpdate = (runtime, variables) => {
    return enqueue(runtime, async () => {
        let lastMatchCount = 0;
        let checkedIds = [];
        for (const delayMs of CONCEPTION_SCOPE_RETRY_DELAYS_MS) {
            await waitForRetry(delayMs);
            const result = await findUpdatedMvuScope(runtime, variables);
            lastMatchCount = result.matchCount;
            checkedIds = result.checkedIds;
            if (!result.scope) continue;
            const applied = await applyPrivateUpdate(result.scope.messageId, result.scope.data, { resolveConception: true });
            if (applied) runtime.needsReconciliation = false;
            return;
        }
        runtime.needsReconciliation = true;
        console.warn(`[DestinyPoetry] Post-MVU private sync deferred: chưa tìm thấy đúng tầng sau khi chờ lưu chat; matches=${lastMatchCount}, checked=[${checkedIds.join(',')}].`);
    });
};
const stopSubscription = subscription => {
    if (typeof subscription === 'function') subscription();
    else if (typeof subscription?.stop === 'function') subscription.stop();
};

const initPrivateAutomation = async () => {
    await waitGlobalInitialized('Mvu');
    const previous = window[PRIVATE_RUNTIME_KEY];
    if (previous?.destroy) previous.destroy();
    const runtime = { queue: Promise.resolve(), lastAssistantMessageId: null, needsReconciliation: true, subscriptions: [] };
    runtime.destroy = () => runtime.subscriptions.splice(0).forEach(stopSubscription);
    window[PRIVATE_RUNTIME_KEY] = runtime;
    runtime.subscriptions.push(eventOn(tavern_events.MESSAGE_RECEIVED, messageId => {
        if (Number.isInteger(Number(messageId))) runtime.lastAssistantMessageId = Number(messageId);
    }));
    runtime.subscriptions.push(eventOn(tavern_events.MESSAGE_UPDATED, messageId => {
        if (Number.isInteger(Number(messageId))) runtime.lastAssistantMessageId = Number(messageId);
        if (runtime.needsReconciliation) physioTick(runtime);
    }));
    runtime.subscriptions.push(eventOn(tavern_events.GENERATION_AFTER_COMMANDS, () => physioTick(runtime)));
    runtime.subscriptions.push(eventOn(Mvu.events.VARIABLE_INITIALIZED, () => physioTick(runtime)));
    runtime.subscriptions.push(eventOn(Mvu.events.COMMAND_PARSED, (variables, commands) => normalizePrivatePositionCommands(variables, commands)));
    runtime.subscriptions.push(eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, variables => syncAfterMvuUpdate(runtime, variables)));
    console.log('[DestinyPoetry] Private automation đã tải');
    eventEmit('[DestinyPoetry] Private automation đã tải');
    physioTick(runtime);
};

$(() => {
    initPrivateAutomation().catch(error => console.error('[DestinyPoetry] Private automation init error:', error));
});
