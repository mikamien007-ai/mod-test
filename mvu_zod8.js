import { registerMvuSchema as registerSchema } from 'https://testingcf.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js';

const zod = z;
const clampNumber = (fallback, min, max) => zod.coerce.number().prefault(fallback).transform(value => _.clamp(value, min, max));
const keepFirstEntries = (value, limit) => _.fromPairs(_.take(_.toPairs(value), limit));

const questSchema = zod.object({
    Status: zod.string().prefault(''),
    Priority: zod.enum(['Thấp', 'Trung Bình', 'Cao']).prefault('Trung Bình'),
    Progress: zod.string().prefault(''),
    Details: zod.string().prefault(''),
    Goal: zod.string().prefault(''),
    Reward: zod.string().prefault(''),
}).prefault({});

const itemBaseSchema = zod.object({
    Quality: zod.string().prefault(''),
    Type: zod.string().prefault(''),
    Tags: zod.array(zod.string()).prefault([]).transform(value => _.uniq(value)).optional(),
    Effect: zod.record(zod.string(), zod.string()).prefault({}),
    Description: zod.string().prefault(''),
});

const equipmentSchema = itemBaseSchema.extend({ Location: zod.string().prefault('') });
const skillSchema = itemBaseSchema.extend({ Cost: zod.string().prefault('') }).transform(value => _.pick(value, ['Quality', 'Type', 'Cost', 'Tags', 'Effect', 'Description']));
const statusEffectSchema = zod.object({
    Type: zod.enum(['Buff', 'Debuff', 'Special']).prefault('Buff'),
    Effect: zod.string().prefault(''),
    Stacks: zod.coerce.number().prefault(1),
    RemainingTime: zod.string().prefault(''),
    Source: zod.string().prefault(''),
}).prefault({});
const inventorySchema = itemBaseSchema.extend({ Quantity: zod.coerce.number().prefault(1) }).transform(value => _.pick(value, ['Quality', 'Type', 'Quantity', 'Tags', 'Effect', 'Description']));

const attributesSchema = zod.object(_.mapValues({ Strength: 0, Agility: 0, Constitution: 0, Intelligence: 0, Spirit: 0 }, () => zod.coerce.number().prefault(0))).prefault({});
const ascensionSchema = zod.object({
    IsEnabled: zod.boolean().prefault(false),
    Elements: zod.record(zod.string(), zod.record(zod.string(), zod.string())).prefault({}),
    Authorities: zod.record(zod.string(), zod.record(zod.string(), zod.string())).prefault({}),
    Laws: zod.record(zod.string(), zod.record(zod.string(), zod.string())).prefault({}),
    Godhood: zod.string().prefault(''),
    Divine_Kingdom: zod.object({ Name: zod.string().prefault(''), Description: zod.string().prefault('') }).prefault({}),
}).prefault({}).transform(value => {
    const lawCount = _.size(value.Laws);
    const authorityCount = _.size(value.Authorities);
    const limit = value.Divine_Kingdom?.Name ? Number.POSITIVE_INFINITY : value.Godhood ? 2 : 1;
    if (lawCount > 0) return { ...value, Elements: {}, Authorities: {}, Laws: keepFirstEntries(value.Laws, limit) };
    if (authorityCount > 0) return { ...value, Elements: {}, Authorities: keepFirstEntries(value.Authorities, 1), Laws: keepFirstEntries(value.Laws, limit) };
    return { ...value, Elements: keepFirstEntries(value.Elements, 3), Authorities: keepFirstEntries(value.Authorities, 1), Laws: {} };
});

