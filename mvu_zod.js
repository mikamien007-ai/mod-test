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
    IsNPC: zod.boolean().prefault(false),
    Gender: zod.enum(['female', 'male', 'other', 'unknown']).prefault('unknown'),
}).prefault({});
const privateBodySchema = zod.object({
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
const privateReproductiveSchema = zod.object({
    Fertility: zod.string().prefault(''), OvulationStatus: zod.string().prefault(''),
    FertilizableEggCount: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))),
    FertilizationStatus: zod.string().prefault(''), FertilizationTime: zod.string().prefault(''),
    IsPregnant: zod.boolean().prefault(false), PregnancyProgressPercent: clampNumber(0, 0, 100),
    CurrentFetusCount: zod.coerce.number().prefault(0).transform(value => Math.max(0, Math.round(value))),
}).prefault({});
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
    SchemaVersion: zod.literal(1).prefault(1), Body: privateBodySchema, Physiology: privatePhysiologySchema,
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
    ReproductiveStatus: {
        ...value.ReproductiveStatus,
        PregnancyProgressPercent: value.ReproductiveStatus.IsPregnant ? value.ReproductiveStatus.PregnancyProgressPercent : 0,
        CurrentFetusCount: value.ReproductiveStatus.IsPregnant ? value.ReproductiveStatus.CurrentFetusCount : 0,
    },
}));

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
    Personality: zod.string().prefault(''), Likes: zod.string().prefault(''), Appearance: zod.string().prefault(''), Outfit: zod.string().prefault(''),
    PrivateEligibility: privateEligibilitySchema.optional(), PrivateProfile: privateProfileSchema.optional(), DestinyContract: zod.boolean().prefault(false), Affection: clampNumber(0, -100, 100),
    RelationshipToPlayer: zod.string().prefault(''),
    Parents: parentsSchema,
    StatusEffect: zod.record(zod.string(), statusEffectSchema).prefault({}), Inventory: zod.record(zod.string(), inventorySchema).prefault({}).transform(value => _.pickBy(value, item => item.Quantity > 0)),
    InnerThoughts: zod.string().prefault(''), Background: zod.string().prefault(''),
}).prefault({}).transform(value => _.pick(value, ['IsPresent', 'AgeYears', 'AgeSource', 'Race', 'Identity', 'Class', 'PrivateEligibility', 'PrivateProfile', 'Personality', 'Likes', 'Appearance', 'Outfit', 'RelationshipToPlayer', 'Parents', 'Level', 'Attributes', 'StatusEffect', 'Inventory', 'Equipment', 'Skills', 'AscensionStairway', 'DestinyContract', 'Affection', 'InnerThoughts', 'Background']))).prefault({});
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
