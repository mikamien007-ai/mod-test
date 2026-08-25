/**
 * DestinyPoetry - Private Profile automation
 *
 * Tách nguyên vẹn từ automatedScript.js.
 * Runtime owner: Tavern Helper / SillyTavern.
 * Writer scope: RelationshipList.*.PrivateProfile và Date.PhysioTick.
 */

const y = (value, path, fallback) => _.get(value, path, fallback);
const C = handler => (...args) => {
    try {
        const result = handler(...args);
        return result instanceof Promise
            ? result.catch(error => {
                console.error(`[Private Automation Error] ${handler.name || "anonymous"}:`, error);
                throw error;
            })
            : result;
    } catch (error) {
        console.error(`[Private Automation Error] ${handler.name || "anonymous"}:`, error);
        throw error;
    }
};

const physioTick = () => {
    try {
        const lastMessageId = getLastMessageId();
        if (!Number.isInteger(lastMessageId) || lastMessageId < 1) return;
        const d = getVariables({ type: "message", message_id: -2 });
        const w = y(d, "World.Time", "") || y(d, "stat_data.World.Time", "") || "";
        if (!w) return;
        const sameWorldTime = w === y(d, "Date.PhysioTick", "");
        const wm = /Năm\s*(\d+)-Tháng\s*(\d+)-Ngày\s*(\d+)/.exec(w);
        if (!wm) return;
        const wd = Date.UTC(+wm[1], +wm[2] - 1, +wm[3]) / 864e5,
            pd = s => { const m = /Năm\s*(\d+)-Tháng\s*(\d+)-Ngày\s*(\d+)/.exec(s || ""); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5 : null },
            fd = n => { const x = new Date(n * 864e5), p = v => String(v).padStart(2, "0"); return `Năm ${x.getUTCFullYear()}-Tháng ${p(x.getUTCMonth() + 1)}-Ngày ${p(x.getUTCDate())}` },
            RP = r => { const s = String(r || "").toLowerCase(), q = [["hồ ly", 30, 280, 14], ["tinh linh", 35, 300, 18], ["long", 42, 540, 20], ["thú nhân", 26, 200, 10], ["thiên sứ", 28, 300, 14], ["dực", 28, 300, 14], ["nữ thần", 28, 365, 16], ["thần", 28, 365, 16], ["người", 28, 280, 12], ["nhân tộc", 28, 280, 12]]; for (const x of q) if (s.includes(x[0])) return x; return null },
            PH = [[0, 15, "Kinh nguyệt"], [15, 45, "Nang trứng"], [45, 60, "Rụng trứng"], [60, 100, "Hoàng thể"]],
            PHASE = p => PH.find(x => p >= x[0] && p < x[1]) || PH[3];
        const CONCEPTION_BASE_CHANCE = { "Kinh nguyệt": 2, "Nang trứng": 8, "Rụng trứng": 30, "Hoàng thể": 5 },
            CONCEPTION_HISTORY_LIMIT = 10,
            conceptionCleanupPaths = [];
        const rl = y(d, "RelationshipList", null) || y(d, "stat_data.RelationshipList", null) || {};
        const out = {};
        let dirty = !1;
        _.forEach(rl, (n, k) => {
            const pe = n?.PrivateEligibility;
            if (!(pe && (pe.Gender === "female" || pe.Gender === "other"))) return;
            const pp = n?.PrivateProfile || {};
            const P = pp.Physiology || {}, R = pp.ReproductiveStatus || {}, age = Number(n.AgeYears) || 0;
            const q = RP(n.Race), cyc = P.CycleLengthDays > 0 ? P.CycleLengthDays : q ? q[1] : 28, ges = R.GestationDays > 0 ? R.GestationDays : q ? q[2] : 280,
                pub = q ? q[3] : 14,
                maturityEvidence = [n.Background, n.Appearance, ...(Array.isArray(n.Identity) ? n.Identity : [])].filter(Boolean).join(" | "),
                explicitlyPrepubertal = age > 0 && age < pub || /(?:ấu\s*nữ|bé\s*gái|trẻ\s*em|chưa\s*(?:dậy|qua\s*tuổi\s*dậy)\s*thì|prepubescent|prepubertal)/i.test(maturityEvidence),
                needsPhysiologyRepair = !R.IsPregnant && !explicitlyPrepubertal && (!(P.CycleLengthDays > 0) || !P.CurrentPhase || pd(P.LastStartTime) === null || pd(P.ExpectedEndTime) === null);
            const upd = out[k] || (out[k] = { PrivateProfile: {} }), O = upd.PrivateProfile;
            const setP = (key, val) => { O.Physiology = O.Physiology || {}; O.Physiology[key] = val; dirty = !0 },
                setR = (key, val) => { O.ReproductiveStatus = O.ReproductiveStatus || {}; O.ReproductiveStatus[key] = val; dirty = !0 },
                setH = (key, val) => { O.SexualHistory = O.SexualHistory || {}; O.SexualHistory[key] = val; dirty = !0 },
                syncR = (phase = P.CurrentPhase, hasCycle = P.CycleLengthDays > 0) => {
                    const ov = !R.IsPregnant && hasCycle && phase === "Rụng trứng";
                    const fertility = R.IsPregnant ? "Ngừng (mang thai)" : hasCycle ? ov ? "Cao" : "Bình thường" : R.Fertility;
                    const ovulation = R.IsPregnant ? "Không rụng trứng" : hasCycle ? ov ? "Đang rụng trứng" : "Không rụng trứng" : R.OvulationStatus;
                    const eggs = (R.IsPregnant || hasCycle) ? (ov ? 1 : 0) : Number(R.FertilizableEggCount) || 0;
                    if (R.Fertility !== fertility) setR("Fertility", fertility);
                    if (R.OvulationStatus !== ovulation) setR("OvulationStatus", ovulation);
                    if (Number(R.FertilizableEggCount) !== eggs) setR("FertilizableEggCount", eggs);
                },
                resolveConceptionChecks = () => {
                    const effectiveR = { ...R, ...(O.ReproductiveStatus || {}) },
                        checks = effectiveR.ConceptionChecks || {},
                        nextChecks = { ...checks },
                        pending = _.sortBy(_.toPairs(checks).filter(([, check]) => (check?.Status || "Pending") === "Pending" && (check?.Result || "Pending") === "Pending" && (Number(check?.DiceRoll) || 0) === 0), ([, check]) => Number(check?.Sequence) || Number.MAX_SAFE_INTEGER),
                        effectivePhase = O.Physiology?.CurrentPhase ?? P.CurrentPhase,
                        effectiveCycleLength = Number(O.Physiology?.CycleLengthDays ?? P.CycleLengthDays) || 0,
                        rawModifier = Number(effectiveR.ConceptionRateModifierPercent ?? 100),
                        modifier = Number.isFinite(rawModifier) ? _.clamp(Math.round(rawModifier), 0, 300) : 100;
                    let pregnant = Boolean(effectiveR.IsPregnant), checksChanged = !1;
                    for (const [eventKey, sourceCheck] of pending) {
                        const check = { ...sourceCheck }, protection = check.ProtectionState || "Unknown";
                        if (pregnant) {
                            nextChecks[eventKey] = { ...check, Status: "Skipped", ChancePercent: 0, DiceRoll: 0, Result: "Skipped", Factors: ["Đã mang thai"], SkipReason: "AlreadyPregnant" };
                            checksChanged = !0;
                            continue;
                        }
                        if (protection === "Effective") {
                            nextChecks[eventKey] = { ...check, Status: "Skipped", ChancePercent: 0, DiceRoll: 0, Result: "Skipped", Factors: ["Biện pháp tránh thai có hiệu lực"], SkipReason: "EffectiveProtection" };
                            checksChanged = !0;
                            continue;
                        }
                        if (modifier === 0) {
                            nextChecks[eventKey] = { ...check, Status: "Skipped", ChancePercent: 0, DiceRoll: 0, Result: "Skipped", Factors: ["Không có khả năng thụ thai"], SkipReason: "NoConceptionCapability" };
                            checksChanged = !0;
                            continue;
                        }
                        const baseChance = CONCEPTION_BASE_CHANCE[effectivePhase];
                        if (!(effectiveCycleLength > 0) || !Number.isFinite(baseChance)) continue;
                        const chance = _.clamp(Math.round(baseChance * modifier / 100), 0, 95), roll = _.random(1, 100), conceived = roll <= chance;
                        nextChecks[eventKey] = {
                            ...check,
                            OccurredAt: check.OccurredAt || w,
                            Status: "Resolved",
                            ChancePercent: chance,
                            DiceRoll: roll,
                            Result: conceived ? "Conceived" : "NotConceived",
                            Factors: [`Giai đoạn: ${effectivePhase}`, `Xác suất gốc: ${baseChance}%`, `Hệ số sinh sản: ${modifier}%`, `Tránh thai: ${protection}`],
                            SkipReason: "",
                        };
                        checksChanged = !0;
                        if (!conceived) continue;
                        pregnant = !0;
                        const dateMatch = /Năm\s*(\d+)-Tháng\s*(\d+)-Ngày\s*(\d+)/.exec(check.OccurredAt || w),
                            conceptionDate = dateMatch ? `Năm ${Number(dateMatch[1])}-Tháng ${String(Number(dateMatch[2])).padStart(2, "0")}-Ngày ${String(Number(dateMatch[3])).padStart(2, "0")}` : fd(wd),
                            historyCount = Math.max(0, Math.round(Number(O.SexualHistory?.PregnancyCount ?? pp.SexualHistory?.PregnancyCount) || 0));
                        setR("FertilizationStatus", "Đã thụ thai");
                        setR("FertilizationTime", conceptionDate);
                        setR("IsPregnant", !0);
                        setR("PregnancyProgressPercent", 0);
                        setR("CurrentFetusCount", 1);
                        setR("Fertility", "Ngừng (mang thai)");
                        setR("OvulationStatus", "Không rụng trứng");
                        setR("FertilizableEggCount", 0);
                        if (!effectiveR.GestationDays) setR("GestationDays", ges);
                        setH("PregnancyCount", historyCount + 1);
                    }
                    const settled = _.sortBy(_.toPairs(nextChecks).filter(([, check]) => check?.Status === "Resolved" || check?.Status === "Skipped"), ([, check]) => Number(check?.Sequence) || 0),
                        obsolete = settled.slice(0, Math.max(0, settled.length - CONCEPTION_HISTORY_LIMIT));
                    for (const [eventKey] of obsolete) {
                        delete nextChecks[eventKey];
                        conceptionCleanupPaths.push(`RelationshipList.${k}.PrivateProfile.ReproductiveStatus.ConceptionChecks.${eventKey}`);
                        checksChanged = !0;
                    }
                    if (checksChanged) setR("ConceptionChecks", nextChecks);
                };
            if (sameWorldTime && !needsPhysiologyRepair) { syncR(); resolveConceptionChecks(); return; }
            if (!P.CycleLengthDays) {
                if (explicitlyPrepubertal) return;
                setP("CycleLengthDays", cyc);
                if (!R.GestationDays) setR("GestationDays", ges);
            }
            if (R.IsPregnant) {
                if (!R.GestationDays) setR("GestationDays", ges);
                syncR();
                const ft = pd(R.FertilizationTime);
                if (ft !== null && ft <= wd) {
                    const prog = Math.min(100, Math.round((wd - ft) / ges * 100));
                    if ((R.PregnancyProgressPercent || 0) !== prog) setR("PregnancyProgressPercent", prog);
                    if (prog >= 100 && (R.PregnancyProgressPercent || 0) < 100) {
                        const key = `auto_due_${k}`;
                        if (!pp.SecretNotes || !pp.SecretNotes[key]) { O.SecretNotes = O.SecretNotes || {}; O.SecretNotes[key] = { CreatedAt: w, Text: "Thai kỳ đã đủ ngày, chờ cốt truyện xử lý sinh nở.", Source: "Tự động" }; dirty = !0 }
                    }
                }
            } else {
                const ls = pd(P.LastStartTime);
                if (ls === null || ls > wd) {
                    setP("LastStartTime", fd(wd)), setP("ExpectedEndTime", fd(wd + cyc)), setP("CurrentPhase", "Kinh nguyệt"), setP("CycleProgressPercent", 0);
                    if (!R.GestationDays) setR("GestationDays", ges);
                    syncR("Kinh nguyệt", true);
                    resolveConceptionChecks();
                    return;
                }
                if (ls <= wd) {
                    let days = wd - ls;
                    const cycles = Math.floor(days / cyc);
                    if (cycles > 0) { days -= cycles * cyc, setP("LastStartTime", fd(ls + cycles * cyc)) }
                    const prog = Math.round(days / cyc * 100);
                    if ((P.CycleProgressPercent || 0) !== prog) setP("CycleProgressPercent", prog);
                    const ph = PHASE(prog);
                    if (P.CurrentPhase !== ph[2]) setP("CurrentPhase", ph[2]);
                    const ee = fd(ls + cycles * cyc + cyc);
                    if (P.ExpectedEndTime !== ee) setP("ExpectedEndTime", ee);
                    syncR(ph[2]);
                }
            }
            resolveConceptionChecks();
        });
        if (dirty) insertOrAssignVariables({ RelationshipList: out, Date: { PhysioTick: w } }, { type: "message", message_id: -2 });
        _.forEach(conceptionCleanupPaths, path => deleteVariable(path, { type: "message", message_id: -2 }));
    } catch (e) {
        console.warn("[DestinyPoetry] PhysioTick error:", e);
    }
};

const initPrivateAutomation = async () => {
    await waitGlobalInitialized("Mvu");
    eventOn(tavern_events.GENERATION_AFTER_COMMANDS, physioTick);
    console.log("[DestinyPoetry] Private automation đã tải");
    eventEmit("[DestinyPoetry] Private automation đã tải");
};

$(() => {
    C(initPrivateAutomation)();
});