const privateEligibilitySchema = zod.object({
    Gender: zod.enum(['female', 'male', 'other', 'unknown']).prefault('unknown'),
}).prefault({});
const privateBodySchema = zod.object({
    MouthLips: zod.string().prefault(''),
    Breasts: zod.string().prefault(''), Vagina: zod.string().prefault(''), Uterus: zod.string().prefault(''),
    Anus: zod.string().prefault(''), WaistHips: zod.string().prefault(''), Legs: zod.string().prefault(''),
}).prefault({});
const privatePhysiologySchema = zod.object({
    CycleLengthDays: zod.coerce.number().prefault(0).transform(value => Number.isFinite(value) && value > 0 ? Math.round(value) : 0),
    CurrentPhase: zod.string().prefault(''),
    CycleProgressPercent: clampNumber(0, 0, 100),
    LastStartTime: zod.string().prefault(''), ExpectedEndTime: zod.string().prefault(''),
    Symptoms: zod.array(zod.string()).prefault([]).transform(value => _.uniq(value)),
}).prefault({});
const conceptionCheckSchema = zod.object({
    Sequence: zod.coerce.number().prefault(1).transform(value => Math.max(1, Math.round(value))),
    OccurredAt: zod.string().prefault(''), PartnerCharacterKey: zod.string().prefault(''),
    ProtectionState: zod.enum(['None', 'Failed', 'Effective', 'Unknown']).prefault('Unknown'),
    Status: zod.enum(['Pending', 'Resolved', 'Skipped']).prefault('Pending'),
    ChancePercent: clampNumber(0, 0, 95), DiceRoll: clampNumber(0, 0, 100),
    Result: zod.enum(['Pending', 'Conceived', 'NotConceived', 'Skipped']).prefault('Pending'),
    PendingReason: zod.enum(['None', 'WaitingForOvulation', 'MissingCycleData', 'InvalidDate']).prefault('None'),
    ResolveAt: zod.string().prefault(''), SpermViableUntil: zod.string().prefault(''),
    Factors: zod.array(zod.string()).prefault([]).transform(value => _.uniq(value)),
    SkipReason: zod.string().prefault(''),
}).prefault({});
const privateReproductiveSchema = zod.object({
    Fertility: zod.string().prefault(''), OvulationStatus: zod.string().prefault(''),
    FertilizableEggCount: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))),
    FertilizationStatus: zod.string().prefault(''), FertilizationTime: zod.string().prefault(''),
    IsPregnant: zod.boolean().prefault(false), PregnancyProgressPercent: clampNumber(0, 0, 100),
    CurrentFetusCount: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))), GestationDays: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))),
    ConceptionRateModifierPercent: clampNumber(100, 0, 300),
    ConceptionChecks: zod.record(zod.string(), conceptionCheckSchema).prefault({}),
}).prefault({});
const derivePrivateReproductiveStatus = (physiology, reproductiveStatus) => {
    const reproductive = reproductiveStatus ?? {};
    const cycleLength = Math.max(0, Math.round(Number(physiology?.CycleLengthDays) || 0));
    let derived = reproductive;
    if (reproductive.IsPregnant) {
        derived = { ...reproductive, Fertility: 'Ngừng (mang thai)', OvulationStatus: 'Không rụng trứng', FertilizableEggCount: 0 };
    } else if (cycleLength > 0) {
        const isOvulating = physiology?.CurrentPhase === 'Rụng trứng';
        derived = { ...reproductive, Fertility: isOvulating ? 'Cao' : 'Bình thường', OvulationStatus: isOvulating ? 'Đang rụng trứng' : 'Không rụng trứng', FertilizableEggCount: isOvulating ? 1 : 0 };
    }
    return {
        ...derived,
        PregnancyProgressPercent: derived.IsPregnant ? derived.PregnancyProgressPercent : 0,
        CurrentFetusCount: derived.IsPregnant ? derived.CurrentFetusCount : 0,
    };
};
const positionCountSchema = zod.record(zod.string(), zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value)))).prefault({});
const childSchema = zod.object({
    Name: zod.string().prefault(''), FatherCharacterKey: zod.string().prefault(''),
    FatherDisplayName: zod.string().prefault('Không rõ'), BirthTime: zod.string().prefault(''), Notes: zod.string().prefault(''),
}).prefault({});
const secretNoteSchema = zod.object({ CreatedAt: zod.string().prefault(''), Text: zod.string().prefault(''), Source: zod.string().prefault('') }).prefault({});
const parentsSchema = zod.object({
    FatherName: zod.string().prefault(''),
    MotherName: zod.string().prefault(''),
}).prefault({});
const privateProfileSchema = zod.object({
    SchemaVersion: zod.literal(1).prefault(1),
    OutfitDetails: zod.object({
        Top: zod.string().prefault(''), Bottom: zod.string().prefault(''), Underwear: zod.string().prefault(''),
        ShoesSocks: zod.string().prefault(''), Jewelry: zod.string().prefault(''),
    }).prefault({}),
    Body: privateBodySchema, Physiology: privatePhysiologySchema,
    ReproductiveStatus: privateReproductiveSchema,
    SexualHistory: zod.object({
        ExperienceLevel: zod.string().prefault(''), PartnerCount: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))),
        FirstTime: zod.string().prefault(''), LastTime: zod.string().prefault(''),
        Fetishes: zod.array(zod.string()).prefault([]).transform(value => _.uniq(value)),
        PregnancyCount: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))), Positions: positionCountSchema,
    }).prefault({}),
    Children: zod.record(zod.string(), childSchema).prefault({}), SecretNotes: zod.record(zod.string(), secretNoteSchema).prefault({}),
}).prefault({}).transform(value => ({
    ...value,
    ReproductiveStatus: derivePrivateReproductiveStatus(value.Physiology, value.ReproductiveStatus),
}));

const isMissingPrivateHistoryValue = value => !String(value ?? '').trim() || /^(?:chưa có|chưa từng|chưa xảy ra|chưa xác định|không có|không rõ|không|unknown|none)$/i.test(String(value).trim());
const normalizePrivateSexualHistory = character => {
    const profile = character.PrivateProfile;
    if (!profile) return character;
    const history = profile.SexualHistory ?? {};
    const reproductive = profile.ReproductiveStatus ?? {};
    const relationshipText = String(character.RelationshipToPlayer ?? '');
    const evidenceText = [relationshipText, character.Background, ...(Array.isArray(character.Identity) ? character.Identity : [])].filter(Boolean).join(' | ');
    const hasChildren = _.size(profile.Children) > 0 || /(?:đã\s+(?:có|sinh)\s+con|có\s+con\s+rồi|mẹ\s+của\s+(?:\d+|một|hai|ba)\s+(?:đứa\s+)?con|has\s+children|mother\s+of\s+(?:one|two|three|\d+)\s+children?)/i.test(evidenceText);
    const isMarried = /(?:^|[\s/,(])(?:vợ|chồng|phu thê|phối ngẫu|wife|husband|spouse)(?:$|[\s/),])/i.test(relationshipText)
        || /(?:đã\s+(?:có\s+(?:chồng|vợ)|kết\s+hôn)|(?:là|trở\s+thành)\s+(?:vợ|chồng)|(?:vợ|chồng)\s+(?:của\s+)?(?:<user>|user)|married\s+to|wife\s+of|husband\s+of)/i.test(evidenceText);
    const hasManyExperience = /(?:nhiều|rất\s+nhiều)\s+kinh\s+nghiệm\s+(?:tình\s+dục|làm\s+tình|quan\s+hệ)|dày\s+dạn\s+(?:tình\s+trường|chuyện\s+chăn\s+gối|tình\s+dục)|(?:highly|very)\s+sexually\s+experienced|many\s+sexual\s+partners/i.test(evidenceText);
    const hasExplicitSex = /(?:đã\s+từng|đã)\s+(?:quan\s+hệ|làm\s+tình)|không\s+còn\s+trinh|mất\s+trinh|sexually\s+experienced|had\s+sex/i.test(evidenceText);
    const hasFertilization = reproductive.IsPregnant || Number(reproductive.CurrentFetusCount) > 0 || !isMissingPrivateHistoryValue(reproductive.FertilizationTime) || /(?:đã thụ tinh|đã thụ thai|fertili[sz]ed|conceived)/i.test(String(reproductive.FertilizationStatus ?? ''));
    const hasRecordedExperience = Number(history.PartnerCount) > 0 || Number(history.PregnancyCount) > 0 || !isMissingPrivateHistoryValue(history.FirstTime) || !isMissingPrivateHistoryValue(history.LastTime);
    if (!isMarried && !hasChildren && !hasManyExperience && !hasExplicitSex && !hasFertilization && !hasRecordedExperience) return character;
    const currentExperience = String(history.ExperienceLevel ?? '');
    const normalizedHistory = {
        ...history,
        ExperienceLevel: hasManyExperience && (!currentExperience || /(?:còn\s*)?trinh|virgin|đã\s+có\s+kinh\s+nghiệm/i.test(currentExperience))
            ? 'Nhiều kinh nghiệm'
            : (!currentExperience || /(?:còn\s*)?trinh|virgin/i.test(currentExperience) ? 'Đã có kinh nghiệm' : currentExperience),
        PartnerCount: Math.max(1, Number(history.PartnerCount) || 0),
        FirstTime: isMissingPrivateHistoryValue(history.FirstTime) ? 'Đã xảy ra, thời điểm chưa rõ' : history.FirstTime,
        LastTime: isMissingPrivateHistoryValue(history.LastTime) ? 'Đã xảy ra, thời điểm chưa rõ' : history.LastTime,
        PregnancyCount: hasChildren || reproductive.IsPregnant || Number(reproductive.CurrentFetusCount) > 0
            ? Math.max(1, Number(history.PregnancyCount) || 0)
            : Number(history.PregnancyCount) || 0,
    };
    return { ...character, PrivateProfile: { ...profile, SexualHistory: normalizedHistory } };
};

const characterCoreSchema = zod.object({
    Level: clampNumber(1, 1, 25), LifeTier: zod.string().prefault(''), Race: zod.string().prefault(''),
    Identity: zod.array(zod.string()).prefault([]).transform(value => _.uniq(value)), Class: zod.array(zod.string()).prefault([]).transform(value => _.uniq(value)),
    Attributes: attributesSchema, Equipment: zod.record(zod.string(), equipmentSchema).prefault({}), Skills: zod.record(zod.string(), skillSchema).prefault({}), AscensionStairway: ascensionSchema,
});
const protagonistSchema = zod.object({
    ...characterCoreSchema.shape, TotalExperience: zod.coerce.number().prefault(0), ExpRequired: zod.union([zod.coerce.number().prefault(120), zod.literal('MAX')]),
    AdventurerRank: zod.string().prefault('Chưa xếp hạng'), HP: zod.coerce.number().prefault(0), MaxHP: zod.coerce.number().prefault(0),
    MP: zod.coerce.number().prefault(0), MaxMP: zod.coerce.number().prefault(0), Stamina: zod.coerce.number().prefault(0), MaxStamina: zod.coerce.number().prefault(0),
    AttributePoints: zod.coerce.number().prefault(0), Inventory: zod.record(zod.string(), inventorySchema).prefault({}).transform(value => _.pickBy(value, item => item.Quantity > 0)),
    Money: zod.coerce.number().prefault(0).transform(Math.round), StatusEffect: zod.record(zod.string(), statusEffectSchema).prefault({}),
}).prefault({}).transform(value => {
    const normalized = { ...value, ExpRequired: value.Level >= 25 ? 'MAX' : value.ExpRequired, HP: _.clamp(value.HP, 0, value.MaxHP), MP: _.clamp(value.MP, 0, value.MaxMP), Stamina: _.clamp(value.Stamina, 0, value.MaxStamina) };
    return _.pick(normalized, ['Race', 'Identity', 'Class', 'LifeTier', 'Level', 'TotalExperience', 'ExpRequired', 'AdventurerRank', 'AttributePoints', 'Attributes', 'MaxHP', 'HP', 'MaxMP', 'MP', 'MaxStamina', 'Stamina', 'StatusEffect', 'Money', 'Inventory', 'Equipment', 'Skills', 'AscensionStairway']);
});
const relationshipSchema = zod.record(zod.string(), zod.object({
    ...characterCoreSchema.shape,
    IsPresent: zod.boolean().prefault(false),
    AgeYears: zod.coerce.number().prefault(0).transform(value => Number.isFinite(value) && value >= 0 ? value : 0),
    AgeSource: zod.string().prefault(''),
    Personality: zod.string().prefault(''), Likes: zod.string().prefault(''), Appearance: zod.string().prefault(''),
    Outfit: zod.string().prefault(''),
    PrivateEligibility: privateEligibilitySchema.optional(), PrivateProfile: privateProfileSchema.optional(), DestinyContract: zod.boolean().prefault(false), Affection: clampNumber(0, -100, 100),
    RelationshipToPlayer: zod.string().prefault(''),
    Parents: parentsSchema,
    StatusEffect: zod.record(zod.string(), statusEffectSchema).prefault({}), Inventory: zod.record(zod.string(), inventorySchema).prefault({}).transform(value => _.pickBy(value, item => item.Quantity > 0)),
    InnerThoughts: zod.string().prefault(''), Background: zod.string().prefault(''),
}).prefault({}).transform(value => normalizePrivateSexualHistory(_.pick(value, ['IsPresent', 'AgeYears', 'AgeSource', 'Race', 'Identity', 'Class', 'PrivateEligibility', 'PrivateProfile', 'Personality', 'Likes', 'Appearance', 'Outfit', 'RelationshipToPlayer', 'Parents', 'Level', 'Attributes', 'StatusEffect', 'Inventory', 'Equipment', 'Skills', 'AscensionStairway', 'DestinyContract', 'Affection', 'InnerThoughts', 'Background'])))).prefault({});
const newsSchema = zod.object({
    Astaria_Express: zod.object({ Faction_News: zod.string().prefault(''), Sovereign_Tracks: zod.string().prefault(''), Military_Operations: zod.string().prefault(''), Economic_Arteries: zod.string().prefault(''), Disaster_Warnings: zod.string().prefault('') }).prefault({}),
    Tavern_Message_Board: zod.object({ High_Rewards: zod.string().prefault(''), Adventure_Discoveries: zod.string().prefault(''), MonsterAbnormality: zod.string().prefault(''), WantedCriminal: zod.string().prefault(''), TreasureRumors: zod.string().prefault('') }).prefault({}),
    AfternoonTeaParty: zod.object({ SocialAnecdotes: zod.string().prefault(''), FarSight: zod.string().prefault(''), DestinyRipples: zod.string().prefault(''), EncounterOmen: zod.string().prefault('') }).prefault({}),
});
const rootSchema = zod.object({
    Event: zod.record(zod.any(), zod.any()).prefault({}), World: zod.object({ Time: zod.string().prefault(''), Location: zod.string().prefault('') }).prefault({}),
    QuestList: zod.record(zod.string(), questSchema).prefault({}), Protagonist: protagonistSchema.prefault({}), DestinyPoints: zod.coerce.number().prefault(0).transform(value => Math.max(Math.round(value), 0)), RelationshipList: relationshipSchema, News: newsSchema.prefault({}),
});

registerSchema(rootSchema);
